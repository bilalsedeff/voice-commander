/**
 * LLM Service - Tiered Model Orchestration
 *
 * Provides intelligent model selection based on task complexity:
 * - FAST: gpt-4o-mini (simple classification, parameter extraction)
 * - BALANCED: gpt-4o (clarification, ambiguity resolution)
 * - SMART: gpt-4-turbo (complex reasoning, multi-tool orchestration)
 *
 * Features:
 * - Cost tracking per request
 * - Automatic fallback on errors
 * - Streaming support for real-time responses
 * - Usage analytics
 */

import OpenAI from 'openai';
import logger from '../utils/logger';

export enum LLMTaskType {
  FAST = 'fast',           // Quick classification/extraction
  BALANCED = 'balanced',   // Clarification, reasoning
  SMART = 'smart'          // Complex multi-step reasoning
}

interface LLMModelConfig {
  name: string;
  inputCostPer1M: number;  // USD
  outputCostPer1M: number; // USD
  maxTokens: number;
  temperature: number;
}

const MODEL_CONFIGS: Record<LLMTaskType, LLMModelConfig> = {
  [LLMTaskType.FAST]: {
    name: 'gpt-4.1-nano', // Ultra-fast classification model (~150ms avg latency)
    inputCostPer1M: 0.04,  // ~75% cheaper than gpt-4o-mini
    outputCostPer1M: 0.16,
    maxTokens: 500,
    temperature: 0.1 // Very low for deterministic classification
  },
  [LLMTaskType.BALANCED]: {
    name: 'gpt-4o-mini', // Fast general-purpose model
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    maxTokens: 1000,
    temperature: 0.5
  },
  [LLMTaskType.SMART]: {
    name: 'gpt-4o', // Smart reasoning model (not turbo-preview)
    inputCostPer1M: 2.50,
    outputCostPer1M: 10.00,
    maxTokens: 2000,
    temperature: 0.7
  }
};

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  taskType: LLMTaskType;
  requiresJSON?: boolean;
  streaming?: boolean;
  onChunk?: (chunk: string) => void;
}

export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  cost: number; // USD
  latency: number; // ms
  taskType: LLMTaskType;
}

// Usage tracking (in-memory, should be moved to database for production)
class UsageTracker {
  private stats = {
    totalRequests: 0,
    totalCost: 0,
    totalTokens: 0,
    byModel: {} as Record<string, { requests: number; cost: number; tokens: number }>
  };

  track(response: LLMResponse): void {
    this.stats.totalRequests++;
    this.stats.totalCost += response.cost;
    this.stats.totalTokens += response.tokensUsed.total;

    if (!this.stats.byModel[response.model]) {
      this.stats.byModel[response.model] = { requests: 0, cost: 0, tokens: 0 };
    }

    this.stats.byModel[response.model].requests++;
    this.stats.byModel[response.model].cost += response.cost;
    this.stats.byModel[response.model].tokens += response.tokensUsed.total;
  }

  getStats() {
    return { ...this.stats };
  }

  reset(): void {
    this.stats = {
      totalRequests: 0,
      totalCost: 0,
      totalTokens: 0,
      byModel: {}
    };
  }
}

export class LLMService {
  private usageTracker = new UsageTracker();
  private openai: OpenAI | null = null;

  constructor() {
    // Lazy initialization - allows mocking in tests
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  }

  /**
   * Execute LLM request with tiered model selection
   */
  async execute(request: LLMRequest): Promise<LLMResponse> {
    if (!this.openai) {
      throw new Error('OpenAI API key not configured');
    }

    const startTime = Date.now();
    const config = MODEL_CONFIGS[request.taskType];

    try {
      logger.info('LLM request started', {
        taskType: request.taskType,
        model: config.name,
        streaming: request.streaming || false
      });

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt }
      ];

      const completionParams: OpenAI.Chat.ChatCompletionCreateParams = {
        model: config.name,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        ...(request.requiresJSON && { response_format: { type: 'json_object' } })
      };

