/**
 * Voice Command API Routes
 *
 * Endpoints for voice command processing, MCP tool discovery,
 * and risk-based confirmation workflows
 */

import { Router, Request, Response } from 'express';
import { VoiceOrchestrator } from '../orchestrator/voice-orchestrator';
import { llmMCPOrchestrator, OrchestrationResult } from '../services/llm-mcp-orchestrator';
import { mcpConnectionManagerV2 } from '../services/mcp-connection-manager-v2';
import { naturalResponseGenerator } from '../services/natural-response-generator';
import { authenticateToken } from '../middleware/auth';
import { PrismaClient } from '@prisma/client';
import { CommandExecutionResult, ChainedCommandResult } from '../mcp/types';
import logger from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();
const orchestrator = new VoiceOrchestrator();

/**
 * POST /api/voice
 * Process a voice command
 */
router.post('/', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { command } = req.body;
    const userId = req.user!.userId;

    if (!command || typeof command !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Voice command text is required'
      });
      return;
    }

    logger.info('Voice command received', { userId, command });

    // Get user's connected services
    const connections = await prisma.serviceConnection.findMany({
      where: { userId, connected: true },
      select: { provider: true }
    });

    const connectedServices = connections.map(conn => {
      // Map OAuth provider to service name
      if (conn.provider === 'google') return 'google_calendar';
      return conn.provider;
    });

    if (connectedServices.length === 0) {
      res.json({
        success: false,
        error: 'NO_SERVICES_CONNECTED',
        message: 'Please connect at least one service (Google Calendar, Slack, etc.) first.',
        data: {
          availableServices: ['google_calendar'],
          connectedServices: []
        }
      });
      return;
    }

    // Process the voice command
    const result = await orchestrator.processVoiceCommand(
      userId,
      command,
      connectedServices
    );

    // Check if it's a chained result or single result
    const isChained = 'totalCommands' in result;

    res.json({
      success: isChained ? result.successCount > 0 : result.success,
      type: isChained ? 'chained' : 'single',
      result,
      message: generateResponseMessage(result)
    });

  } catch (error) {
    logger.error('Voice command processing error', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });

    res.status(500).json({
      success: false,
      error: 'PROCESSING_ERROR',
      message: (error as Error).message
    });
  }
});

/**
 * POST /api/voice/confirm
 * Confirm a risky command execution
 */
router.post('/confirm', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { confirmationId, response } = req.body;
    const userId = req.user!.userId;

    if (!confirmationId || !response) {
      res.status(400).json({
        success: false,
        error: 'confirmationId and response are required'
      });
      return;
    }

    logger.info('Confirmation received', { userId, confirmationId, response });

    const result = await orchestrator.handleConfirmation(
      userId,
      confirmationId,
      response
    );

    res.json({
      success: result.success,
      result,
      message: generateResponseMessage(result)
    });

  } catch (error) {
    logger.error('Confirmation handling error', {
      error: (error as Error).message
    });

    res.status(500).json({
      success: false,
      error: 'CONFIRMATION_ERROR',
      message: (error as Error).message
    });
  }
});

/**
 * GET /api/voice/capabilities
 * Get available capabilities for connected services
 */
router.get('/capabilities', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;

    // Get user's connected services
    const connections = await prisma.serviceConnection.findMany({
      where: { userId, connected: true },
      select: { provider: true }
    });

    const connectedServices = connections.map(conn => {
      if (conn.provider === 'google') return 'google_calendar';
      return conn.provider;
    });

    const capabilities = await orchestrator.getServiceCapabilities(userId, connectedServices);

    res.json({
      success: true,
      connectedServices,
      capabilities
    });

  } catch (error) {
    logger.error('Capabilities fetch error', {
      error: (error as Error).message
    });

    res.status(500).json({
      success: false,
      error: 'CAPABILITIES_ERROR',
      message: (error as Error).message
    });
  }
});

/**
 * POST /api/voice/llm
 * Process voice command using LLM-driven MCP orchestration (NEW!)
 *
 * This endpoint uses GPT-4.1-nano to:
 * 1. Understand user intent
 * 2. Discover available MCP tools dynamically
 * 3. Select appropriate tools intelligently
 * 4. Build command execution chains
 * 5. Execute with real-time progress updates
 */
