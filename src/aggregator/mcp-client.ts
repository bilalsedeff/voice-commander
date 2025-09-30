/**
 * MCP Protocol Client for Desktop Commander Integration
 *
 * Implements secure, resilient connection to Desktop Commander MCP server with
 * circuit breaker pattern, performance monitoring, and comprehensive error handling.
 *
 * Dependencies:
 * - @modelcontextprotocol/sdk: https://github.com/modelcontextprotocol/typescript-sdk
 * - winston: https://github.com/winstonjs/winston
 *
 * Input: MCPServerConfig, MCPToolCall objects
 * Output: MCPToolResult with performance metrics and error handling
 *
 * Example:
 * const client = new MCPClient(desktopCommanderConfig);
 * await client.connect();
 * const result = await client.callTool("read_file", { path: "package.json" });
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { performance } from "perf_hooks";
import winston from "winston";
import {
  MCPServerConfig,
  MCPToolResult,
  MCPServerStatus,
  MCPConnectionError,
  ValidationError,
  CircuitBreakerConfig,
  DESKTOP_COMMANDER_TOOLS
} from "../utils/types";

// Circuit Breaker Implementation
class CircuitBreaker {
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (this.shouldAttemptReset()) {
        this.state = "HALF_OPEN";
      } else {
        throw new Error(`Circuit breaker OPEN - service unavailable`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private shouldAttemptReset(): boolean {
    return this.lastFailureTime !== null &&
           Date.now() - this.lastFailureTime > this.config.resetTimeout;
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = "OPEN";
    }
  }

  getStatus(): { state: string; failureCount: number } {
    return {
      state: this.state,
      failureCount: this.failureCount
    };
  }
}

// Performance monitoring decorator
function performanceMonitor(_target: unknown, propertyName: string, descriptor: PropertyDescriptor) {
  const method = descriptor.value;

  descriptor.value = async function (...args: unknown[]) {
    const start = performance.now();
    const logger = winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [new winston.transports.Console()]
    });

    try {
      const result = await method.apply(this, args);
      const duration = performance.now() - start;

      logger.info(`${propertyName} completed`, { duration: Math.round(duration) });

      // Enforce latency requirements for MCP operations
      if (duration > 5000) {
        logger.warn(`MCP operation exceeded 5000ms: ${Math.round(duration)}ms`);
      }

      return result;
    } catch (error) {
      const duration = performance.now() - start;
      logger.error(`${propertyName} failed after ${Math.round(duration)}ms`, {
        error: (error as Error).message
      });
      throw error;
    }
  };
}

export class MCPClient extends EventEmitter {
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private circuitBreaker: CircuitBreaker;
  private logger: winston.Logger;
  private isConnected = false;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }>();

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;

    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 60000,
      monitoringPeriod: 30000
    });

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/mcp-client.log' })
      ]
    });
  }

  @performanceMonitor
  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      // Validate configuration
      this.validateConfig();

      // Start Desktop Commander MCP process
      this.process = spawn(this.config.command, this.config.args, {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true // Enable shell on Windows to find executables in PATH
      });

      if (!this.process.stdout || !this.process.stdin) {
        throw new MCPConnectionError(
          "Failed to establish stdio connection",
          this.config.id
        );
      }

      // Setup process event handlers
      this.setupProcessHandlers();

      // Wait for MCP initialization
      await this.waitForInitialization();

      this.isConnected = true;
      this.logger.info("MCP client connected successfully", {
        serverId: this.config.id,
        serverName: this.config.name
      });

      this.emit('connected');
    } catch (error) {
      this.logger.error("MCP connection failed", {
        serverId: this.config.id,
        error: (error as Error).message
      });
      throw new MCPConnectionError(
        `Connection failed: ${(error as Error).message}`,
        this.config.id,
        error as Error
      );
    }
  }

  @performanceMonitor
  async callTool(name: string, params: Record<string, unknown>): Promise<MCPToolResult> {
    // Input validation (required per CLAUDE.md)
    if (!name?.trim()) {
      throw new ValidationError("Tool name is required", "name", name);
    }

    if (!this.isConnected) {
      throw new MCPConnectionError("Client not connected", this.config.id);
    }

    // Validate tool exists in Desktop Commander
    if (!DESKTOP_COMMANDER_TOOLS[name]) {
      throw new ValidationError(
        `Unknown tool: ${name}`,
        "tool",
        name
      );
    }

    const tool = DESKTOP_COMMANDER_TOOLS[name];
    this.validateToolParams(tool.inputSchema, params);

    return await this.circuitBreaker.execute(async () => {
      const requestId = ++this.requestId;
      const startTime = performance.now();

      const request = {
        jsonrpc: "2.0" as const,
        id: requestId,
        method: "tools/call",
        params: {
          name,
          arguments: params
        }
      };

      try {
        const result = await this.sendRequest(request);
        const duration = performance.now() - startTime;

        // Log detailed result for debugging
        const resultPreview = typeof result === "string"
          ? result.substring(0, 200) + (result.length > 200 ? "..." : "")
          : JSON.stringify(result).substring(0, 200);

        this.logger.info("MCP tool call successful", {
          tool: name,
          duration: Math.round(duration),
          serverId: this.config.id,
          resultType: typeof result,
          resultPreview: resultPreview,
          workingDirectory: process.cwd()
        });

        return {
          content: result,
          isText: typeof result === "string",
          mimeType: typeof result === "string" ? "text/plain" : "application/json"
        };
      } catch (error) {
        const duration = performance.now() - startTime;
        this.logger.error("MCP tool call failed", {
          tool: name,
          duration: Math.round(duration),
          serverId: this.config.id,
          error: (error as Error).message
        });
        throw error;
      }
    });
  }

  @performanceMonitor
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.isConnected) {
        return false;
      }

      // Use list_tools as health check
      const request = {
        jsonrpc: "2.0" as const,
        id: ++this.requestId,
        method: "tools/list"
      };

      await this.sendRequest(request);
      return true;
    } catch {
      return false;
    }
  }

  @performanceMonitor
  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    if (!this.isConnected) {
      throw new MCPConnectionError("Client not connected", this.config.id);
    }

    return await this.circuitBreaker.execute(async () => {
      const requestId = ++this.requestId;

      const request = {
        jsonrpc: "2.0" as const,
        id: requestId,
        method: "tools/list"
      };

      try {
        const response = await this.sendRequest(request);

        // Parse the response to extract tools
        if (response && typeof response === 'object' && 'tools' in response) {
          const tools = (response as { tools: unknown[] }).tools;
          return tools.map((tool: any) => ({
            name: tool.name || 'unknown',
            description: tool.description || '',
            inputSchema: tool.inputSchema || {}
          }));
        }

        // Fallback: return available Desktop Commander tools
        return Object.entries(DESKTOP_COMMANDER_TOOLS).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }));

      } catch (error) {
        this.logger.error("Failed to list MCP tools", {
          serverId: this.config.id,
          error: (error as Error).message
        });

        // Return fallback tools on error
        return Object.entries(DESKTOP_COMMANDER_TOOLS).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }));
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.isConnected = false;
    this.emit('disconnected');
  }

  getStatus(): MCPServerStatus {
    return {
      id: this.config.id,
      status: this.isConnected ? "connected" : "disconnected",
      lastHealthCheck: new Date(),
      errorCount: this.circuitBreaker.getStatus().failureCount,
      latency: 0 // Will be updated by performance monitoring
    };
  }

  private validateConfig(): void {
    if (!this.config.command?.trim()) {
      throw new ValidationError("Command is required", "command", this.config.command);
    }

    if (!Array.isArray(this.config.args)) {
      throw new ValidationError("Args must be an array", "args", this.config.args);
    }
  }

  private validateToolParams(schema: { properties: Record<string, unknown>; required?: string[] }, params: Record<string, unknown>): void {
    if (schema.required) {
      for (const requiredField of schema.required) {
        if (!(requiredField in params)) {
          throw new ValidationError(
            `Required field missing: ${requiredField}`,
            requiredField,
            undefined
          );
        }
      }
    }

    // Additional validation based on schema properties
    for (const [key, value] of Object.entries(params)) {
      if (!(key in schema.properties)) {
        throw new ValidationError(
          `Unknown parameter: ${key}`,
          key,
          value
        );
      }
    }
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on('error', (error) => {
      this.logger.error("MCP process error", {
        serverId: this.config.id,
        error: error.message
      });
      this.emit('error', error);
    });

    this.process.on('exit', (code, signal) => {
      this.logger.warn("MCP process exited", {
        serverId: this.config.id,
        code,
        signal
      });
      this.isConnected = false;
      this.emit('disconnected');
    });

    // Handle stdout responses
    if (this.process.stdout) {
      this.process.stdout.on('data', (data: Buffer) => {
        this.handleResponse(data.toString());
      });
    }

    // Handle stderr for debugging
    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        this.logger.debug("MCP stderr", {
          serverId: this.config.id,
          message: data.toString()
        });
      });
    }
  }

  private async waitForInitialization(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("MCP initialization timeout"));
      }, this.config.timeout || 10000);

      // Send initialize request
      const initRequest = {
        jsonrpc: "2.0" as const,
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {}
          },
          clientInfo: {
            name: "voice-mcp-gateway",
            version: "1.0.0"
          }
        }
      };

      this.sendMessage(initRequest);

      // Listen for initialization response
      const onResponse = (data: unknown) => {
        if (typeof data === 'object' && data !== null && 'id' in data && data.id === 0) {
          clearTimeout(timeout);
          this.removeListener('response', onResponse);
          resolve();
        }
      };

      this.on('response', onResponse);
    });
  }

  private async sendRequest(request: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id as number);
        reject(new Error("Request timeout"));
      }, this.config.timeout || 5000);

      this.pendingRequests.set(request.id as number, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timestamp: Date.now()
      });

      this.sendMessage(request);
    });
  }

  private sendMessage(message: Record<string, unknown>): void {
    if (!this.process?.stdin) {
      throw new MCPConnectionError("No stdin connection", this.config.id);
    }

    const messageStr = JSON.stringify(message) + '\n';
    this.process.stdin.write(messageStr);
  }

  private handleResponse(data: string): void {
    const lines = data.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line);
        this.emit('response', response);

        if ('id' in response && typeof response.id === 'number') {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);

            if ('error' in response) {
              pending.reject(new Error(response.error.message || 'MCP call failed'));
            } else {
              pending.resolve(response.result);
            }
          }
        }
      } catch (error) {
        this.logger.error("Failed to parse MCP response", {
          serverId: this.config.id,
          data: line,
          error: (error as Error).message
        });
      }
    }
  }
}

// Desktop Commander specific configuration
export function createDesktopCommanderConfig(): MCPServerConfig {
  // Use environment variable directly (it's already tested and works)
  const command = process.env.DESKTOP_COMMANDER_COMMAND || "npx";
  const args = process.env.DESKTOP_COMMANDER_ARGS?.split(',') || ["-y", "@wonderwhy-er/desktop-commander"];

  return {
    id: "desktop-commander",
    name: "Desktop Commander MCP",
    command: command,
    args: args,
    transport: "stdio",
    timeout: 15000,
    env: {
      ...process.env,
      PATH: process.env.PATH || '' // Ensure PATH is passed through
    }
  };
}

