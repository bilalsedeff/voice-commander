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

import { mcpConnectionManagerV2 } from './mcp-connection-manager-v2';
import { llmService, LLMTaskType } from './llm-service';
import logger from '../utils/logger';
import prisma from '../config/database';
import { conversationSessionManager } from './conversation-session-manager';

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
  iterateOver?: string; // e.g., "{{results[0].data.events}}" - execute once per item
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
   * Resolve template references in parameters
   * Supports: {{results[0].data.events}}, {{results[0].data.events[0].id}}, etc.
   */
  private resolveParams(
    params: Record<string, unknown>,
    results: ExecutionResult[]
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.includes('{{')) {
        // Extract template pattern
        const match = value.match(/\{\{results\[(\d+)\]\.(.+?)\}\}/);
        if (match) {
          const resultIndex = parseInt(match[1]);
          const path = match[2];

          if (resultIndex < results.length) {
            // Navigate the path (e.g., "data.events[0].id")
            const pathParts = path.split(/\.|\[|\]/).filter(Boolean);
            let resolvedValue: unknown = results[resultIndex];

            for (const part of pathParts) {
              if (resolvedValue && typeof resolvedValue === 'object') {
                resolvedValue = (resolvedValue as Record<string, unknown>)[part];
              }
            }

            resolved[key] = resolvedValue;
          } else {
            resolved[key] = value; // Keep original if index out of bounds
          }
        } else {
          resolved[key] = value;
        }
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
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
      sessionId?: string; // ADD: Session ID for conversation context
    }
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const progressUpdates: ProgressUpdate[] = [];

    const emitProgress = (update: ProgressUpdate) => {
      progressUpdates.push(update);
      logger.info('Orchestrator: emitProgress called', {
        update,
        hasCallback: !!options?.onProgress,
        streaming: options?.streaming
      });
      if (options?.onProgress) {
        logger.info('Orchestrator: Calling onProgress callback');
        options.onProgress(update);
      } else {
        logger.warn('Orchestrator: No onProgress callback available');
      }
    };

    try {
      // Step 1: Analyze Intent
      emitProgress({
        type: 'analyzing',
        message: 'Analyzing your request...',
        timestamp: Date.now()
      });

      logger.info('LLM-MCP Orchestrator: Processing query', {
        userId,
        query,
        hasSession: !!options?.sessionId
      });

      // Get conversation context if session provided
      let conversationContext = '';
      if (options?.sessionId) {
        conversationContext = await conversationSessionManager.getContext(options.sessionId);
        logger.debug('Retrieved conversation context', {
          sessionId: options.sessionId,
          contextLength: conversationContext.length
        });
      }

      // Step 1.5: Quick Intent Classification (skip tools for simple queries)
      const requiresTools = await this.quickIntentCheck(query, conversationContext);

      if (!requiresTools) {
        // Simple conversational query - no tools needed
        logger.info('Query does not require tools - conversational response', { query });

        // Generate conversational response
        const { naturalResponseGenerator } = await import('./natural-response-generator');
        const conversationalResponse = await naturalResponseGenerator.generateConversationalResponse(
          query,
          conversationContext
        );

        return {
          success: true,
          results: [{
            success: true,
            service: 'conversational',
            tool: 'chat',
            data: {
              query,
              response: conversationalResponse,
              type: 'conversational'
            },
            executionTime: Date.now() - startTime
          }],
          totalExecutionTime: Date.now() - startTime,
          progressUpdates
        };
      }

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

      const executionPlan = await this.selectTools(query, toolRegistry, conversationContext);

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

      // Step 4: Execute Command Chain with result references
      const results: ExecutionResult[] = [];

      for (let i = 0; i < executionPlan.selectedTools.length; i++) {
        const selectedTool = executionPlan.selectedTools[i];

        // Check if this tool needs to iterate over previous results
        if (selectedTool.iterateOver) {
          // Resolve the iteration array from previous results
          const iterationPath = selectedTool.iterateOver.match(/\{\{results\[(\d+)\]\.(.+?)\}\}/);
          if (!iterationPath) {
            logger.error('Invalid iterateOver path', { iterateOver: selectedTool.iterateOver });
            continue;
          }

          const resultIndex = parseInt(iterationPath[1]);
          const path = iterationPath[2];

          if (resultIndex >= results.length) {
            logger.error('Result index out of bounds for iteration', { resultIndex, resultsLength: results.length });
            continue;
          }

          // Get the array to iterate over
          const pathParts = path.split(/\.|\[|\]/).filter(Boolean);
          let iterationArray: unknown = results[resultIndex];

          for (const part of pathParts) {
            if (iterationArray && typeof iterationArray === 'object') {
              iterationArray = (iterationArray as Record<string, unknown>)[part];
            }
          }

          if (!Array.isArray(iterationArray)) {
            results.push({
              success: false,
              service: selectedTool.service,
              tool: selectedTool.tool,
              error: 'Iteration target is not an array',
              executionTime: 0
            });
            break;
          }

          if (iterationArray.length === 0) {
            results.push({
              success: false,
              service: selectedTool.service,
              tool: selectedTool.tool,
              error: 'No items to iterate over',
              executionTime: 0
            });
            emitProgress({
              type: 'error',
              message: `✗ No items found to process`,
              timestamp: Date.now()
            });
            break;
          }

          // Execute tool for each item in the array
          const iterationResults: ExecutionResult[] = [];
          let successCount = 0;

          for (let itemIndex = 0; itemIndex < iterationArray.length; itemIndex++) {
            const item = iterationArray[itemIndex];

            // Resolve params with current item context
            // IMPORTANT: Preserve LLM-provided params, merge with item data
            const baseParams = { ...selectedTool.params }; // LLM's intended params
            const itemData = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};

            const resolvedParams = this.resolveParams(
              { ...baseParams, _currentItem: item },
              results
            );

            // Replace _currentItem refs with actual item fields
            for (const [key, value] of Object.entries(resolvedParams)) {
              if (typeof value === 'string' && value.includes('_currentItem')) {
                const fieldMatch = value.match(/_currentItem\.(.+)/);
                if (fieldMatch) {
                  resolvedParams[key] = itemData[fieldMatch[1]];
                }
              } else if (key === '_currentItem') {
                delete resolvedParams[key];
              }
            }

            // Merge item data, but DON'T overwrite LLM's explicit params
            // This ensures: eventId from item, startTime from LLM params
            Object.assign(resolvedParams, {
              ...itemData,      // Item data (eventId, summary, etc.)
              ...baseParams     // LLM params override (startTime, endTime, etc.)
            });

            // Map common field names for Google Calendar compatibility
            // list_events returns "id", but update_event/delete_event expect "eventId"
            if ('id' in itemData && !('eventId' in resolvedParams)) {
              resolvedParams.eventId = itemData.id;
            }

            emitProgress({
              type: 'executing',
              message: `Executing: ${selectedTool.tool} (${itemIndex + 1}/${iterationArray.length})`,
              timestamp: Date.now(),
              data: { service: selectedTool.service, tool: selectedTool.tool, item }
            });

            const itemResult = await this.executeTool(userId, {
              ...selectedTool,
              params: resolvedParams
            });

            iterationResults.push(itemResult);

            if (itemResult.success) {
              successCount++;
              emitProgress({
                type: 'executing',
                message: `✓ ${selectedTool.tool} (${successCount}/${iterationArray.length})`,
                timestamp: Date.now()
              });
            }
          }

          // Aggregate iteration results
          const aggregatedResult: ExecutionResult = {
            success: successCount > 0,
            service: selectedTool.service,
            tool: selectedTool.tool,
            data: {
              iterationCount: iterationArray.length,
              successCount,
              results: iterationResults
            },
            executionTime: iterationResults.reduce((sum, r) => sum + r.executionTime, 0),
            error: successCount === 0 ? 'All iteration executions failed' : undefined
          };

          results.push(aggregatedResult);

          emitProgress({
            type: 'completed',
            message: `✓ ${selectedTool.tool}: ${successCount}/${iterationArray.length} succeeded`,
            timestamp: Date.now(),
            data: aggregatedResult.data
          });

          if (successCount === 0) {
            break; // Stop chain if all iterations failed
          }

          continue;
        }

        // Normal execution (no iteration)
        emitProgress({
          type: 'executing',
          message: `Executing: ${selectedTool.tool} (${i + 1}/${executionPlan.selectedTools.length})`,
          timestamp: Date.now(),
          data: { service: selectedTool.service, tool: selectedTool.tool }
        });

        // Resolve parameter references
        const resolvedParams = this.resolveParams(selectedTool.params, results);

        const result = await this.executeTool(userId, {
          ...selectedTool,
          params: resolvedParams
        });

        // Smart retry if list/search returned 0 results and context exists
        if (result.success &&
            (selectedTool.tool.includes('list') || selectedTool.tool.includes('search')) &&
            conversationContext &&
            result.data &&
            typeof result.data === 'object' &&
            'count' in result.data &&
            (result.data.count as number) === 0) {

          logger.warn('Search returned 0 results, attempting context-aware retry', {
            userId,
            service: selectedTool.service,
            tool: selectedTool.tool,
            originalParams: resolvedParams
          });

          // Retry with broader time range
          const retryResult = await this.smartRetrySearch(
            userId,
            selectedTool,
            resolvedParams,
            conversationContext
          );

          if (retryResult && retryResult.success && retryResult.data &&
              typeof retryResult.data === 'object' &&
              'count' in retryResult.data &&
              (retryResult.data.count as number) > 0) {
            logger.info('Smart retry found results', {
              count: retryResult.data.count,
              originalParams: resolvedParams
            });
            results.push(retryResult);

            emitProgress({
              type: 'completed',
              message: `✓ ${selectedTool.tool} completed (with context retry)`,
              timestamp: Date.now(),
              data: retryResult.data
            });
            continue;
          }
        }

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

    // 🔧 FIX: Get OAuth-connected services (not MCP status)
    // OAuth connection means we have tokens, MCP will be started on-demand
    const connections = await prisma.serviceConnection.findMany({
      where: {
        userId,
        connected: true  // ✅ Only check OAuth connection, not MCP status
      }
    });

    logger.debug('Found OAuth-connected services', {
      userId,
      providers: connections.map(c => c.provider)
    });

    for (const connection of connections) {
      const { provider } = connection;

      try {
        // 🔧 FIX: Check if MCP is running, if not start it
        let mcpInstance = mcpConnectionManagerV2.getMCPInstance(userId, provider);

        if (!mcpInstance) {
          logger.info('MCP not running, starting it now', { userId, provider });

          // Auto-start MCP for OAuth-connected service
          const mcpResult = await mcpConnectionManagerV2.connectMCPServer(userId, provider);

          if (!mcpResult.success) {
            logger.error('Failed to start MCP', {
              userId,
              provider,
              error: mcpResult.error
            });
            continue;
          }

          // Get the newly created instance
          mcpInstance = mcpConnectionManagerV2.getMCPInstance(userId, provider);

          if (!mcpInstance) {
            logger.error('MCP started but instance not found', { userId, provider });
            continue;
          }

          logger.info('MCP auto-started successfully', {
            userId,
            provider,
            toolsCount: mcpResult.toolsCount
          });
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

        // Use provider as service name directly (LLM will learn the available services)
        const serviceName = provider;

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
          error: (error as Error).message,
          stack: (error as Error).stack
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
   * Smart retry for failed searches - broadens search based on conversation context
   */
  private async smartRetrySearch(
    userId: string,
    originalTool: SelectedTool,
    originalParams: Record<string, unknown>,
    conversationContext: string
  ): Promise<ExecutionResult | null> {
    try {
      // Extract mentions of events/meetings from recent context
      const contextLines = conversationContext.split('\n');
      const recentAssistantResponses = contextLines
        .filter(line => line.startsWith('Assistant:'))
        .slice(-3);

      // Check if assistant recently created/mentioned an event
      const mentionedEvent = recentAssistantResponses.some(line =>
        /created|scheduled|added|meeting|event/i.test(line)
      );

      if (!mentionedEvent) {
        logger.debug('No recent event mentions in context, skipping retry');
        return null;
      }

      // Broaden search - remove restrictive time filters or expand them
      const broadenedParams: Record<string, unknown> = { ...originalParams };

      // If timeMin/timeMax exist, expand to next 7 days
      if ('timeMin' in broadenedParams || 'timeMax' in broadenedParams) {
        broadenedParams.timeMin = 'today';
        broadenedParams.timeMax = 'in 7 days';
        logger.info('Broadening time range for retry', {
          original: { timeMin: originalParams.timeMin, timeMax: originalParams.timeMax },
          broadened: { timeMin: broadenedParams.timeMin, timeMax: broadenedParams.timeMax }
        });
      }

      // Execute broadened search
      return await this.executeTool(userId, {
        ...originalTool,
        params: broadenedParams
      });
    } catch (error) {
      logger.error('Smart retry failed', {
        error: (error as Error).message,
        userId,
        tool: originalTool.tool
      });
      return null;
    }
  }

  /**
   * Use LLM to select tools and build execution plan
   */
  private async selectTools(
    query: string,
    toolRegistry: ToolRegistry,
    conversationContext?: string
  ): Promise<ExecutionPlan> {
    const systemPrompt = this.buildSystemPrompt(toolRegistry, conversationContext);
    const userPrompt = `User Query: "${query}"\n\nAnalyze this query and select appropriate tools to execute.`;

    logger.info('Sending tool selection request to LLM', {
      query,
      availableServices: Object.keys(toolRegistry),
      totalTools: Object.values(toolRegistry).reduce((sum, tools) => sum + tools.length, 0),
      hasContext: !!conversationContext,
      contextLength: conversationContext?.length || 0,
      contextPreview: conversationContext?.substring(0, 150) || 'none'
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
  private buildSystemPrompt(toolRegistry: ToolRegistry, conversationContext?: string): string {
    const toolsJSON = JSON.stringify(toolRegistry, null, 2);

    let prompt = `You are an intelligent MCP tool orchestrator. Your job is to:
1. Understand user intent from natural language queries
2. Select the most appropriate MCP tools to fulfill the request
3. Extract parameters from the query
4. Build a sequential execution plan
5. Output structured JSON`;

    // Add conversation context if available
    if (conversationContext) {
      prompt += `\n\n**Previous Conversation Context:**
${conversationContext}

**CRITICAL CONTEXT RULES (READ CAREFULLY):**
1. **Referential Understanding**: When user says "the meeting", "that event", "it", "the one", they refer to items from the conversation above
2. **Temporal Relativity**: Time words in the current query are RELATIVE TO NOW, not to when items were created
   - User says "the meeting for today" → They might mean "the meeting I just asked you to create" (check context!)
   - User says "update it to 5PM" → Find what "it" refers to in previous turns
3. **Context-First Search Strategy**: To modify/delete items mentioned in previous turns:
   - FIRST: Extract identifying details from conversation history (summary, attendees, time mentioned in creation)
   - THEN: Search using those context details, NOT literal interpretation of current query
   - Example: Previous turn created "meeting for tomorrow at 3pm"
     → Current query "the meeting you created for today should be 5pm"
     → WRONG: Search today's meetings (finds nothing)
     → RIGHT: Search for meeting created in previous turn (use summary/time from context)
4. **Action Attribution**: "you created", "you scheduled", "you added" → Search for items from my most recent actions
5. **Pronouns & References**: "it", "that one", "the first one", "yes/no" → Resolve using conversation history

**EXAMPLE - Correct Context Usage:**
Context shows:
  User: "Create meeting for tomorrow at 3pm"
  Assistant: "Created meeting 'empty meeting' for tomorrow at 3pm"

Current query: "Update the meeting you created for today to 5pm"

WRONG Interpretation ❌:
  Tool: list_events, params: { timeMin: "today 00:00", timeMax: "today 23:59" }
  Reason: Literal reading of "today" - ignores context

RIGHT Interpretation ✅:
  Tool: list_events, params: { timeMin: "tomorrow 00:00", timeMax: "tomorrow 23:59", summary: "empty meeting" }
  OR: list_events, params: { timeMin: "today", timeMax: "next week" }  // Broader search
  Reason: Uses context to understand "the meeting you created" refers to the meeting from previous turn

Use this context to understand ALL references, pronouns, and follow-ups.`;
    }

    prompt += `\n\nAvailable MCP Tools:
${toolsJSON}

Rules:
- **CRITICAL**: Only use services and tools that are explicitly available in the tool registry above
- The "service" field in your response MUST exactly match a service name from the registry
- Extract all parameters from user query (use natural language for times like "tomorrow 3pm")
- **needsClarification**: ONLY set to true if ABSOLUTELY NECESSARY missing information that CANNOT be inferred from context
  * DO NOT ask for clarification when context provides the answer
  * DO NOT ask for clarification when you can search/list to find items
  * Example: User says "update the meeting" with context showing a meeting → DON'T clarify, just search and update
  * Example: User says "update it" with NO context about what "it" is → DO clarify
- Return confidence score (0-1) based on how well you understand the request
- For chained commands, include multiple tools in selectedTools array
- **BULK OPERATIONS**: For delete/update multiple items, use the iteration pattern:
  * Step 1: Use a list/query tool to find the target items
  * Step 2: Use delete/update tool with "iterateOver" field pointing to the array from Step 1
  * The "iterateOver" field enables automatic iteration over array results
- **Parameter References**: Use {{results[INDEX].data.FIELD}} to reference previous results
  * Example: {{results[0].data.events}} references the events array from the first tool
- **DO NOT** hardcode service names - always use what's in the registry
- **USE CONTEXT**: When context mentions items, actions, or details → use that information to build tool calls

Output Format (MUST be valid JSON):

IMPORTANT NOTES:
- "service" field MUST exactly match the provider names from the Available MCP Tools list above
- Do NOT invent service names - only use services that are explicitly listed
- Tool names MUST match exactly what's available in the tool registry for that service

Example 1 - Simple create operation:
{
  "selectedTools": [
    {
      "service": "google",
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

Example 2 - BULK DELETE operation (with iteration):
{
  "selectedTools": [
    {
      "service": "google",
      "tool": "list_events",
      "params": {
        "timeMin": "tomorrow at 00:00",
        "timeMax": "tomorrow at 23:59"
      },
      "reasoning": "First, find all meetings scheduled for tomorrow"
    },
    {
      "service": "google",
      "tool": "delete_event",
      "params": {},  // Empty params OK - eventId comes from iteration
      "iterateOver": "{{results[0].data.events}}",
      "reasoning": "Delete each event found in the list"
    }
  ],
  "executionPlan": "List tomorrow's events, then delete each one",
  "confidence": 0.9,
  "needsClarification": false,
  "clarificationQuestion": null
}

Example 2b - BULK UPDATE operation (params + iteration):
{
  "selectedTools": [
    {
      "service": "google",
      "tool": "list_events",
      "params": {
        "timeMin": "today",
        "timeMax": "next week"
      },
      "reasoning": "Find the meeting to update"
    },
    {
      "service": "google",
      "tool": "update_event",
      "params": {
        "startTime": "tomorrow 5pm",  // NEW time to set
        "endTime": "tomorrow 6pm"      // NEW end time
      },
      "iterateOver": "{{results[0].data.events}}",
      "reasoning": "Update each event to new time (eventId comes from iteration, new times from params)"
    }
  ],
  "executionPlan": "Find meetings, update their time to tomorrow 5pm",
  "confidence": 0.9,
  "needsClarification": false,
  "clarificationQuestion": null
}

Example 3 - COMPLEX MULTI-STEP (list, delete, then send Slack DMs):
{
  "selectedTools": [
    {
      "service": "google",
      "tool": "list_events",
      "params": {
        "timeMin": "tomorrow 3pm",
        "timeMax": "tomorrow 4pm"
      },
      "reasoning": "Find meetings between 3-4 PM tomorrow"
    },
    {
      "service": "google",
      "tool": "delete_event",
      "params": {},
      "iterateOver": "{{results[0].data.events}}",
      "reasoning": "Delete each meeting found"
    },
    {
      "service": "slack",
      "tool": "send_direct_message",
      "params": {
        "message": "I had to reschedule our meeting tomorrow due to a PM meeting. Sorry for the inconvenience!"
      },
      "iterateOver": "{{results[0].data.events}}",
      "reasoning": "Send DM to each participant's email"
    }
  ],
  "executionPlan": "List meetings, delete them, then notify participants via Slack",
  "confidence": 0.85,
  "needsClarification": false,
  "clarificationQuestion": null
}

IMPORTANT:
- Return ONLY valid JSON, no additional text
- If you need clarification, set needsClarification=true and provide a specific question
- Always include confidence score
- Be precise with parameter extraction`;

    return prompt;
  }

  /**
   * LLM Router: Single fast classification - conversational vs action
   * Based on 2025 best practices for agentic workflows
   */
  private async quickIntentCheck(query: string, conversationContext?: string): Promise<boolean> {
    const systemPrompt = `You are a fast intent router for a voice assistant. Classify the user's query into ONE of two categories:

1. **CONVERSATIONAL**: Greetings, thanks, questions about capabilities, casual chat, acknowledgments
2. **ACTION**: Any request to DO something - create, update, delete, search, send, schedule, cancel, etc.

${conversationContext ? `\n**Previous Conversation:**\n${conversationContext}\n` : ''}

**Classification Rules:**
- "Hello", "Hi", "Hey", "Good morning" → CONVERSATIONAL
- "Thanks", "Thank you" → CONVERSATIONAL
- "How are you?", "What can you do?" → CONVERSATIONAL
- "Yes", "Yeah", "Sure", "Do it" (confirming an action) → ACTION
- "You didn't do it", "That's wrong" (complaint about incomplete action) → ACTION
- ANY request with action verbs (create, update, find, schedule, etc.) → ACTION
- Follow-ups to incomplete actions → ACTION

**Current Query:** "${query}"

Respond with JSON only: { "type": "conversational" | "action", "confidence": 0.0-1.0, "reasoning": "brief explanation" }`;

    try {
      const response = await llmService.execute({
        systemPrompt,
        userPrompt: query,
        taskType: LLMTaskType.FAST, // Use fast model (gpt-4.1-nano)
        requiresJSON: true
      });

      const result = JSON.parse(response.content);
      const requiresTools = result.type === 'action';

      logger.info('🔀 Intent Router Decision', {
        query,
        classification: result.type,
        requiresTools,
        confidence: result.confidence,
        reasoning: result.reasoning
      });

      return requiresTools;

    } catch (error) {
      logger.error('Intent routing failed, defaulting to ACTION', {
        error: (error as Error).message
      });
      return true; // Default to action (safe fallback)
    }
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
      // Use service name as provider directly (no hardcoded mapping)
      const provider = selectedTool.service;

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

      // 🔧 FIX: Unwrap MCP result if it has nested {success, data} structure
      // Most MCPs return {success: true, data: {...}} - we want just the inner data
      const unwrappedData = (result && typeof result === 'object' && 'data' in result && 'success' in result)
        ? (result as { success: boolean; data: unknown }).data
        : result;

      logger.info('Tool executed successfully', {
        userId,
        service: selectedTool.service,
        tool: selectedTool.tool,
        params: selectedTool.params,
        resultDataPreview: JSON.stringify(unwrappedData).substring(0, 500),
        provider,
        executionTime: Date.now() - startTime
      });

      return {
        success: true,
        service: selectedTool.service,
        tool: selectedTool.tool,
        data: unwrappedData,
        executionTime: Date.now() - startTime
      };

    } catch (error) {
      logger.error('Tool execution failed', {
        userId,
        service: selectedTool.service,
        tool: selectedTool.tool,
        params: selectedTool.params,
        error: (error as Error).message,
        stack: (error as Error).stack
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

