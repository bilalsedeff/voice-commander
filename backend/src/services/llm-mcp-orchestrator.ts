/**
 * LLM-MCP Orchestrator
 *
 * Intelligent command orchestration using GPT-4.1-nano:
 * 1. Discovers available MCP tools dynamically
 * 2. Uses LLM to understand intent and select tools
 * 3. Builds command execution chains
 * 4. Executes with real-time progress streaming
 * 5. Handles errors and clarifications
 *
 * Replaces regex-based CommandMapper with intelligent LLM-driven mapping
 */

import { mcpProcessManager } from './mcp-process-manager';
import { mcpConnectionManagerV2 } from './mcp-connection-manager-v2';
import { llmService, LLMTaskType } from './llm-service';
import logger from '../utils/logger';
import prisma from '../config/database';

// ==================== Type Definitions ====================

/**
 * LLM-friendly tool definition (flattened structure for GPT-4)
 * Different from MCPTool which uses JSON Schema format
 */
export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: {
    name: string;
    type: string;
    required: boolean;
    description: string;
  }[];
  examples?: string[];
}

export interface ToolRegistry {
  [service: string]: LLMToolDefinition[];
}

export interface SelectedTool {
  service: string;
  tool: string;
  params: Record<string, unknown>;
  reasoning?: string;
}

export interface ExecutionPlan {
  selectedTools: SelectedTool[];
  executionPlan: string;
  confidence: number;
  needsClarification: boolean;
  clarificationQuestion?: string;
}

export interface ProgressUpdate {
  type: 'analyzing' | 'discovering' | 'selecting' | 'executing' | 'completed' | 'error';
  message: string;
  timestamp: number;
  data?: unknown; // Can contain various types depending on progress stage
}

export interface ExecutionResult {
  success: boolean;
  service: string;
  tool: string;
  data?: unknown; // MCP tool execution result - type varies by tool
  error?: string;
  executionTime: number;
}

export interface OrchestrationResult {
  success: boolean;
  results: ExecutionResult[];
  totalExecutionTime: number;
  progressUpdates: ProgressUpdate[];
  needsClarification?: boolean;
  clarificationQuestion?: string;
}

// ==================== LLM-MCP Orchestrator ====================