router.post('/llm', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { query, streaming } = req.body;
    const userId = req.user!.userId;

    if (!query || typeof query !== 'string') {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Query text is required'
      });
      return;
    }

    logger.info('LLM-driven voice command received', { userId, query, streaming });

    // Process query with LLM-MCP orchestrator
    const result = await llmMCPOrchestrator.processQuery(userId, query, {
      streaming,
      onProgress: streaming ? (update) => {
        // TODO: Send via SSE when streaming is implemented
        logger.debug('Progress update', update);
      } : undefined
    });

    // Return result
    res.json({
      ...result,
      message: result.needsClarification
        ? result.clarificationQuestion
        : result.success
          ? `✅ Executed ${result.results.filter(r => r.success).length} command(s) successfully`
          : '❌ Command execution failed'
    });

  } catch (error) {
    logger.error('LLM orchestration error', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });

    res.status(500).json({
      success: false,
      error: 'ORCHESTRATION_ERROR',
      message: (error as Error).message
    });
  }
});

/**
 * POST /api/voice/llm/stream
 * Process voice command with real-time SSE streaming
 *
 * This endpoint provides Server-Sent Events (SSE) for real-time progress updates:
 * 1. Analyzing query intent
 * 2. Discovering available MCP tools
 * 3. Selecting appropriate tools
 * 4. Executing commands with progress feedback
 * 5. Completion or error events
 *
 * SSE Events:
 * - progress: Real-time execution updates
 * - error: Error occurred during processing
 * - done: Final result and completion
 */
router.post('/llm/stream', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { query } = req.body;
    const userId = req.user!.userId;

    // Validate input
    if (!query || typeof query !== 'string') {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Query text is required'
      });
      return;
    }

    // Validate query length (max 500 characters as per security design)
    if (query.length > 500) {
      res.status(400).json({
        success: false,
        error: 'QUERY_TOO_LONG',
        message: 'Query must be less than 500 characters'
      });
      return;
    }

    logger.info('SSE streaming request started', { userId, query });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Helper function to send SSE message
    const sendSSE = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Track if connection is still open
    let connectionClosed = false;

    // Handle client disconnect
    req.on('close', () => {
      connectionClosed = true;
      logger.info('SSE client disconnected', { userId });
    });

    // Set maximum execution timeout (60 seconds)
    const timeoutId = setTimeout(() => {
      if (!connectionClosed) {
        sendSSE('error', {
          type: 'error',
          error: 'TIMEOUT',
          message: 'Request timed out after 60 seconds',
          timestamp: Date.now()
        });
        sendSSE('done', { success: false, error: 'TIMEOUT' });
        res.end();
      }
    }, 60000);

    try {
      // Process query with streaming callbacks
      const result = await llmMCPOrchestrator.processQuery(userId, query, {
        streaming: true,
        onProgress: (update) => {
          logger.debug('SSE: onProgress callback triggered', { update }); // DEBUG
          if (!connectionClosed) {
            // Transform backend format to frontend format
            const sseData = {
              step: update.type, // 'analyzing', 'discovering', etc.
              message: update.message,
              timestamp: new Date(update.timestamp).toISOString(),
              data: update.data
            };
            logger.debug('SSE: Sending progress event', { sseData }); // DEBUG
            sendSSE('progress', sseData);
          } else {
            logger.warn('SSE: Connection closed, skipping progress update');
          }
        }
      });

      // Clear timeout
      clearTimeout(timeoutId);

      // Send final result
      if (!connectionClosed) {
        sendSSE('done', {
          success: result.success,
          totalExecutionTime: result.totalExecutionTime,
          results: result.results,
          needsClarification: result.needsClarification,
          clarificationQuestion: result.clarificationQuestion
        });

        logger.info('SSE streaming completed', {
          userId,
          success: result.success,
          executionTime: result.totalExecutionTime
        });
      }

    } catch (error) {
      // Clear timeout
      clearTimeout(timeoutId);

      logger.error('SSE orchestration error', {
        userId,
        error: (error as Error).message,
        stack: (error as Error).stack
      });

      // Send error event
      if (!connectionClosed) {
        sendSSE('error', {
          type: 'error',
          error: 'ORCHESTRATION_ERROR',
          message: (error as Error).message,
          timestamp: Date.now()
        });

        sendSSE('done', {
          success: false,
          error: 'ORCHESTRATION_ERROR',
          message: (error as Error).message
        });
      }
    } finally {
      // Close connection
      if (!connectionClosed) {
        res.end();
      }
    }

  } catch (error) {
    logger.error('SSE endpoint error', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });

    // If headers not sent yet, send error response
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'SSE_ERROR',
        message: (error as Error).message
      });
    } else {
      // Headers already sent, close connection
      res.end();
    }
  }
});

/**
 * GET /api/voice/examples
 * Get example voice commands
 */
