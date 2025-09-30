/**
 * LLM-Powered Intent Recognition Service
 *
 * Uses GPT-4.1 nano for ultra-fast natural language understanding and intent recognition.
 * Provides structured output with confidence scoring and parameter extraction for MCP tools.
 *
 * Dependencies:
 * - openai: https://github.com/openai/openai-node
 * - winston: https://github.com/winstonjs/winston
 *
 * Input: Natural language voice commands
 * Output: Structured intent with tool mapping and parameters
 *
 * Example:
 * const service = new LLMIntentService();
 * const intent = await service.recognizeIntent("create a folder named test in src");
 * // intent.tool = "create_directory", intent.params = { path: "src/test" }
 */

import OpenAI from 'openai';
import * as winston from 'winston';
import { performance } from 'perf_hooks';
import * as fs from 'fs/promises';
import * as path from 'path';

// Simple path resolution that works in both test and production
const getMCPDictionaryPath = () => {
  // Always use project root-relative path
  return path.resolve(process.cwd(), 'src', 'mcp_dict', 'desktop-commander.json');
};
import {
  RiskLevel,
  VoiceProcessingError,
  ValidationError,
  MCPToolCall
} from '../utils/types';

// Structured output interface for LLM
export interface LLMIntentResult {
  tool: string;
  confidence: number;
  parameters: Record<string, unknown>;
  risk_level: RiskLevel;
  requires_confirmation: boolean;
  reasoning: string;
  alternatives?: Array<{
    tool: string;
    confidence: number;
  }>;
}

// Input context for better recognition
export interface IntentContext {
  session_id: string;
  user_id: string;
  recent_commands?: string[];
  current_directory?: string;
  active_processes?: string[];
  conversation_history?: string[];
}

// Cache entry for performance
interface CacheEntry {
  result: LLMIntentResult;
  timestamp: number;
  ttl: number; // Time to live in ms
}

export class LLMIntentService {
  private openai!: OpenAI;
  private logger!: winston.Logger;
  private mcpDictionary: any = null;
  private mcpDictionaryPromise: Promise<void> | null = null;
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 1000;

  constructor() {
    this.setupOpenAI();
    this.setupLogger();
    this.setupCacheCleanup();
  }

  private setupOpenAI(): void {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new VoiceProcessingError(
        "OpenAI API key is required for LLM intent recognition",
        "MISSING_OPENAI_KEY"
      );
    }

