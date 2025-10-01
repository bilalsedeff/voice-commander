/**
 * Generic MCP Process Manager
 *
 * Manages MCP server processes using stdio transport:
 * - Spawns child processes (npx, docker, node)
 * - Injects OAuth tokens/API keys as env variables
 * - Handles JSON-RPC 2.0 communication over stdio
 * - Tool discovery and execution
 * - Process lifecycle management
 */

import { spawn, ChildProcess } from 'child_process';
import { PrismaClient, Prisma } from '@prisma/client';
import { decryptToken } from '../utils/encryption';
import logger from '../utils/logger';

const prisma = new PrismaClient();

interface MCPProcess {
  process: ChildProcess;
  serverId: string;
  userId: string;
  status: 'starting' | 'ready' | 'error';
  tools: unknown[];
  requestHandlers: Map<number, (response: unknown) => void>;
  requestId: number;
}

export class MCPProcessManager {
  private processes: Map<string, MCPProcess> = new Map();

  /**
   * Start MCP process for user
   */
  async startMCP(userId: string, mcpServerId: string): Promise<void> {
    const key = `${userId}:${mcpServerId}`;

    // Check if already running
    if (this.processes.has(key)) {
      logger.warn('MCP already running', { userId, mcpServerId });
      return;
    }

    try {
      // Get MCP server config
      const mcpServer = await prisma.mCPServer.findUnique({
        where: { id: mcpServerId }
      });

      if (!mcpServer) {
        throw new Error(`MCP server not found: ${mcpServerId}`);
      }

      // Get user MCP config (OAuth tokens, API keys)
      const userConfig = await prisma.userMCPConfig.findUnique({
        where: {
          userId_mcpServerId: { userId, mcpServerId }
        }
      });

      // Build environment variables
      const env: Record<string, string> = Object.entries(process.env).reduce<Record<string, string>>(
        (acc, [key, value]) => {
          if (value !== undefined) {
            acc[key] = value;
          }
          return acc;
        },
        {}
      );

      // Inject OAuth tokens
      if (mcpServer.authType === 'oauth' && userConfig?.oauthAccessToken) {
        const accessToken = decryptToken(userConfig.oauthAccessToken);
        env.OAUTH_ACCESS_TOKEN = accessToken;

        if (userConfig.oauthRefreshToken) {
          const refreshToken = decryptToken(userConfig.oauthRefreshToken);
          env.OAUTH_REFRESH_TOKEN = refreshToken;
        }
      }

      // Inject API keys
      if (mcpServer.authType === 'api_key' && userConfig?.apiKey && mcpServer.apiKeyEnvVar) {
        const apiKey = decryptToken(userConfig.apiKey);
        env[mcpServer.apiKeyEnvVar] = apiKey;
      }

      // Spawn child process (Windows compatibility)
      const args = mcpServer.args as string[];
      let command = mcpServer.command;
      let spawnArgs = args;

      // Windows requires .cmd extension for npm commands
      if (process.platform === 'win32' && command === 'npx') {
        command = 'npx.cmd';
      }

      const childProcess = spawn(command, spawnArgs, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });

      logger.info('MCP process spawned', {
        userId,
        mcpServerId,
        name: mcpServer.name,
        pid: childProcess.pid
      });

      // Store process info
      const mcpProcess: MCPProcess = {
        process: childProcess,
        serverId: mcpServerId,
        userId,
        status: 'starting',
        tools: [],
        requestHandlers: new Map(),
        requestId: 1
      };

      this.processes.set(key, mcpProcess);

      // Update database status
      await this.updateStatus(userId, mcpServerId, 'connecting', childProcess.pid?.toString());

      // Setup error handler
      childProcess.on('error', (error) => {
        logger.error('MCP process error', {
          userId,
          mcpServerId,
          error: error.message,
          code: (error as NodeJS.ErrnoException).code
        });
        this.processes.delete(key);
        this.updateStatus(userId, mcpServerId, 'error', undefined, undefined, error.message);
      });

      childProcess.on('exit', (code, signal) => {
        logger.info('MCP process exited', { userId, mcpServerId, code, signal });
        this.processes.delete(key);
      });

      // Setup stdio handlers
      this.setupStdioHandlers(key, mcpProcess);

      // Initialize MCP protocol
      await this.sendRequest(key, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'voice-commander',
          version: '1.0.0'
        }
      });

      // Discover tools
      const tools = await this.sendRequest(key, 'tools/list', {});
      const toolsList = (tools as { tools?: unknown[] })?.tools || [];
      mcpProcess.tools = toolsList;
      mcpProcess.status = 'ready';

      // Update database with tools (cast to JSON-compatible type)
      const toolsJson = toolsList as Record<string, unknown>[];
      await this.updateStatus(userId, mcpServerId, 'connected', childProcess.pid?.toString(), toolsJson);

      logger.info('MCP process ready', {
        userId,
        mcpServerId,
        toolsCount: mcpProcess.tools.length
      });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('MCP process start failed', { userId, mcpServerId, error: errorMsg });
      await this.updateStatus(userId, mcpServerId, 'error', undefined, undefined, errorMsg);
      throw error;
    }
  }

  /**
   * Setup stdio communication handlers
   */
  private setupStdioHandlers(key: string, mcpProcess: MCPProcess): void {
    let buffer = '';

    // Stdout: Read JSON-RPC responses
    mcpProcess.process.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Process complete JSON messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line);

          // Handle response
          if (message.id !== undefined) {
            const handler = mcpProcess.requestHandlers.get(message.id as number);
            if (handler) {
              handler(message.result || message.error);
              mcpProcess.requestHandlers.delete(message.id as number);
            }
          }

          // Handle notifications
          if (message.method) {
            logger.debug('MCP notification', { method: message.method, params: message.params });
          }

        } catch (err) {
          logger.error('Failed to parse MCP message', { line, error: (err as Error).message });
        }
      }
    });

    // Stderr: Log errors
    mcpProcess.process.stderr?.on('data', (chunk: Buffer) => {
      logger.error('MCP stderr', { message: chunk.toString().trim() });
    });

    // Process exit
    mcpProcess.process.on('exit', async (code) => {
      logger.warn('MCP process exited', { code, userId: mcpProcess.userId, serverId: mcpProcess.serverId });
      this.processes.delete(key);
      await this.updateStatus(mcpProcess.userId, mcpProcess.serverId, 'disconnected');
    });
  }

  /**
   * Send JSON-RPC request to MCP process
   */
  private sendRequest(key: string, method: string, params: unknown): Promise<unknown> {
    const mcpProcess = this.processes.get(key);
    if (!mcpProcess) {
      return Promise.reject(new Error('MCP process not found'));
    }

    return new Promise((resolve, reject) => {
      const id = mcpProcess.requestId++;

      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      // Store response handler
      mcpProcess.requestHandlers.set(id, (response: unknown) => {
        if (response && typeof response === 'object' && 'error' in response) {
          reject(new Error((response as { error: { message: string } }).error.message));
        } else {
          resolve(response);
        }
      });

      // Send request
      mcpProcess.process.stdin?.write(JSON.stringify(request) + '\n');

      // Timeout after 30s
      setTimeout(() => {
        if (mcpProcess.requestHandlers.has(id)) {
          mcpProcess.requestHandlers.delete(id);
          reject(new Error('MCP request timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Execute MCP tool
   */
  async executeTool(
    userId: string,
    mcpServerId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const key = `${userId}:${mcpServerId}`;
    const mcpProcess = this.processes.get(key);

    if (!mcpProcess) {
      throw new Error('MCP not connected');
    }

    if (mcpProcess.status !== 'ready') {
      throw new Error('MCP not ready');
    }

    logger.info('Executing MCP tool', { userId, mcpServerId, toolName, args });

    const result = await this.sendRequest(key, 'tools/call', {
      name: toolName,
      arguments: args
    });

    return result;
  }

  /**
   * Get discovered tools
   */
  getTools(userId: string, mcpServerId: string): unknown[] {
    const key = `${userId}:${mcpServerId}`;
    const mcpProcess = this.processes.get(key);
    return mcpProcess?.tools || [];
  }

  /**
   * Stop MCP process
   */
  async stopMCP(userId: string, mcpServerId: string): Promise<void> {
    const key = `${userId}:${mcpServerId}`;
    const mcpProcess = this.processes.get(key);

    if (mcpProcess) {
      mcpProcess.process.kill();
      this.processes.delete(key);
      await this.updateStatus(userId, mcpServerId, 'disconnected');
      logger.info('MCP process stopped', { userId, mcpServerId });
    }
  }

  /**
   * Update database status
   */
  private async updateStatus(
    userId: string,
    mcpServerId: string,
    status: string,
    processId?: string,
    tools?: Record<string, unknown>[],
    error?: string
  ): Promise<void> {
    await prisma.userMCPConfig.upsert({
      where: {
        userId_mcpServerId: { userId, mcpServerId }
      },
      create: {
        userId,
        mcpServerId,
        status,
        processId,
        toolsDiscovered: (tools || []) as Prisma.InputJsonValue,
        error,
        lastHealthCheck: new Date()
      },
      update: {
        status,
        processId,
        toolsDiscovered: tools !== undefined ? (tools as Prisma.InputJsonValue) : undefined,
        error,
        lastHealthCheck: new Date()
      }
    });
  }

  /**
   * Check if MCP is running
   */
  isRunning(userId: string, mcpServerId: string): boolean {
    const key = `${userId}:${mcpServerId}`;
    return this.processes.has(key);
  }

  /**
   * Cleanup all processes
   */
  async cleanup(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [key] of this.processes) {
      const [userId, mcpServerId] = key.split(':');
      promises.push(this.stopMCP(userId, mcpServerId));
    }

    await Promise.all(promises);
  }
}

// Singleton instance
export const mcpProcessManager = new MCPProcessManager();

// Cleanup on process exit
process.on('SIGINT', async () => {
  await mcpProcessManager.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await mcpProcessManager.cleanup();
  process.exit(0);
});
