/**
 * Conversation Session Manager
 *
 * Manages voice conversation sessions with short-term memory.
 * Stores conversation turns and provides context for multi-turn interactions.
 */

import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';
import { llmService, LLMTaskType } from './llm-service';

const prisma = new PrismaClient();

export interface ConversationTurn {
  turnNumber: number;
  userQuery: string;
  userIntent?: string;
  assistantResponse: string;
  toolResults?: unknown;
  ttsSpoken?: boolean;
  durationMs?: number;
}

export interface VoiceSessionData {
  id: string;
  userId: string;
  mode: 'continuous' | 'push_to_talk';
  status: 'active' | 'completed' | 'timeout';
  startedAt: Date;
  lastActivity: Date;
  totalTurns: number;
  turns: ConversationTurn[];
}

export class ConversationSessionManager {
  private readonly MAX_CONTEXT_TURNS = 15; // Keep last 15 turns for context (30 messages total)
  private readonly SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  private readonly MAX_CONTEXT_TOKENS = 2500; // Trigger summarization above this
  private readonly RECENT_TURNS_TO_KEEP = 5; // Always keep last 5 turns intact

  /**
   * Estimate token count (simple heuristic: 1 token ≈ 4 characters)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Create new conversation session
   */
  async createSession(
    userId: string,
    mode: 'continuous' | 'push_to_talk' = 'continuous'
  ): Promise<VoiceSessionData> {
    try {
      const session = await prisma.voiceSession.create({
        data: {
          userId,
          mode,
          status: 'active',
          isActive: true,
          lastActivity: new Date(),
          totalTurns: 0
        }
      });

      logger.info('Voice session created', {
        sessionId: session.id,
        userId,
        mode
      });

      return {
        id: session.id,
        userId: session.userId,
        mode: session.mode as 'continuous' | 'push_to_talk',
        status: session.status as 'active' | 'completed' | 'timeout',
        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
        totalTurns: session.totalTurns,
        turns: []
      };
    } catch (error) {
      logger.error('Failed to create voice session', {
        userId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Add conversation turn to session
   */
  async addTurn(
    sessionId: string,
    turn: Omit<ConversationTurn, 'turnNumber'>
  ): Promise<ConversationTurn> {
    try {
      // Get current session
      const session = await prisma.voiceSession.findUnique({
        where: { id: sessionId },
        include: {
          conversationTurns: {
            orderBy: { turnNumber: 'desc' },
            take: 1
          }
        }
      });

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const turnNumber = (session.conversationTurns[0]?.turnNumber || 0) + 1;

      // Create turn
      const conversationTurn = await prisma.conversationTurn.create({
        data: {
          sessionId,
          turnNumber,
          userQuery: turn.userQuery,
          userIntent: turn.userIntent,
          assistantResponse: turn.assistantResponse,
          toolResults: turn.toolResults ? JSON.parse(JSON.stringify(turn.toolResults)) : null,
          ttsSpoken: turn.ttsSpoken || false,
          durationMs: turn.durationMs
        }
      });

      // Update session stats
      await prisma.voiceSession.update({
        where: { id: sessionId },
        data: {
          totalTurns: { increment: 1 },
          lastActivity: new Date()
        }
      });

      logger.debug('Conversation turn added', {
        sessionId,
        turnNumber,
        queryLength: turn.userQuery.length,
        responseLength: turn.assistantResponse.length
      });

      return {
        turnNumber: conversationTurn.turnNumber,
        userQuery: conversationTurn.userQuery,
        userIntent: conversationTurn.userIntent || undefined,
        assistantResponse: conversationTurn.assistantResponse,
        toolResults: conversationTurn.toolResults || undefined,
        ttsSpoken: conversationTurn.ttsSpoken,
        durationMs: conversationTurn.durationMs || undefined
      };
    } catch (error) {
      logger.error('Failed to add conversation turn', {
        sessionId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Get conversation context with smart summarization
   * Returns summary + recent turns if context is too long
   */
  async getContext(sessionId: string, maxTurns: number = this.MAX_CONTEXT_TURNS): Promise<string> {
    try {
      // Get session to check for existing summary
      const session = await prisma.voiceSession.findUnique({
        where: { id: sessionId },
        select: { contextSummary: true, lastSummarizedTurn: true }
      });

      // Get all recent turns
      const turns = await prisma.conversationTurn.findMany({
        where: { sessionId },
        orderBy: { turnNumber: 'desc' },
        take: maxTurns
      });

      if (turns.length === 0) {
        return '';
      }

      // Reverse to get chronological order
      const chronologicalTurns = turns.reverse();

      // Build full context
      const fullContext = chronologicalTurns
        .map(turn => `User: ${turn.userQuery}\nAssistant: ${turn.assistantResponse}`)
        .join('\n\n');

      // Estimate tokens
      const tokenCount = this.estimateTokens(fullContext);

      // If context is small enough, return as-is
      if (tokenCount <= this.MAX_CONTEXT_TOKENS) {
        logger.debug('Context within token limit', {
          sessionId,
          tokens: tokenCount,
          turnCount: chronologicalTurns.length,
          contextPreview: fullContext.substring(0, 200).replace(/\n/g, ' ')
        });
        return fullContext;
      }

      // Context too long - use summary + recent turns
      logger.info('Context exceeds token limit, using summary', {
        sessionId,
        tokens: tokenCount,
        limit: this.MAX_CONTEXT_TOKENS
      });

      // Get recent turns to keep
      const recentTurns = chronologicalTurns.slice(-this.RECENT_TURNS_TO_KEEP);
      const recentContext = recentTurns
        .map(turn => `User: ${turn.userQuery}\nAssistant: ${turn.assistantResponse}`)
        .join('\n\n');

      // Trigger async summarization if needed
      const oldestRecentTurn = recentTurns[0]?.turnNumber || 0;
      const needsSummarization = !session?.lastSummarizedTurn ||
                                 session.lastSummarizedTurn < oldestRecentTurn - 1;

      if (needsSummarization) {
        logger.debug('Triggering async summarization', { sessionId });
        // Don't await - let it run in background
        this.summarizeOldContext(sessionId, chronologicalTurns, oldestRecentTurn).catch(err => {
          logger.error('Background summarization failed', { sessionId, error: err.message });
        });
      }

      // Return cached summary + recent turns (or just recent if no summary yet)
      if (session?.contextSummary) {
        return `Previous conversation summary:\n${session.contextSummary}\n\nRecent conversation:\n${recentContext}`;
      }

      return recentContext;
    } catch (error) {
      logger.error('Failed to get conversation context', {
        sessionId,
        error: (error as Error).message
      });
      return '';
    }
  }

  /**
   * Get session with recent turns
   */
  async getSession(sessionId: string): Promise<VoiceSessionData | null> {
    try {
      const session = await prisma.voiceSession.findUnique({
        where: { id: sessionId },
        include: {
          conversationTurns: {
            orderBy: { turnNumber: 'asc' },
            take: this.MAX_CONTEXT_TURNS
          }
        }
      });

      if (!session) {
        return null;
      }

      return {
        id: session.id,
        userId: session.userId,
        mode: session.mode as 'continuous' | 'push_to_talk',
        status: session.status as 'active' | 'completed' | 'timeout',
        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
        totalTurns: session.totalTurns,
        turns: session.conversationTurns.map(t => ({
          turnNumber: t.turnNumber,
          userQuery: t.userQuery,
          userIntent: t.userIntent || undefined,
          assistantResponse: t.assistantResponse,
          toolResults: t.toolResults || undefined,
          ttsSpoken: t.ttsSpoken,
          durationMs: t.durationMs || undefined
        }))
      };
    } catch (error) {
      logger.error('Failed to get session', {
        sessionId,
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * End session
   */
  async endSession(
    sessionId: string,
    status: 'completed' | 'timeout' = 'completed'
  ): Promise<void> {
    try {
      await prisma.voiceSession.update({
        where: { id: sessionId },
        data: {
          status,
          isActive: false,
          endedAt: new Date()
        }
      });

      logger.info('Voice session ended', {
        sessionId,
        status
      });
    } catch (error) {
      logger.error('Failed to end session', {
        sessionId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Get active session for user
   */
  async getActiveSession(userId: string): Promise<VoiceSessionData | null> {
    try {
      const session = await prisma.voiceSession.findFirst({
        where: {
          userId,
          isActive: true,
          status: 'active'
        },
        include: {
          conversationTurns: {
            orderBy: { turnNumber: 'desc' },
            take: this.MAX_CONTEXT_TURNS
          }
        },
        orderBy: {
          lastActivity: 'desc'
        }
      });

      if (!session) {
        return null;
      }

      // Check if session timed out
      const now = Date.now();
      const lastActivity = session.lastActivity.getTime();

      if (now - lastActivity > this.SESSION_TIMEOUT_MS) {
        await this.endSession(session.id, 'timeout');
        return null;
      }

      return {
        id: session.id,
        userId: session.userId,
        mode: session.mode as 'continuous' | 'push_to_talk',
        status: session.status as 'active' | 'completed' | 'timeout',
        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
        totalTurns: session.totalTurns,
        turns: session.conversationTurns.reverse().map(t => ({
          turnNumber: t.turnNumber,
          userQuery: t.userQuery,
          userIntent: t.userIntent || undefined,
          assistantResponse: t.assistantResponse,
          toolResults: t.toolResults || undefined,
          ttsSpoken: t.ttsSpoken,
          durationMs: t.durationMs || undefined
        }))
      };
    } catch (error) {
      logger.error('Failed to get active session', {
        userId,
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Summarize old conversation turns (async background task)
   */
  private async summarizeOldContext(
    sessionId: string,
    allTurns: Array<{ turnNumber: number; userQuery: string; assistantResponse: string }>,
    oldestRecentTurn: number
  ): Promise<void> {
    try {
      // Get turns to summarize (all except recent ones)
      const turnsToSummarize = allTurns.filter(turn => turn.turnNumber < oldestRecentTurn);

      if (turnsToSummarize.length === 0) {
        logger.debug('No old turns to summarize', { sessionId });
        return;
      }

      // Format turns for summarization
      const conversationText = turnsToSummarize
        .map(turn => `User: ${turn.userQuery}\nAssistant: ${turn.assistantResponse}`)
        .join('\n\n');

      // Simple summarization prompt
      const systemPrompt = `You are a conversation summarizer. Create a concise summary of the conversation below.

Focus on:
- User's goals and intent
- Key decisions or actions taken
- Important context or constraints
- Specific details mentioned (names, dates, etc.)

Keep the summary under 300 tokens.`;

      logger.info('Summarizing old conversation turns', {
        sessionId,
        turnCount: turnsToSummarize.length,
        textLength: conversationText.length
      });

      // Call LLM for summarization
      const startTime = Date.now();
      const summary = await llmService.execute({
        systemPrompt,
        userPrompt: conversationText,
        taskType: LLMTaskType.FAST, // Use fast model (gpt-4.1-nano)
        requiresJSON: false
      });

      const duration = Date.now() - startTime;

      // Store summary in database
      await prisma.voiceSession.update({
        where: { id: sessionId },
        data: {
          contextSummary: summary.content.trim(),
          lastSummarizedTurn: turnsToSummarize[turnsToSummarize.length - 1].turnNumber
        }
      });

      logger.info('Conversation summary created', {
        sessionId,
        summaryLength: summary.content.length,
        summarizedTurns: turnsToSummarize.length,
        lastTurn: turnsToSummarize[turnsToSummarize.length - 1].turnNumber,
        duration
      });
    } catch (error) {
      logger.error('Failed to summarize conversation', {
        sessionId,
        error: (error as Error).message,
        stack: (error as Error).stack
      });
      // Don't throw - this is a background task
    }
  }

  /**
   * Cleanup old sessions (called periodically)
   */
  async cleanupOldSessions(): Promise<number> {
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
          status: 'timeout',
          isActive: false,
          endedAt: new Date()
        }
      });

      if (result.count > 0) {
        logger.info('Cleaned up old sessions', {
          count: result.count
        });
      }

      return result.count;
    } catch (error) {
      logger.error('Failed to cleanup old sessions', {
        error: (error as Error).message
      });
      return 0;
    }
  }
}

// Export singleton
export const conversationSessionManager = new ConversationSessionManager();