    this.openai = new OpenAI({
      apiKey,
      timeout: 10000, // 10 seconds timeout
    });
  }

  private setupLogger(): void {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/llm-intent-service.log' })
      ]
    });
  }

  private async loadMCPDictionary(): Promise<void> {
    try {
      const dictionaryPath = getMCPDictionaryPath();
      const dictionaryContent = await fs.readFile(dictionaryPath, 'utf-8');
      this.mcpDictionary = JSON.parse(dictionaryContent);

      this.logger.info('MCP dictionary loaded successfully', {
        toolCount: Object.keys(this.mcpDictionary.tools).length,
        serverName: this.mcpDictionary.server_name
      });
    } catch (error) {
      this.logger.error('Failed to load MCP dictionary', {
        error: (error as Error).message
      });
      throw new VoiceProcessingError(
        "Failed to load MCP dictionary for intent recognition",
        "DICTIONARY_LOAD_ERROR",
        error as Error
      );
    }
  }

  private setupCacheCleanup(): void {
    // Clean expired cache entries every 5 minutes
    setInterval(() => {
      this.cleanExpiredCache();
    }, 5 * 60 * 1000);
  }

  /**
   * Ensure MCP dictionary is loaded (lazy loading)
   */
  private async ensureMCPDictionary(): Promise<void> {
    if (this.mcpDictionary !== null) {
      return; // Already loaded
    }

    if (this.mcpDictionaryPromise !== null) {
      // Loading in progress, wait for it
      return this.mcpDictionaryPromise;
    }

    // Start loading
    this.mcpDictionaryPromise = this.loadMCPDictionary();
    return this.mcpDictionaryPromise;
  }

  private cleanExpiredCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug('Cache cleanup completed', {
        cleanedEntries: cleanedCount,
        remainingEntries: this.cache.size
      });
    }
  }

  private getCacheKey(userInput: string, context?: IntentContext): string {
    const contextKey = context ?
      `${context.session_id || ''}_${context.user_id || ''}_${context.current_directory || ''}_${context.recent_commands?.slice(-2).join('_') || ''}` : '';
    return `${userInput.toLowerCase().trim()}_${contextKey}`;
  }

  private getCachedResult(cacheKey: string): LLMIntentResult | null {
    const entry = this.cache.get(cacheKey);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(cacheKey);
      return null;
    }

    return entry.result;
  }

  private setCachedResult(cacheKey: string, result: LLMIntentResult): void {
    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(cacheKey, {
      result,
      timestamp: Date.now(),
      ttl: this.CACHE_TTL
    });
  }

  private buildSystemPrompt(): string {
    if (!this.mcpDictionary || !this.mcpDictionary.tools) {
      throw new VoiceProcessingError(
        "MCP dictionary not loaded for system prompt generation",
        "DICTIONARY_NOT_LOADED"
      );
    }

    const toolsDescription = Object.entries(this.mcpDictionary.tools)
      .map(([name, tool]: [string, any]) => {
        return `- **${name}**: ${tool.description} (Risk: ${tool.risk_level}, Confirmation: ${tool.requires_confirmation})\n` +
               `  Parameters: ${Object.entries(tool.parameters).map(([param, info]: [string, any]) =>
                 `${param}(${info.type}${info.required ? '*' : ''})`).join(', ')}\n` +
               `  Examples: ${tool.examples.slice(0, 2).join(', ')}`;
      }).join('\n\n');

    return `You are an expert intent recognition system for Desktop Commander MCP tools. Your job is to understand natural language voice commands and map them to the appropriate MCP tool with extracted parameters.

AVAILABLE TOOLS:
${toolsDescription}

RESPONSE FORMAT (JSON):
{
  "tool": "exact_tool_name",
  "confidence": 0.95,
  "parameters": {"param_name": "extracted_value"},
  "risk_level": "low|medium|high",
  "requires_confirmation": true|false,
  "reasoning": "Brief explanation of why this tool was selected",
  "alternatives": [{"tool": "alternative_tool", "confidence": 0.75}]
}

RULES:
1. Always respond with valid JSON matching the exact format above
2. Tool names must match exactly from the available tools list
3. Extract parameters intelligently from natural language
4. Confidence should reflect how certain you are (0.0-1.0)
5. Consider context like file paths, directories, and recent commands
6. For file/folder operations, extract full paths when possible
7. If creating nested paths (e.g., "folder A in folder B"), use "B/A" format
8. Be flexible with natural language variations but precise with tool selection
9. If uncertain between tools, provide alternatives with confidence scores
10. Risk level and confirmation requirements must match the tool definition

CONTEXT AWARENESS:
- Pay attention to file extensions (.js, .json, .md, etc.)
- Understand relative paths and directory structures
- Consider command chaining and sequential operations
- Recognize when users want to work with existing vs new files/folders`;
  }

  private buildUserPrompt(userInput: string, context?: IntentContext): string {
    let prompt = `VOICE COMMAND: "${userInput}"`;

    if (context) {
      if (context.current_directory) {
        prompt += `\n\nCURRENT DIRECTORY: ${context.current_directory}`;
      }

      if (context.recent_commands && context.recent_commands.length > 0) {
        prompt += `\n\nRECENT COMMANDS: ${context.recent_commands.join(', ')}`;
      }

      if (context.active_processes && context.active_processes.length > 0) {
        prompt += `\n\nACTIVE PROCESSES: ${context.active_processes.join(', ')}`;
      }
    }

    prompt += '\n\nPlease analyze this voice command and provide the appropriate tool mapping with extracted parameters.';

    return prompt;
  }

  async recognizeIntent(
    userInput: string,
    context?: IntentContext
  ): Promise<LLMIntentResult> {
    const startTime = performance.now();

    try {
      // Input validation
      if (!userInput?.trim()) {
        throw new ValidationError(
          "Voice input cannot be empty",
          "userInput",
          userInput
        );
      }

      // Ensure MCP dictionary is loaded
      await this.ensureMCPDictionary();

      // Check cache first
      const cacheKey = this.getCacheKey(userInput, context);
      const cachedResult = this.getCachedResult(cacheKey);

      if (cachedResult) {
        const duration = performance.now() - startTime;
        this.logger.info('Intent recognition cache hit', {
          userInput,
          tool: cachedResult.tool,
          confidence: cachedResult.confidence,
          duration: Math.round(duration),
          cached: true
        });
        return cachedResult;
      }

      // Call GPT-4.1 nano for intent recognition
      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = this.buildUserPrompt(userInput, context);

      this.logger.info('Calling GPT-4.1 nano for intent recognition', {
        userInput,
        sessionId: context?.session_id,
        contextProvided: !!context
      });

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4.1-nano", // Ultra-fast model optimized for classification
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1, // Low temperature for consistent, deterministic output
        max_tokens: 500,   // Sufficient for structured JSON response
        response_format: { type: "json_object" } // Ensure JSON output
      }, {
        timeout: 8000 // 8 second timeout for GPT-4.1 nano
      });

      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) {
        throw new VoiceProcessingError(
          "Empty response from LLM intent recognition",
          "EMPTY_LLM_RESPONSE"
        );
      }

      // Parse and validate LLM response
      let llmResult: LLMIntentResult;
      try {
        llmResult = JSON.parse(responseContent);
      } catch (parseError) {
        this.logger.error('Failed to parse LLM JSON response', {
          userInput,
          responseContent,
          error: (parseError as Error).message
        });
        throw new VoiceProcessingError(
          "Invalid JSON response from LLM intent recognition",
          "INVALID_LLM_JSON",
          parseError as Error
        );
      }

      // Validate tool exists in dictionary
      if (!this.mcpDictionary || !this.mcpDictionary.tools || !this.mcpDictionary.tools[llmResult.tool]) {
        this.logger.warn('LLM suggested unknown tool', {
          userInput,
          suggestedTool: llmResult.tool,
          availableTools: this.mcpDictionary?.tools ? Object.keys(this.mcpDictionary.tools) : []
        });
        throw new VoiceProcessingError(
          `LLM suggested unknown tool: ${llmResult.tool}`,
          "UNKNOWN_SUGGESTED_TOOL"
        );
      }

      // Validate confidence range
      if (llmResult.confidence < 0 || llmResult.confidence > 1) {
        llmResult.confidence = Math.max(0, Math.min(1, llmResult.confidence));
      }

      // Cache the result
      this.setCachedResult(cacheKey, llmResult);

      const duration = performance.now() - startTime;
      this.logger.info('LLM intent recognition completed', {
        userInput,
        tool: llmResult.tool,
        confidence: llmResult.confidence,
        riskLevel: llmResult.risk_level,
        duration: Math.round(duration),
        cached: false,
        sessionId: context?.session_id
      });

      // Check for performance targets (should be <500ms with GPT-4.1 nano)
      if (duration > 1000) {
        this.logger.warn('LLM intent recognition exceeded 1000ms', {
          userInput,
          duration: Math.round(duration),
          target: 500
        });
      }

      return llmResult;

    } catch (error) {
      const duration = performance.now() - startTime;
      this.logger.error('LLM intent recognition failed', {
        userInput,
        duration: Math.round(duration),
        error: (error as Error).message,
        sessionId: context?.session_id
      });

      // Re-throw with more context
      if (error instanceof VoiceProcessingError || error instanceof ValidationError) {
        throw error;
      }

      throw new VoiceProcessingError(
        `LLM intent recognition failed: ${(error as Error).message}`,
        "LLM_RECOGNITION_ERROR",
        error as Error
      );
    }
  }

  /**
   * Convert LLM result to MCP tool call format
   */
  convertToMCPCall(intentResult: LLMIntentResult): MCPToolCall {
    return {
      method: intentResult.tool,
      params: intentResult.parameters,
      id: `llm-intent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): { size: number; hitRate: number; maxSize: number } {
    // This would be enhanced with hit rate tracking in production
    return {
      size: this.cache.size,
      hitRate: 0, // Would track hits vs misses
      maxSize: this.MAX_CACHE_SIZE
    };
  }

  /**
   * Clear cache manually (useful for testing or memory management)
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.info('Intent recognition cache cleared');
  }
}

// Singleton instance for performance - lazy initialization
let _llmIntentServiceInstance: LLMIntentService | null = null;

export const llmIntentService = {
  get instance(): LLMIntentService {
    if (!_llmIntentServiceInstance) {
      _llmIntentServiceInstance = new LLMIntentService();
    }
    return _llmIntentServiceInstance;
  },

  // Proxy methods for backward compatibility
  async recognizeIntent(userInput: string, context?: IntentContext): Promise<LLMIntentResult> {
    return this.instance.recognizeIntent(userInput, context);
  },

  convertToMCPCall(intentResult: LLMIntentResult): MCPToolCall {
    return this.instance.convertToMCPCall(intentResult);
  },

  getCacheStats() {
    return this.instance.getCacheStats();
  },

  clearCache(): void {
    return this.instance.clearCache();
  }
};

// Validation function for testing
export async function validateLLMIntentService(): Promise<void> {
  const failures: string[] = [];
  let totalTests = 0;

  const service = llmIntentService.instance;

  // Test 1: Basic file operation
  totalTests++;
  try {
    const result = await service.recognizeIntent("read file package.json");
    if (result.tool !== "read_file" || result.confidence < 0.8) {
      failures.push("Basic file operation test failed");
    } else {
      console.log("✓ Basic file operation recognition working");
    }
  } catch (error) {
    failures.push(`Basic file operation: ${(error as Error).message}`);
  }

  // Test 2: Complex folder creation
  totalTests++;
  try {
    const result = await service.recognizeIntent("create a folder named test in the src directory");
    if (result.tool !== "create_directory" || !result.parameters.path?.toString().includes("src")) {
      failures.push("Complex folder creation test failed");
    } else {
      console.log("✓ Complex folder creation recognition working");
    }
  } catch (error) {
    failures.push(`Complex folder creation: ${(error as Error).message}`);
  }

  // Test 3: Process management
  totalTests++;
  try {
    const result = await service.recognizeIntent("run npm install in the background");
    if (result.tool !== "start_process" || !result.parameters.command?.toString().includes("npm")) {
      failures.push("Process management test failed");
    } else {
      console.log("✓ Process management recognition working");
    }
  } catch (error) {
    failures.push(`Process management: ${(error as Error).message}`);
  }

  // Test 4: Search operation
  totalTests++;
  try {
    const result = await service.recognizeIntent("find all TODO comments in src folder");
    if (!["search_files", "search_code"].includes(result.tool)) {
      failures.push("Search operation test failed");
    } else {
      console.log("✓ Search operation recognition working");
    }
  } catch (error) {
    failures.push(`Search operation: ${(error as Error).message}`);
  }

  // Report results
  if (failures.length > 0) {
    console.error(`❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
    failures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  } else {
    console.log(`✅ VALIDATION PASSED - All ${totalTests} tests successful`);
    console.log("LLM Intent Service is validated and ready for production use");
    process.exit(0);
  }
}

// Validation function kept for testing purposes, but not auto-executed