router.get('/examples', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;

    // Get connected services to show relevant examples
    const connections = await prisma.serviceConnection.findMany({
      where: { userId, connected: true },
      select: { provider: true }
    });

    const connectedServices = connections.map(conn => conn.provider);
    const examples: Record<string, string[]> = {};

    if (connectedServices.includes('google')) {
      examples.google_calendar = [
        'Schedule a meeting tomorrow at 3pm',
        'Show my calendar for next week',
        'Create an event called Team Standup on Monday at 10am',
        'List my upcoming meetings',
        'Schedule a meeting with john@example.com tomorrow at 2pm about Project Review'
      ];
    }

    // Chained command examples
    const chainedExamples = [
      'Schedule a meeting tomorrow at 3pm and then show my calendar',
      'List my events and then create a summary note',
    ];

    res.json({
      success: true,
      examples,
      chainedExamples,
      connectedServices
    });

  } catch (error) {
    logger.error('Examples fetch error', {
      error: (error as Error).message
    });

    res.status(500).json({
      success: false,
      error: 'EXAMPLES_ERROR',
      message: (error as Error).message
    });
  }
});

/**
 * Generate user-friendly response message
 */
function generateResponseMessage(result: CommandExecutionResult | ChainedCommandResult | OrchestrationResult): string {
  // Check if it's an orchestration result
  if ('results' in result && 'progressUpdates' in result) {
    const successCount = result.results.filter(r => r.success).length;
    const totalCount = result.results.length;
    if (result.needsClarification) {
      return result.clarificationQuestion || 'Please provide more information.';
    }
    return `Executed ${successCount} out of ${totalCount} commands successfully.`;
  }

  // Check if it's a chained result
  if ('totalCommands' in result) {
    const { totalCommands, successCount } = result;
    return `Executed ${successCount} out of ${totalCommands} commands successfully.`;
  }

  // Single command result (CommandExecutionResult)
  if (!result.success) {
    if ('error' in result && result.error === 'CONFIRMATION_REQUIRED') {
      return ('data' in result && result.data && typeof result.data === 'object' && 'message' in result.data)
        ? String(result.data.message)
        : 'This command requires confirmation.';
    }
    if ('error' in result && result.error === 'HIGH_RISK_CONFIRMATION_REQUIRED') {
      return ('data' in result && result.data && typeof result.data === 'object' && 'message' in result.data)
        ? String(result.data.message)
        : 'This high-risk command requires manual approval.';
    }
    return ('error' in result && result.error) ? result.error : 'Command execution failed.';
  }

  // Success message based on service (CommandExecutionResult only)
  if ('service' in result && 'action' in result && 'data' in result) {
    const { service, action, data } = result;

    if (service === 'google_calendar' && data && typeof data === 'object') {
      switch (action) {
        case 'create_event':
          const summary = 'summary' in data ? String(data.summary) : 'Event';
          const attendees = 'attendees' in data && typeof data.attendees === 'number' ? data.attendees : 0;
          return `✅ Event "${summary}" created successfully. ${attendees > 0 ? `Invited ${attendees} attendees.` : ''}`;

        case 'list_events':
          const count = 'count' in data && typeof data.count === 'number' ? data.count : 0;
          return `📅 Found ${count} upcoming events.`;

        case 'update_event':
          return `✅ Event updated successfully.`;

        case 'delete_event':
          return `✅ Event deleted successfully.`;
      }
    }
  }

  return '✅ Command executed successfully.';
}

/**
 * POST /api/voice/mcp-init
 * Initialize MCP connections for all OAuth-connected services
 * Auto-starts MCP servers for services where OAuth is authorized but MCP is not running
 */
