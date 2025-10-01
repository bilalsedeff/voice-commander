/**
 * Conversation Manager
 *
 * Manages voice conversation sessions with short-term memory:
 * - Creates and maintains voice sessions
 * - Tracks conversation context (last 10 interactions)
 * - Stores command history
 * - Provides context for LLM clarification
 */

import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

export interface ConversationContext {
  sessionId: string;
  recentCommands: Array<{
    transcript: string;
    intent?: string;
    success: boolean;
    timestamp: Date;
  }>;
  contextSummary?: string;
}

export class ConversationManager {
  private readonly MAX_CONTEXT_COMMANDS = 10;
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Get or create active voice session for user
   */
  async getOrCreateSession(userId: string): Promise<string> {
    try {
      // Find active session
      let session = await prisma.voiceSession.findFirst({
        where: {
          userId,
          isActive: true,
          lastActivity: {
            gte: new Date(Date.now() - this.SESSION_TIMEOUT_MS)
          }
        }
      });

      if (!session) {
        // Create new session
        session = await prisma.voiceSession.create({
          data: {
            userId,
            isActive: true
          }
        });

        logger.info('New voice session created', {
          userId,
          sessionId: session.id
        });
      } else {
        // Update last activity
        await prisma.voiceSession.update({
          where: { id: session.id },
          data: { lastActivity: new Date() }
        });
      }

      return session.id;
    } catch (error) {
      logger.error('Failed to get/create session', {
        userId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Get conversation context for LLM
   */
  async getContext(sessionId: string): Promise<ConversationContext> {
    try {
      const session = await prisma.voiceSession.findUnique({
        where: { id: sessionId },
        include: {
          commands: {
            orderBy: { createdAt: 'desc' },
            take: this.MAX_CONTEXT_COMMANDS,
            select: {
              transcript: true,
              intent: true,
              success: true,
              createdAt: true
            }
          }
        }
      });

      if (!session) {
        throw new Error('Session not found');
      }

      const recentCommands = session.commands.map(cmd => ({
        transcript: cmd.transcript,
        intent: cmd.intent || undefined,
        success: cmd.success,
        timestamp: cmd.createdAt
      }));

      return {
        sessionId: session.id,
        recentCommands,
        contextSummary: session.contextSummary || undefined
      };
    } catch (error) {
      logger.error('Failed to get conversation context', {
        sessionId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Store command in session history
   */
  async storeCommand(
    sessionId: string,
    transcript: string,
    intent?: string,
    mcpTool?: string,
    mcpParams?: Record<string, unknown>,
    mcpResult?: unknown,
    options?: {
      confidence: number;
      riskLevel: string;
      success: boolean;
      latency: number;
      error?: string;
      requiresClarification?: boolean;
      clarificationQuestion?: string;
      parentCommandId?: string;
    }
  ): Promise<string> {
    try {
      const session = await prisma.voiceSession.findUnique({
        where: { id: sessionId }
      });

      if (!session) {
        throw new Error('Session not found');
      }

      const command = await prisma.voiceCommand.create({
        data: {
          userId: session.userId,
          sessionId,
          transcript,
          intent,
          mcpTool,
          mcpParams: mcpParams as any,
          mcpResult: mcpResult as any,
          confidence: options?.confidence || 1.0,
          riskLevel: options?.riskLevel || 'safe',
          success: options?.success !== undefined ? options.success : true,
          latency: options?.latency || 0,
          error: options?.error,
          requiresClarification: options?.requiresClarification || false,
          clarificationQuestion: options?.clarificationQuestion,
          parentCommandId: options?.parentCommandId
        }
      });

      // Update session stats
      await prisma.voiceSession.update({
        where: { id: sessionId },
        data: {
          commandCount: { increment: 1 },
          successCount: options?.success ? { increment: 1 } : undefined,
          lastActivity: new Date()
        }
      });

      logger.info('Command stored in conversation history', {
        sessionId,
        commandId: command.id,
        success: options?.success
      });

      return command.id;
    } catch (error) {
      logger.error('Failed to store command', {
        sessionId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Update conversation context summary (generated by LLM)
   */
  async updateContextSummary(sessionId: string, summary: string): Promise<void> {
    try {
      await prisma.voiceSession.update({
        where: { id: sessionId },
        data: { contextSummary: summary }
      });

      logger.debug('Context summary updated', { sessionId });
    } catch (error) {
      logger.error('Failed to update context summary', {
        sessionId,
        error: (error as Error).message
      });
    }
  }

  /**
   * End voice session
   */
  async endSession(sessionId: string): Promise<void> {
    try {
      await prisma.voiceSession.update({
        where: { id: sessionId },
        data: {
          isActive: false,
          endedAt: new Date()
        }
      });

      logger.info('Voice session ended', { sessionId });
    } catch (error) {
      logger.error('Failed to end session', {
        sessionId,
        error: (error as Error).message
      });
    }
  }

  /**
   * Cleanup inactive sessions (background task)
   */
  async cleanupInactiveSessions(): Promise<void> {
    try {
      const cutoffTime = new Date(Date.now() - this.SESSION_TIMEOUT_MS);

      const result = await prisma.voiceSession.updateMany({
        where: {
          isActive: true,
          lastActivity: {
            lt: cutoffTime
          }
        },
        data: {
          isActive: false,
          endedAt: new Date()
        }
      });

      logger.info('Inactive sessions cleaned up', { count: result.count });
    } catch (error) {
      logger.error('Failed to cleanup sessions', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Get session statistics
   */
  async getSessionStats(sessionId: string) {
    try {
      const session = await prisma.voiceSession.findUnique({
        where: { id: sessionId },
        include: {
          _count: {
            select: { commands: true }
          }
        }
      });

      if (!session) {
        throw new Error('Session not found');
      }

      return {
        totalCommands: session.commandCount,
        successfulCommands: session.successCount,
        successRate: session.commandCount > 0
          ? (session.successCount / session.commandCount) * 100
          : 0,
        duration: session.endedAt
          ? session.endedAt.getTime() - session.startedAt.getTime()
          : Date.now() - session.startedAt.getTime(),
        isActive: session.isActive
      };
    } catch (error) {
      logger.error('Failed to get session stats', {
        sessionId,
        error: (error as Error).message
      });
      throw error;
    }
  }
}

// Singleton instance
export const conversationManager = new ConversationManager();

// Background cleanup task (run every 10 minutes)
setInterval(() => {
  conversationManager.cleanupInactiveSessions().catch(err => {
    logger.error('Session cleanup task failed', { error: err.message });
  });
}, 10 * 60 * 1000);
