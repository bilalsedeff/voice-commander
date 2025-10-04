/**
 * Conversation Session Manager
 *
 * Manages voice conversation sessions with short-term memory.
 * Stores conversation turns and provides context for multi-turn interactions.
 */

import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

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
  private readonly MAX_CONTEXT_TURNS = 5; // Keep last 5 turns for context
  private readonly SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

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
   * Get conversation context (last N turns)
   */
  async getContext(sessionId: string, maxTurns: number = this.MAX_CONTEXT_TURNS): Promise<string> {
    try {
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

      // Format as conversation context
      const context = chronologicalTurns
        .map(turn =>
          `User: ${turn.userQuery}\nAssistant: ${turn.assistantResponse}`
        )
        .join('\n\n');

      return context;
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