router.post('/mcp-init', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;

    // Get OAuth-connected services
    const connections = await prisma.serviceConnection.findMany({
      where: {
        userId,
        connected: true // OAuth authorized
      }
    });

    const initResults = [];

    for (const connection of connections) {
      try {
        // Get MCP instance to check runtime status
        const mcpInstance = mcpConnectionManagerV2.getMCPInstance(userId, connection.provider);

        if (mcpInstance) {
          // MCP already running - refresh tool count from runtime
          logger.info('MCP already running, refreshing tool count', {
            userId,
            provider: connection.provider,
            dbToolsCount: connection.mcpToolsCount
          });

          // Get fresh tool count from MCP
          let tools: unknown[] = [];
          if (typeof (mcpInstance as any).discoverTools === 'function') {
            tools = await (mcpInstance as any).discoverTools();
          }

          const actualToolsCount = tools.length;

          // Update database if tool count is stale
          if (actualToolsCount !== connection.mcpToolsCount) {
            logger.warn('Database tool count is stale, updating', {
              userId,
              provider: connection.provider,
              dbToolsCount: connection.mcpToolsCount,
              actualToolsCount
            });

            await prisma.serviceConnection.update({
              where: {
                userId_provider: { userId, provider: connection.provider }
              },
              data: {
                mcpToolsCount: actualToolsCount,
                mcpConnected: true,
                mcpStatus: 'connected',
                mcpLastHealthCheck: new Date()
              }
            });
          }

          initResults.push({
            provider: connection.provider,
            status: 'refreshed',
            mcpConnected: true,
            toolsCount: actualToolsCount
          });
          continue;
        }

        // MCP not running - start it
        logger.info('Auto-starting MCP for OAuth-connected service', {
          userId,
          provider: connection.provider
        });

        const mcpResult = await mcpConnectionManagerV2.connectMCPServer(userId, connection.provider);

        initResults.push({
          provider: connection.provider,
          status: mcpResult.success ? 'connected' : 'failed',
          mcpConnected: mcpResult.success,
          toolsCount: mcpResult.toolsCount || 0,
          error: mcpResult.error
        });

        logger.info('MCP auto-start result', {
          userId,
          provider: connection.provider,
          success: mcpResult.success,
          toolsCount: mcpResult.toolsCount
        });

      } catch (error) {
        logger.error('MCP auto-start failed', {
          userId,
          provider: connection.provider,
          error: (error as Error).message
        });

        initResults.push({
          provider: connection.provider,
          status: 'error',
          mcpConnected: false,
          toolsCount: 0,
          error: (error as Error).message
        });
      }
    }

    res.json({
      success: true,
      initialized: initResults.length,
      results: initResults
    });

  } catch (error) {
    logger.error('MCP initialization failed', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });

    res.status(500).json({
      success: false,
      error: 'MCP_INIT_ERROR',
      message: (error as Error).message
    });
  }
});

/**
 * GET /api/voice/mcp-status
 * Get user's MCP server connection status
 */
router.get('/mcp-status', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;

    // Get user's MCP configurations with server info
    const mcpConfigs = await prisma.userMCPConfig.findMany({
      where: { userId },
      include: {
        mcpServer: {
          select: {
            id: true,
            name: true,
            displayName: true,
            provider: true,
            category: true,
            iconUrl: true,
            authType: true
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });

    const mcpStatus = mcpConfigs.map(config => ({
      mcpServerId: config.mcpServerId,
      name: config.mcpServer.name,
      displayName: config.mcpServer.displayName,
      provider: config.mcpServer.provider,
      category: config.mcpServer.category,
      iconUrl: config.mcpServer.iconUrl,
      authType: config.mcpServer.authType,
      status: config.status,
      isRunning: config.processId !== null,
      toolsCount: Array.isArray(config.toolsDiscovered) ? config.toolsDiscovered.length : 0,
      lastHealthCheck: config.lastHealthCheck,
      error: config.error,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt
    }));

    res.json({
      success: true,
      mcpServers: mcpStatus,
      totalCount: mcpStatus.length,
      connectedCount: mcpStatus.filter(m => m.status === 'connected').length
    });

  } catch (error) {
    logger.error('MCP status fetch error', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });

    res.status(500).json({
      success: false,
      error: 'MCP_STATUS_ERROR',
      message: (error as Error).message
    });
  }
});

/**
 * POST /api/voice/generate-response
 * Generate natural conversational TTS response from tool results
 */
router.post('/generate-response', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { query, toolResults, conversationContext, keepShort, askFollowUp } = req.body;
    const userId = req.user!.userId;

    // Validation
    if (!query || typeof query !== 'string') {
      res.status(400).json({
        success: false,
        error: 'INVALID_QUERY',
        message: 'Query is required and must be a string'
      });
      return;
    }

    if (!toolResults || !Array.isArray(toolResults)) {
      res.status(400).json({
        success: false,
        error: 'INVALID_TOOL_RESULTS',
        message: 'toolResults must be an array'
      });
      return;
    }

    logger.info('Generating natural TTS response', {
      userId,
      query,
      resultCount: toolResults.length,
      hasContext: !!conversationContext
    });

    // Generate natural response
    const spokenResponse = await naturalResponseGenerator.generateTTSResponse(
      query,
      toolResults,
      {
        conversationContext,
        keepShort: keepShort === true,
        askFollowUp: askFollowUp !== false // Default true
      }
    );

    logger.info('Natural TTS response created', {
      userId,
      responseLength: spokenResponse.length
    });

    res.json({
      success: true,
      spokenResponse,
      metadata: {
        query,
        resultCount: toolResults.length
      }
    });

  } catch (error) {
    logger.error('Failed to generate natural response', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });

    res.status(500).json({
      success: false,
      error: 'RESPONSE_GENERATION_ERROR',
      message: (error as Error).message
    });
  }
});

export default router;
