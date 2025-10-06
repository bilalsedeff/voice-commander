/**
 * Natural Response Generator
 *
 * Generates conversational, human-like TTS responses from tool execution results.
 * Uses LLM to create natural language instead of template-based responses.
 */

import { llmService, LLMTaskType } from './llm-service';
import logger from '../utils/logger';

interface ToolResult {
  success: boolean;
  tool: string;
  service: string;
  data?: unknown;
  error?: string;
}

interface GenerateResponseOptions {
  conversationContext?: string;
  keepShort?: boolean; // Force <20 words
  askFollowUp?: boolean; // Include follow-up question
}

export class NaturalResponseGenerator {
  /**
   * Generate conversational response (no tools executed)
   */
  async generateConversationalResponse(
    query: string,
    conversationContext?: string
  ): Promise<string> {
    try {
      const systemPrompt = `You are a helpful, proactive voice assistant ready to assist with tasks.

Guidelines:
- Respond warmly to greetings and offer to help
- Be enthusiastic and helpful
- Keep responses under 15 words
- Always ask what the user wants to do after greeting
- Sound natural and human
${conversationContext ? `\nPrevious conversation:\n${conversationContext}` : ''}`;

      const response = await llmService.execute({
        systemPrompt,
        userPrompt: query,
        taskType: LLMTaskType.FAST,
        requiresJSON: false
      });

      return response.content.trim();
    } catch (error) {
      // Fallback responses for common queries
      if (/^(hi|hello|hey)/i.test(query)) return "Hello! What would you like me to do?";
      if (/^(thanks|thank you)/i.test(query)) return "You're welcome! Anything else?";
      if (/^(bye|goodbye)/i.test(query)) return "Goodbye! Have a great day!";
      return "I'm ready to help. What can I do for you?";
    }
  }

  /**
   * Generate natural spoken response from tool results
   */
  async generateTTSResponse(
    originalQuery: string,
    toolResults: ToolResult[],
    options?: GenerateResponseOptions
  ): Promise<string> {
    try {
      const systemPrompt = this.buildSystemPrompt(options);
      const userPrompt = this.buildUserPrompt(originalQuery, toolResults, options);

      logger.debug('Generating natural TTS response', {
        query: originalQuery,
        resultCount: toolResults.length,
        hasContext: !!options?.conversationContext
      });

      const response = await llmService.execute({
        systemPrompt,
        userPrompt,
        taskType: LLMTaskType.FAST, // GPT-4.1-nano for quick responses
        requiresJSON: false
      });

      const naturalResponse = response.content.trim();

      logger.info('Natural TTS response generated', {
        query: originalQuery,
        response: naturalResponse,
        responseLength: naturalResponse.length,
        cost: response.cost
      });

      return naturalResponse;

    } catch (error) {
      logger.error('Failed to generate natural response', {
        error: (error as Error).message
      });

      // Fallback to simple response
      return this.createFallbackResponse(toolResults);
    }
  }

  /**
   * Build system prompt for conversational tone
   */
  private buildSystemPrompt(options?: GenerateResponseOptions): string {
    return `You are a helpful, friendly voice assistant speaking to the user.

Your role:
- Summarize what you did in natural, conversational language
- Highlight the most important information
- Be concise and clear (speak like a human, not a robot)
${options?.askFollowUp !== false ? '- Ask a relevant follow-up question to keep the conversation going' : '- End naturally without questions'}
${options?.keepShort ? '- Keep response under 20 words' : '- Keep response under 40 words'}

Style guidelines:
- Use contractions (I've, you're, it's)
- Sound natural and friendly
- Don't use emojis or special characters
- Don't say "I executed" or technical jargon
- Focus on what the user cares about

${options?.conversationContext ? `Remember the conversation context and reference it naturally.` : ''}`;
  }

  /**
   * Build user prompt with query and results
   */
  private buildUserPrompt(
    query: string,
    results: ToolResult[],
    options?: GenerateResponseOptions
  ): string {
    let prompt = '';

    // Add conversation context if available
    if (options?.conversationContext) {
      prompt += `Previous conversation:\n${options.conversationContext}\n\n`;
    }

    prompt += `User asked: "${query}"\n\n`;

    // Add tool results
    prompt += `What you did:\n`;
    results.forEach((result, idx) => {
      if (result.success) {
        prompt += `${idx + 1}. ${result.tool} on ${result.service}:\n`;
        prompt += `   Result: ${JSON.stringify(result.data, null, 2)}\n\n`;
      } else {
        prompt += `${idx + 1}. ${result.tool} failed: ${result.error}\n\n`;
      }
    });

    prompt += `Generate a natural spoken response that tells the user what happened.`;

    if (options?.keepShort) {
      prompt += ` Keep it very brief (under 20 words).`;
    }

    if (options?.askFollowUp !== false) {
      prompt += ` Include a helpful follow-up question.`;
    }

    prompt += `\n\nSpoken response:`;

    return prompt;
  }

  /**
   * Create fallback response if LLM fails
   */
  private createFallbackResponse(results: ToolResult[]): string {
    if (results.length === 0) {
      return "I couldn't complete that request.";
    }

    const firstResult = results[0];

    if (!firstResult.success) {
      return `Sorry, ${firstResult.tool} failed. ${firstResult.error || 'Please try again.'}`;
    }

    // Try to create a basic response from data
    if (firstResult.data && typeof firstResult.data === 'object') {
      const data = firstResult.data as Record<string, unknown>;

      // Calendar events
      if ('count' in data && typeof data.count === 'number') {
        const count = data.count;
        if (count === 0) {
          return "I didn't find any upcoming events.";
        }
        return `I found ${count} upcoming event${count > 1 ? 's' : ''}.`;
      }

      // Generic success
      return "Done! Your request was completed successfully.";
    }

    return "All done!";
  }

  /**
   * Generate response specifically for calendar events
   */
  async generateCalendarEventResponse(
    _query: string,
    events: Array<{
      summary: string;
      start: string;
      end?: string;
      location?: string;
    }>,
    _conversationContext?: string
  ): Promise<string> {
    if (events.length === 0) {
      return "You don't have any upcoming meetings scheduled.";
    }

    if (events.length === 1) {
      const event = events[0];
      const eventDate = new Date(event.start);
      const isToday = eventDate.toDateString() === new Date().toDateString();
      const isTomorrow = eventDate.toDateString() === new Date(Date.now() + 86400000).toDateString();

      const when = isToday ? 'today' : isTomorrow ? 'tomorrow' : 'coming up';

      return `You have one event ${when} called "${event.summary}". Would you like me to read the details?`;
    }

    return `You have ${events.length} upcoming meetings. Want me to list them out?`;
  }
}

// Export singleton instance
export const naturalResponseGenerator = new NaturalResponseGenerator();
