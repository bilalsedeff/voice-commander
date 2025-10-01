/**
 * Command Mapper
 *
 * Maps natural language voice commands to MCP tool calls
 * Uses pattern matching + optional LLM fallback for complex commands
 */

import { VoiceCommand, RiskLevel } from '../mcp/types';
import { mcpConnectionManagerV2 } from '../services/mcp-connection-manager-v2';
import { RiskAssessor } from './risk-assessor';
import logger from '../utils/logger';

interface MappingPattern {
  regex: RegExp;
  service: string;
  action: string;
  paramExtractor: (match: RegExpMatchArray, fullText: string) => Record<string, unknown>;
}

export class CommandMapper {
  private riskAssessor: RiskAssessor;
  private patterns: MappingPattern[];

  constructor() {
    this.riskAssessor = new RiskAssessor();
    this.patterns = this.initializePatterns();
  }

  /**
   * Map voice text to structured command
   */
  async mapCommand(
    voiceText: string,
    connectedServices: string[]
  ): Promise<VoiceCommand> {
    logger.info('Mapping voice command', { voiceText, connectedServices });

    // Try pattern matching first
    for (const pattern of this.patterns) {
      const match = voiceText.match(pattern.regex);
      if (match && connectedServices.includes(pattern.service)) {
        const params = pattern.paramExtractor(match, voiceText);

        const command: VoiceCommand = {
          originalText: voiceText,
          intent: this.extractIntent(voiceText),
          service: pattern.service,
          action: pattern.action,
          params,
          riskAssessment: {
            level: RiskLevel.SAFE,
            reasons: [],
            requiresConfirmation: false,
            requiresManualApproval: false
          }
        };

        // Assess risk
        command.riskAssessment = this.riskAssessor.assessRisk(command);

        logger.info('Command mapped successfully', {
          service: command.service,
          action: command.action,
          riskLevel: command.riskAssessment.level
        });

        return command;
      }
    }

    // Fallback: Try LLM-based mapping (optional)
    throw new Error(
      `Could not understand command: "${voiceText}". Try rephrasing or use more specific keywords.`
    );
  }

