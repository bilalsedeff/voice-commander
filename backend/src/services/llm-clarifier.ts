/**
 * LLM Intent Clarifier
 *
 * Uses OpenAI to:
 * - Parse ambiguous voice commands
 * - Map commands to available MCP tools
 * - Generate clarification questions when uncertain
 * - Extract parameters from natural language
 */

import { llmService, LLMTaskType } from './llm-service';
import { ConversationContext } from './conversation-manager';
import { MCPTool } from '../mcp/types';
import logger from '../utils/logger';

export interface IntentParseResult {
  // Parsed intent
  service: string; // e.g., "google_calendar", "slack"
  action: string; // e.g., "create_event", "send_message"
  parameters: Record<string, unknown>;
  confidence: number; // 0-1

  // Clarification
  needsClarification: boolean;
  clarificationQuestion?: string;
  missingParameters?: string[];

  // Metadata
  matchedTool?: MCPTool;
  reasoning?: string;
}

export class LLMClarifier {
  /**
   * Parse voice command with context and available tools
   */
  async parseIntent(
    voiceCommand: string,
    availableTools: Record<string, MCPTool[]>, // { service_name: [tools] }
    context?: ConversationContext
  ): Promise<IntentParseResult> {
    try {
      const systemPrompt = this.buildSystemPrompt(availableTools, context);
      const userPrompt = this.buildUserPrompt(voiceCommand, context);

      // Use FAST model (gpt-4o-mini) for intent parsing - it's a simple classification task
      const response = await llmService.execute({
        systemPrompt,
        userPrompt,
        taskType: LLMTaskType.FAST, // Cheap & fast for intent classification
        requiresJSON: true
      });

      const result = JSON.parse(response.content || '{}');

      logger.info('Intent parsed by LLM', {
        voiceCommand,
        service: result.service,
        action: result.action,
        confidence: result.confidence,
        needsClarification: result.needsClarification,
        model: response.model,
        cost: response.cost.toFixed(6),
        latency: response.latency
      });

      return {
        service: result.service || 'unknown',
        action: result.action || 'unknown',
        parameters: result.parameters || {},
        confidence: result.confidence || 0,
        needsClarification: result.needsClarification || false,
        clarificationQuestion: result.clarificationQuestion,
        missingParameters: result.missingParameters,
        reasoning: result.reasoning
      };
    } catch (error) {
      logger.error('LLM intent parsing failed', {
        error: (error as Error).message,
        voiceCommand
      });

      // Fallback to pattern matching
      return this.fallbackParser(voiceCommand, availableTools);
    }
  }

  /**
   * Build system prompt with available tools
   */
  private buildSystemPrompt(
    availableTools: Record<string, MCPTool[]>,
    context?: ConversationContext
  ): string {
    const toolsList = Object.entries(availableTools)
      .map(([service, tools]) => {
        const toolDescriptions = tools.map(t =>
          `  - ${t.name}: ${t.description}\n    Parameters: ${Object.keys(t.inputSchema.properties).join(', ')}`
        ).join('\n');

        return `${service}:\n${toolDescriptions}`;
      })
      .join('\n\n');

    let prompt = `You are a voice command parser for a productivity platform. Your job is to:

1. Parse natural language voice commands
2. Map them to available MCP tools and parameters
3. Ask for clarification when ambiguous or missing critical information

Available Tools:
${toolsList}

Instructions:
- Match the user's intent to the most appropriate tool
- Extract parameters from natural language (dates, times, names, etc.)
- If confidence is below 0.7, ask a clarifying question
- If required parameters are missing, ask for them specifically
- Consider conversation context for ambiguous references

Response format (JSON):
{
  "service": "service_name",
  "action": "tool_name",
  "parameters": { "param1": "value1" },
  "confidence": 0.95,
  "needsClarification": false,
  "clarificationQuestion": "optional question if needs clarification",
  "missingParameters": ["param1", "param2"],
  "reasoning": "brief explanation of intent match"
}`;

    // Add context if available
    if (context && context.recentCommands.length > 0) {
      const recentContext = context.recentCommands
        .slice(0, 3)
        .map(cmd => `- "${cmd.transcript}" (${cmd.success ? 'success' : 'failed'})`)
        .join('\n');

      prompt += `\n\nRecent conversation:\n${recentContext}`;
    }

    return prompt;
  }

  /**
   * Build user prompt
   */
  private buildUserPrompt(
    voiceCommand: string,
    _context?: ConversationContext
  ): string {
    return `Parse this voice command and respond with JSON:\n\n"${voiceCommand}"`;
  }

  /**
   * Fallback parser when OpenAI not available
   */
  private fallbackParser(
    voiceCommand: string,
    _availableTools: Record<string, MCPTool[]>
  ): IntentParseResult {
    const commandLower = voiceCommand.toLowerCase();

    // Try to match keywords to services/actions
    let bestMatch: IntentParseResult = {
      service: 'unknown',
      action: 'unknown',
      parameters: {},
      confidence: 0,
      needsClarification: true,
      clarificationQuestion: `I'm not sure what you want to do. Could you rephrase your request? For example: "Schedule a meeting tomorrow at 3pm" or "Show my calendar for next week"`
    };

    // Calendar keywords
    if (commandLower.includes('calendar') || commandLower.includes('meeting') ||
        commandLower.includes('schedule') || commandLower.includes('event')) {

      if (commandLower.includes('show') || commandLower.includes('list') || commandLower.includes('get')) {
        bestMatch = {
          service: 'google_calendar',
          action: 'list_events',
          parameters: {},
          confidence: 0.75,
          needsClarification: false
        };
      } else if (commandLower.includes('create') || commandLower.includes('schedule') || commandLower.includes('add')) {
        // Try to extract meeting title
        const match = voiceCommand.match(/(?:schedule|create|add)(?:\s+a)?\s+(?:meeting|event)(?:\s+(?:about|for|titled|called))?\s+(.+?)(?:\s+(?:at|on|for|tomorrow|next|today)|$)/i);

        if (match) {
          bestMatch = {
            service: 'google_calendar',
            action: 'create_event',
            parameters: {
              summary: match[1].trim()
            },
            confidence: 0.8,
            needsClarification: false
          };
        } else {
          bestMatch = {
            service: 'google_calendar',
            action: 'create_event',
            parameters: {},
            confidence: 0.5,
            needsClarification: true,
            clarificationQuestion: "What should I title the meeting?",
            missingParameters: ['summary']
          };
        }
      }
    }

    return bestMatch;
  }

  /**
   * Generate follow-up question based on missing info
   */
  generateClarificationQuestion(
    parsedIntent: IntentParseResult
  ): string {
    if (parsedIntent.clarificationQuestion) {
      return parsedIntent.clarificationQuestion;
    }

    if (parsedIntent.missingParameters && parsedIntent.missingParameters.length > 0) {
      const param = parsedIntent.missingParameters[0];
      return `I need more information. What should the ${param} be?`;
    }

    if (parsedIntent.confidence < 0.5) {
      return "I'm not sure I understood correctly. Could you please rephrase your request?";
    }

    return "Could you provide more details about what you'd like to do?";
  }
}

// Singleton instance
export const llmClarifier = new LLMClarifier();
