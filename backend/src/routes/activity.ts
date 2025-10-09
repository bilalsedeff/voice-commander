/**
 * Activity History API Routes
 *
 * Provides transparent activity logs showing all user interactions,
 * voice commands, and tool executions for trust and transparency.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();

interface ActivityItem {
  id: string;
  timestamp: Date;
  type: 'session' | 'command' | 'oauth_connect' | 'oauth_disconnect';
  title: string;
  description: string;
  details?: Record<string, unknown>;
  success?: boolean;
  service?: string;
}

/**
 * GET /api/activity
 * Get user's activity history with pagination
 */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Pagination parameters
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // Date range filters
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    // Fetch voice sessions with their commands
    const sessions = await prisma.voiceSession.findMany({
      where: {
        userId,
        ...(startDate && { startedAt: { gte: startDate } }),
        ...(endDate && { startedAt: { lte: endDate } })
      },
      include: {
        commands: {
          orderBy: {
            createdAt: 'desc'
          }
        },
        conversationTurns: {
          orderBy: {
            turnNumber: 'desc'
          }
        }
      },
      orderBy: {
        startedAt: 'desc'
      },
      skip,
      take: limit
    });

    // Get total count for pagination
    const totalCount = await prisma.voiceSession.count({
      where: {
        userId,
        ...(startDate && { startedAt: { gte: startDate } }),
        ...(endDate && { startedAt: { lte: endDate } })
      }
    });

    // Transform sessions into activity items
    const activities: ActivityItem[] = [];

    for (const session of sessions) {
      // Add session start activity
      activities.push({
        id: session.id,
        timestamp: session.startedAt,
        type: 'session',
        title: 'Voice Session Started',
        description: `${session.mode === 'continuous' ? 'Continuous' : 'Push-to-talk'} mode`,
        details: {
          mode: session.mode,
          status: session.status,
          commandCount: session.commandCount,
          successCount: session.successCount,
          totalTurns: session.totalTurns
        },
        success: session.status === 'completed'
      });

      // Add conversation turns as activities
      for (const turn of session.conversationTurns) {
        activities.push({
          id: turn.id,
          timestamp: turn.createdAt,
          type: 'command',
          title: turn.userQuery,
          description: turn.assistantResponse,
          details: {
            intent: turn.userIntent,
            toolResults: turn.toolResults,
            durationMs: turn.durationMs,
            ttsSpoken: turn.ttsSpoken
          },
          success: true
        });
      }

      // Add individual voice commands as activities (if not already in conversationTurns)
      for (const command of session.commands) {
        // Skip if already covered by conversation turn
        const alreadyIncluded = session.conversationTurns.some(
          turn => turn.userQuery === command.transcript
        );

        if (!alreadyIncluded) {
          activities.push({
            id: command.id,
            timestamp: command.createdAt,
            type: 'command',
            title: command.transcript,
            description: command.intent || 'Voice command executed',
            details: {
              mcpTool: command.mcpTool,
              mcpParams: command.mcpParams,
              mcpResult: command.mcpResult,
              confidence: command.confidence,
              riskLevel: command.riskLevel,
              latency: command.latency,
              error: command.error
            },
            success: command.success,
            service: command.mcpTool ? inferServiceFromTool(command.mcpTool) : undefined
          });
        }
      }

      // Add session end activity if ended
      if (session.endedAt) {
        activities.push({
          id: `${session.id}-end`,
          timestamp: session.endedAt,
          type: 'session',
          title: 'Voice Session Ended',
          description: `Session ${session.status}`,
          details: {
            duration: session.endedAt.getTime() - session.startedAt.getTime(),
            commandCount: session.commandCount,
            successRate: session.commandCount > 0
              ? (session.successCount / session.commandCount * 100).toFixed(1) + '%'
              : 'N/A'
          },
          success: session.status === 'completed'
        });
      }
    }

    // Sort all activities by timestamp (newest first)
    activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Get OAuth connection history (recent connects/disconnects)
    const recentOAuthChanges = await prisma.serviceConnection.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 10
    });

    // Add OAuth activities
    for (const conn of recentOAuthChanges) {
      // Only add if it's a recent change (within our date range)
      const changeDate = conn.updatedAt;
      if (startDate && changeDate < startDate) continue;
      if (endDate && changeDate > endDate) continue;

      activities.push({
        id: conn.id,
        timestamp: changeDate,
        type: conn.connected ? 'oauth_connect' : 'oauth_disconnect',
        title: conn.connected ? `Connected ${conn.provider}` : `Disconnected ${conn.provider}`,
        description: `OAuth ${conn.connected ? 'authorized' : 'revoked'} for ${conn.provider}`,
        details: {
          provider: conn.provider,
          mcpConnected: conn.mcpConnected,
          mcpStatus: conn.mcpStatus,
          mcpToolsCount: conn.mcpToolsCount
        },
        success: true,
        service: conn.provider
      });
    }

    // Sort again after adding OAuth activities
    activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    logger.info('Activity history fetched', {
      userId,
      page,
      limit,
      totalCount,
      activitiesReturned: activities.length
    });

    return res.json({
      success: true,
      activities,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount
      }
    });

  } catch (error) {
    logger.error('Failed to fetch activity history', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch activity history'
    });
  }
});

/**
 * GET /api/activity/stats
 * Get activity statistics for dashboard overview
 */
router.get('/stats', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Get stats for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalSessions,
      totalCommands,
      successfulCommands,
      connectedServices
    ] = await Promise.all([
      prisma.voiceSession.count({
        where: {
          userId,
          startedAt: { gte: thirtyDaysAgo }
        }
      }),
      prisma.voiceCommand.count({
        where: {
          userId,
          createdAt: { gte: thirtyDaysAgo }
        }
      }),
      prisma.voiceCommand.count({
        where: {
          userId,
          success: true,
          createdAt: { gte: thirtyDaysAgo }
        }
      }),
      prisma.serviceConnection.count({
        where: {
          userId,
          connected: true
        }
      })
    ]);

    const successRate = totalCommands > 0
      ? ((successfulCommands / totalCommands) * 100).toFixed(1)
      : '0';

    return res.json({
      success: true,
      stats: {
        totalSessions,
        totalCommands,
        successfulCommands,
        successRate: `${successRate}%`,
        connectedServices,
        period: 'Last 30 days'
      }
    });

  } catch (error) {
    logger.error('Failed to fetch activity stats', {
      error: error instanceof Error ? error.message : String(error)
    });

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch activity stats'
    });
  }
});

/**
 * Helper function to infer service name from MCP tool name
 */
function inferServiceFromTool(toolName: string): string {
  const tool = toolName.toLowerCase();

  if (tool.includes('calendar') || tool.includes('event')) return 'Google Calendar';
  if (tool.includes('slack') || tool.includes('message')) return 'Slack';
  if (tool.includes('notion') || tool.includes('page')) return 'Notion';
  if (tool.includes('github') || tool.includes('repo')) return 'GitHub';
  if (tool.includes('contact')) return 'Google Contacts';

  return 'Unknown';
}

export default router;