  /**
   * Initialize command patterns
   */
  private initializePatterns(): MappingPattern[] {
    return [
      // ==================== GOOGLE CALENDAR ====================

      // Create event: "schedule a meeting about X at Y"
      {
        regex: /(?:schedule|create|add|set up)(?:\s+a)?\s+(?:meeting|event|appointment)(?:\s+about|\s+for|\s+titled)?\s+(.+?)(?:\s+(?:at|on|for|tomorrow|next|today))/i,
        service: 'google_calendar',
        action: 'create_event',
        paramExtractor: (match, fullText) => {
          const summary = match[1].trim();
          const timeMatch = fullText.match(/(?:at|on|for)\s+(.+?)(?:\s+with|\s+in|$)/i);
          const attendeesMatch = fullText.match(/(?:with|invite)\s+(.+?)(?:\s+at|$)/i);
          const locationMatch = fullText.match(/(?:at|in)\s+([^,]+)(?:,|$)/i);

          return {
            summary,
            startTime: timeMatch ? timeMatch[1].trim() : 'tomorrow at 10am',
            attendees: attendeesMatch ? attendeesMatch[1].trim() : undefined,
            location: locationMatch ? locationMatch[1].trim() : undefined
          };
        }
      },

      // Quick schedule: "meeting tomorrow at 3pm"
      {
        regex: /^(?:schedule|create|add)?\s*(?:a\s+)?(?:meeting|event)\s+(tomorrow|today|next\s+\w+)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
        service: 'google_calendar',
        action: 'create_event',
        paramExtractor: (match) => ({
          summary: 'Meeting',
          startTime: `${match[1]} at ${match[2]}`
        })
      },

      // List events: "show my calendar", "what's on my schedule"
      {
        regex: /(?:show|list|get|what'?s\s+on)\s+(?:my\s+)?(?:calendar|schedule|events|meetings)/i,
        service: 'google_calendar',
        action: 'list_events',
        paramExtractor: () => ({
          maxResults: '10'
        })
      },

      // List events with timeframe: "show my calendar for next week"
      {
        regex: /(?:show|list)\s+(?:my\s+)?(?:calendar|events)\s+(?:for|in)\s+(.+)/i,
        service: 'google_calendar',
        action: 'list_events',
        paramExtractor: (match) => ({
          timeMin: match[1].trim(),
          maxResults: '10'
        })
      },

      // Update event: "change my meeting to 4pm"
      {
        regex: /(?:change|move|update|reschedule)\s+(?:my\s+)?(?:meeting|event)(?:\s+to|\s+at)?\s+(.+)/i,
        service: 'google_calendar',
        action: 'update_event',
        paramExtractor: (match, fullText) => {
          const timeMatch = fullText.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
          return {
            // Note: We'll need to find the event ID first
            eventId: 'LATEST', // Special identifier
            startTime: timeMatch ? timeMatch[1] : match[1].trim()
          };
        }
      },

      // Cancel event: "cancel my meeting"
      {
        regex: /(?:cancel|delete|remove)\s+(?:my\s+)?(?:meeting|event|appointment)(?:\s+with\s+(.+))?/i,
        service: 'google_calendar',
        action: 'delete_event',
        paramExtractor: (match) => ({
          eventId: 'LATEST', // Will need to be resolved
          attendeeHint: match[1] ? match[1].trim() : undefined
        })
      },

      // ==================== GENERIC PATTERNS ====================

      // Generic create
      {
        regex: /(?:create|make|add|new)\s+(.+)/i,
        service: 'unknown',
        action: 'create',
        paramExtractor: (match) => ({
          what: match[1].trim()
        })
      },

      // Generic list
      {
        regex: /(?:show|list|get|display)\s+(.+)/i,
        service: 'unknown',
        action: 'list',
        paramExtractor: (match) => ({
          what: match[1].trim()
        })
      }
    ];
  }

  /**
   * Extract high-level intent from voice text
   */
  private extractIntent(voiceText: string): string {
    const text = voiceText.toLowerCase();

    if (text.match(/(?:schedule|create|add).*(?:meeting|event)/)) {
      return 'schedule_event';
    }
    if (text.match(/(?:show|list|get).*(?:calendar|events|meetings)/)) {
      return 'view_calendar';
    }
    if (text.match(/(?:change|update|move|reschedule)/)) {
      return 'modify_event';
    }
    if (text.match(/(?:cancel|delete|remove)/)) {
      return 'cancel_event';
    }
    if (text.match(/(?:send|post).*message/)) {
      return 'send_message';
    }

    return 'unknown';
  }

  /**
   * Detect if voice input contains multiple commands (chaining)
   */
  detectCommandChain(voiceText: string): string[] {
    const separators = [
      /\s+and\s+then\s+/i,
      /\s+then\s+/i,
      /\s+and\s+also\s+/i,
      /\s+after\s+that\s+/i,
      /\s+followed\s+by\s+/i
    ];

    for (const separator of separators) {
      if (separator.test(voiceText)) {
        const commands = voiceText.split(separator).map(cmd => cmd.trim());
        logger.info('Multi-command chain detected', {
          count: commands.length,
          commands
        });
        return commands;
      }
    }

    return [voiceText];
  }

  /**
   * Resolve special identifiers (e.g., "LATEST" event)
   */
  async resolveSpecialIdentifiers(
    userId: string,
    command: VoiceCommand
  ): Promise<VoiceCommand> {
    // If action requires event ID and it's set to "LATEST"
    if (
      command.service === 'google_calendar' &&
      (command.action === 'update_event' || command.action === 'delete_event') &&
      command.params.eventId === 'LATEST'
    ) {
      try {
        // Check if MCP is connected
        if (!mcpConnectionManagerV2.isConnected(userId, 'google')) {
          logger.warn('Cannot resolve LATEST event - Google Calendar MCP not connected', {
            userId
          });
          return command;
        }

        // List recent events to find the one to modify
        const result = await mcpConnectionManagerV2.callTool(
          userId,
          'google',
          'list_events',
          { maxResults: '5' }
        );

        if (result && (result as any).events) {
          const events = (result as any).events;
          if (events && events.length > 0) {
            // Use the first (most recent) event
            command.params.eventId = events[0].id;
            logger.info('Resolved LATEST event ID', {
              userId,
              eventId: events[0].id
            });
          }
        }
      } catch (error) {
        logger.error('Failed to resolve LATEST event ID', {
          userId,
          error: (error as Error).message
        });
      }
    }

    return command;
  }
}