export class LLMMCPOrchestrator {
  private toolCache: Map<string, { tools: ToolRegistry; timestamp: number }> = new Map();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    // Initialize orchestrator
  }

  /**
   * Main entry point: Process user query with LLM-driven orchestration
   */
  async processQuery(
    userId: string,
    query: string,
    options?: {
      streaming?: boolean;
      onProgress?: (update: ProgressUpdate) => void;
    }
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const progressUpdates: ProgressUpdate[] = [];

    const emitProgress = (update: ProgressUpdate) => {
      progressUpdates.push(update);
      if (options?.onProgress) {
        options.onProgress(update);
      }
    };

    try {
      // Step 1: Analyze Intent
      emitProgress({
        type: 'analyzing',
        message: 'Analyzing your request...',
        timestamp: Date.now()
      });

      logger.info('LLM-MCP Orchestrator: Processing query', { userId, query });

      // Step 2: Discover Available Tools
      emitProgress({
        type: 'discovering',
        message: 'Checking connected services...',
        timestamp: Date.now()
      });

      const toolRegistry = await this.discoverAvailableTools(userId);
      const serviceCount = Object.keys(toolRegistry).length;
      const totalTools = Object.values(toolRegistry).reduce((sum, tools) => sum + tools.length, 0);

      if (serviceCount === 0) {
        return {
          success: false,
          results: [],
          totalExecutionTime: Date.now() - startTime,
          progressUpdates,
          needsClarification: true,
          clarificationQuestion: 'No services are connected. Please connect Google Calendar, Slack, or other services first.'
        };
      }

      emitProgress({
        type: 'discovering',
        message: `Found ${serviceCount} services with ${totalTools} available commands`,
        timestamp: Date.now(),
        data: { services: Object.keys(toolRegistry), toolCount: totalTools }
      });

      // Step 3: LLM Tool Selection
      emitProgress({
        type: 'selecting',
        message: 'Selecting best commands for your request...',
        timestamp: Date.now()
      });

      const executionPlan = await this.selectTools(query, toolRegistry);

      if (executionPlan.needsClarification) {
        return {
          success: false,
          results: [],
          totalExecutionTime: Date.now() - startTime,
          progressUpdates,
          needsClarification: true,
          clarificationQuestion: executionPlan.clarificationQuestion
        };
      }

      logger.info('LLM selected tools', {
        userId,
        toolCount: executionPlan.selectedTools.length,
        confidence: executionPlan.confidence,
        plan: executionPlan.executionPlan
      });

      // Step 4: Execute Command Chain
      const results: ExecutionResult[] = [];

      for (let i = 0; i < executionPlan.selectedTools.length; i++) {
        const selectedTool = executionPlan.selectedTools[i];

        emitProgress({
          type: 'executing',
          message: `Executing: ${selectedTool.tool} (${i + 1}/${executionPlan.selectedTools.length})`,
          timestamp: Date.now(),
          data: { service: selectedTool.service, tool: selectedTool.tool }
        });

        const result = await this.executeTool(userId, selectedTool);
        results.push(result);

        if (result.success) {
          emitProgress({
            type: 'completed',
            message: `✓ ${selectedTool.tool} completed successfully`,
            timestamp: Date.now(),
            data: result.data
          });
        } else {
          emitProgress({
            type: 'error',
            message: `✗ ${selectedTool.tool} failed: ${result.error}`,
            timestamp: Date.now(),
            data: { error: result.error }
          });

          // Stop chain on error
          break;
        }
      }

      const totalExecutionTime = Date.now() - startTime;
      const successCount = results.filter(r => r.success).length;

      logger.info('LLM-MCP Orchestration completed', {
        userId,
        totalTools: executionPlan.selectedTools.length,
        successCount,
        totalExecutionTime
      });

      return {
        success: successCount > 0,
        results,
        totalExecutionTime,
        progressUpdates
      };

    } catch (error) {
      logger.error('LLM-MCP Orchestration failed', {
        userId,
        query,
        error: (error as Error).message,
        stack: (error as Error).stack
      });

      emitProgress({
        type: 'error',
        message: `Orchestration failed: ${(error as Error).message}`,
        timestamp: Date.now()
      });

      return {
        success: false,
        results: [],
        totalExecutionTime: Date.now() - startTime,
        progressUpdates
      };
    }
  }

  /**
   * Discover available tools from all connected MCPs
   */
  private async discoverAvailableTools(userId: string): Promise<ToolRegistry> {
    // Check cache first
    const cacheKey = `tools:${userId}`;
    const cached = this.toolCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      logger.debug('Using cached tool registry', { userId });
      return cached.tools;
    }

    logger.info('Discovering MCP tools from connected services', { userId });

    const toolRegistry: ToolRegistry = {};

    // Get connected services from ServiceConnection table
    const connections = await prisma.serviceConnection.findMany({
      where: {
        userId,
        mcpConnected: true,
        mcpStatus: 'connected'
      }
    });

    for (const connection of connections) {
      const { provider } = connection;

      try {
        // Get MCP instance
        const mcpInstance = mcpConnectionManagerV2.getMCPInstance(userId, provider);

        if (!mcpInstance) {
          logger.warn('MCP instance not found for provider', { userId, provider });
          continue;
        }

        // Get tools from MCP instance
        let toolsFromMCP: unknown[] = [];

        if (typeof (mcpInstance as any).discoverTools === 'function') {
          toolsFromMCP = await (mcpInstance as any).discoverTools();
        } else if (typeof (mcpInstance as any).listTools === 'function') {
          toolsFromMCP = await (mcpInstance as any).listTools();
        }

        if (!toolsFromMCP || toolsFromMCP.length === 0) {
          logger.warn('No tools discovered for provider', { userId, provider });
          continue;
        }

        // Map provider to service name
        const serviceName = provider === 'google'
          ? 'google_calendar'
          : provider;

        // Convert MCPTool format to LLM-friendly format
        toolRegistry[serviceName] = toolsFromMCP.map(tool => {
          const t = tool as Record<string, unknown>;
          const inputSchema = t.inputSchema as Record<string, unknown> | undefined;
          const properties = inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
          const required = inputSchema?.required as string[] | undefined;

          // Convert JSON Schema to LLM-friendly parameter format
          const parameters = properties
            ? Object.entries(properties).map(([paramName, paramSchema]) => ({
                name: paramName,
                type: (paramSchema.type as string) || 'string',
                required: required?.includes(paramName) || false,
                description: (paramSchema.description as string) || ''
              }))
            : [];

          return {
            name: (t.name || 'unknown') as string,
            description: (t.description || '') as string,
            parameters,
            examples: [] // Could extract from inputSchema examples if available
          };
        });

        logger.debug('Loaded tools for service', {
          userId,
          provider,
          service: serviceName,
          toolCount: toolsFromMCP.length
        });

      } catch (error) {
        logger.error('Failed to load tools for provider', {
          userId,
          provider,
          error: (error as Error).message
        });
      }
    }

    // Cache the result
    this.toolCache.set(cacheKey, {
      tools: toolRegistry,
      timestamp: Date.now()
    });

    logger.info('Tool registry loaded', {
      userId,
      servicesCount: Object.keys(toolRegistry).length,
      totalTools: Object.values(toolRegistry).reduce((sum, tools) => sum + tools.length, 0)
    });

    return toolRegistry;
  }

  /**
   * Use LLM to select tools and build execution plan
   */
  private async selectTools(
    query: string,
    toolRegistry: ToolRegistry
  ): Promise<ExecutionPlan> {
    const systemPrompt = this.buildSystemPrompt(toolRegistry);
    const userPrompt = `User Query: "${query}"\n\nAnalyze this query and select appropriate tools to execute.`;

    logger.info('Sending tool selection request to LLM', {
      query,
      availableServices: Object.keys(toolRegistry),
      totalTools: Object.values(toolRegistry).reduce((sum, tools) => sum + tools.length, 0)
    });

    try {
      const response = await llmService.execute({
        systemPrompt,
        userPrompt,
        taskType: LLMTaskType.FAST, // GPT-4.1-nano for fast intent classification
        requiresJSON: true
      });

      const parsedPlan = JSON.parse(response.content);

      logger.info('LLM tool selection completed', {
        selectedToolCount: parsedPlan.selectedTools?.length || 0,
        confidence: parsedPlan.confidence,
        needsClarification: parsedPlan.needsClarification
      });

      return {
        selectedTools: parsedPlan.selectedTools || [],
        executionPlan: parsedPlan.executionPlan || 'Execute selected tools',
        confidence: parsedPlan.confidence || 0,
        needsClarification: parsedPlan.needsClarification || false,
        clarificationQuestion: parsedPlan.clarificationQuestion
      };

    } catch (error) {
      logger.error('LLM tool selection failed', {
        error: (error as Error).message
      });

      // Fallback: return clarification needed
      return {
        selectedTools: [],
        executionPlan: '',
        confidence: 0,
        needsClarification: true,
        clarificationQuestion: `I couldn't understand your request. Could you please rephrase? Error: ${(error as Error).message}`
      };
    }
  }

  /**
   * Build system prompt for LLM with available tools
   */
  private buildSystemPrompt(toolRegistry: ToolRegistry): string {
    const toolsJSON = JSON.stringify(toolRegistry, null, 2);

    return `You are an intelligent MCP tool orchestrator. Your job is to:
1. Understand user intent from natural language queries
2. Select the most appropriate MCP tools to fulfill the request
3. Extract parameters from the query
4. Build a sequential execution plan
5. Output structured JSON

Available MCP Tools:
${toolsJSON}

Rules:
- Only use tools that are explicitly available in the tool registry
- Prefer single tools over chains when possible
- Extract all parameters from user query (use natural language for times like "tomorrow 3pm")
- If the query is ambiguous or missing critical information, set needsClarification=true
- Return confidence score (0-1) based on how well you understand the request
- For chained commands (e.g., "create event AND send slack message"), include multiple tools in selectedTools array

Output Format (MUST be valid JSON):
{
  "selectedTools": [
    {
      "service": "google_calendar",
      "tool": "create_event",
      "params": {
        "summary": "Meeting with John",
        "startTime": "tomorrow at 3pm"
      },
      "reasoning": "User wants to schedule a meeting"
    }
  ],
  "executionPlan": "Create a calendar event for tomorrow at 3pm with John",
  "confidence": 0.95,
  "needsClarification": false,
  "clarificationQuestion": null
}

IMPORTANT:
- Return ONLY valid JSON, no additional text
- If you need clarification, set needsClarification=true and provide a specific question
- Always include confidence score
- Be precise with parameter extraction`;
  }

  /**
   * Execute a single tool via MCPConnectionManagerV2
   */
  private async executeTool(
    userId: string,
    selectedTool: SelectedTool
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Map service name to provider for lookup
      const providerMap: Record<string, string> = {
        'google_calendar': 'google',
        'slack': 'slack',
        'github': 'github',
        'notion': 'notion'
      };

      const provider = providerMap[selectedTool.service] || selectedTool.service;

      // Check if MCP is connected
      if (!mcpConnectionManagerV2.isConnected(userId, provider)) {
        throw new Error(`MCP not connected for provider: ${provider}. Please connect the service first.`);
      }

      // Execute tool via MCPConnectionManagerV2
      const result = await mcpConnectionManagerV2.callTool(
        userId,
        provider,
        selectedTool.tool,
        selectedTool.params
      );

      logger.info('Tool executed successfully', {
        userId,
        service: selectedTool.service,
        tool: selectedTool.tool,
        provider,
        executionTime: Date.now() - startTime
      });

      return {
        success: true,
        service: selectedTool.service,
        tool: selectedTool.tool,
        data: result,
        executionTime: Date.now() - startTime
      };

    } catch (error) {
      logger.error('Tool execution failed', {
        userId,
        service: selectedTool.service,
        tool: selectedTool.tool,
        error: (error as Error).message
      });

      return {
        success: false,
        service: selectedTool.service,
        tool: selectedTool.tool,
        error: (error as Error).message,
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * Invalidate tool cache for a user
   */
  invalidateCache(userId: string): void {
    const cacheKey = `tools:${userId}`;
    this.toolCache.delete(cacheKey);
    logger.debug('Tool cache invalidated', { userId });
  }

  /**
   * Invalidate all caches
   */
  clearAllCaches(): void {
    this.toolCache.clear();
    logger.info('All tool caches cleared');
  }
}

// Singleton export
export const llmMCPOrchestrator = new LLMMCPOrchestrator();