      // Streaming vs non-streaming
      if (request.streaming && request.onChunk) {
        return await this.executeStreaming(completionParams, request.onChunk, config, startTime);
      } else {
        return await this.executeNonStreaming(completionParams, config, startTime);
      }
    } catch (error) {
      logger.error('LLM request failed', {
        taskType: request.taskType,
        model: config.name,
        error: (error as Error).message
      });

      // Fallback to faster model if smart task failed
      if (request.taskType === LLMTaskType.SMART) {
        logger.warn('Falling back to BALANCED model');
        return await this.execute({
          ...request,
          taskType: LLMTaskType.BALANCED
        });
      }

      throw error;
    }
  }

  /**
   * Non-streaming execution
   */
  private async executeNonStreaming(
    params: OpenAI.Chat.ChatCompletionCreateParams,
    config: LLMModelConfig,
    startTime: number
  ): Promise<LLMResponse> {
    const completion = await this.openai!.chat.completions.create({
      ...params,
      stream: false
    }) as OpenAI.Chat.ChatCompletion;

    const response: LLMResponse = {
      content: completion.choices[0].message.content || '',
      model: completion.model,
      tokensUsed: {
        input: completion.usage?.prompt_tokens || 0,
        output: completion.usage?.completion_tokens || 0,
        total: completion.usage?.total_tokens || 0
      },
      cost: this.calculateCost(
        completion.usage?.prompt_tokens || 0,
        completion.usage?.completion_tokens || 0,
        config
      ),
      latency: Date.now() - startTime,
      taskType: this.getTaskTypeFromModel(config.name)
    };

    this.usageTracker.track(response);

    logger.info('LLM request completed', {
      model: response.model,
      tokensUsed: response.tokensUsed.total,
      cost: response.cost.toFixed(4),
      latency: response.latency
    });

    return response;
  }

  /**
   * Streaming execution
   */
  private async executeStreaming(
    params: OpenAI.Chat.ChatCompletionCreateParams,
    onChunk: (chunk: string) => void,
    config: LLMModelConfig,
    startTime: number
  ): Promise<LLMResponse> {
    const stream = await this.openai!.chat.completions.create({
      ...params,
      stream: true
    });

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullContent += delta;
        onChunk(delta);
        outputTokens++; // Rough estimate
      }
    }

    // Estimate input tokens (rough approximation: 4 chars = 1 token)
    const systemPrompt = (params.messages[0] as any).content || '';
    const userPrompt = (params.messages[1] as any).content || '';
    inputTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);

    const response: LLMResponse = {
      content: fullContent,
      model: config.name,
      tokensUsed: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens
      },
      cost: this.calculateCost(inputTokens, outputTokens, config),
      latency: Date.now() - startTime,
      taskType: this.getTaskTypeFromModel(config.name)
    };

    this.usageTracker.track(response);

    logger.info('LLM streaming completed', {
      model: response.model,
      tokensUsed: response.tokensUsed.total,
      cost: response.cost.toFixed(4),
      latency: response.latency
    });

    return response;
  }

  /**
   * Calculate cost in USD
   */
  private calculateCost(
    inputTokens: number,
    outputTokens: number,
    config: LLMModelConfig
  ): number {
    const inputCost = (inputTokens / 1_000_000) * config.inputCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * config.outputCostPer1M;
    return inputCost + outputCost;
  }

  /**
   * Get task type from model name
   */
  private getTaskTypeFromModel(modelName: string): LLMTaskType {
    if (modelName.includes('nano')) return LLMTaskType.FAST;
    if (modelName.includes('mini')) return LLMTaskType.BALANCED;
    if (modelName.includes('4o')) return LLMTaskType.SMART;
    return LLMTaskType.SMART;
  }

  /**
   * Get usage statistics
   */
  getUsageStats() {
    return this.usageTracker.getStats();
  }

  /**
   * Reset usage statistics
   */
  resetUsageStats(): void {
    this.usageTracker.reset();
  }
}

// Singleton instance
export const llmService = new LLMService();
