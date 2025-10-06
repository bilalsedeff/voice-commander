/**
 * MCP Connection Manager V2
 *
 * Manages MCP server connections with support for both stdio and HTTP+SSE transports:
 * - Connection establishment and teardown
 * - Health monitoring with automatic recovery
 * - Status tracking in database
 * - Auto-connect on OAuth authorization
 * - Session management for HTTP+SSE connections
 */

import { PrismaClient } from '@prisma/client';
import { GoogleCalendarMCP } from '../mcp/google-calendar-mcp';
import { MCPHttpClient } from './mcp-http-client';
import { decryptToken } from '../utils/encryption';
import logger from '../utils/logger';

const prisma = new PrismaClient();

type MCPInstance = GoogleCalendarMCP | MCPHttpClient;

interface MCPConnectionInfo {
  provider: string;
  userId: string;
  instance: MCPInstance;
  transport: 'stdio' | 'http-sse';
  lastHealthCheck: Date;
  healthCheckInterval: NodeJS.Timeout;
}

interface MCPEndpointConfig {
  provider: string;
  endpoint: string;
  transport: 'stdio' | 'http-sse';
}

interface MCPConnectionResult {
  success: boolean;
  error?: string;
  toolsCount?: number;
}

// MCP Endpoint Configuration
const MCP_ENDPOINTS: Record<string, MCPEndpointConfig> = {
  google: {
    provider: 'google',
    endpoint: 'local', // Local GoogleCalendarMCP class
    transport: 'stdio'
  },
  slack: {
    provider: 'slack',
    endpoint: process.env.MCP_SLACK_ENDPOINT || 'https://mcp.slack.com/api',
    transport: 'http-sse'
  },
  github: {
    provider: 'github',
    endpoint: process.env.MCP_GITHUB_ENDPOINT || 'https://mcp.github.com/api',
    transport: 'http-sse'
  }
};

export class MCPConnectionManagerV2 {
  private connections: Map<string, MCPConnectionInfo> = new Map();
  private healthCheckIntervalMs = parseInt(process.env.MCP_PING_INTERVAL_MS || '30000');
  private maxReconnectAttempts = parseInt(process.env.MCP_MAX_RECONNECT_ATTEMPTS || '3');
  private reconnectBackoffMs = parseInt(process.env.MCP_RECONNECT_BACKOFF_MS || '1000');

  /**
   * Initialize MCP connection for a service
   */
  async connectMCPServer(
    userId: string,
    provider: string
  ): Promise<MCPConnectionResult> {
    const connectionKey = `${userId}:${provider}`;

    try {
      logger.info('Initializing MCP connection', { userId, provider });

      // Update status to connecting
      await this.updateMCPStatus(userId, provider, 'connecting');

      // Get endpoint configuration
      const endpointConfig = MCP_ENDPOINTS[provider];
      if (!endpointConfig) {
        throw new Error(`No MCP endpoint configured for provider: ${provider}`);
      }

      // Create MCP instance based on transport
      let mcpInstance: MCPInstance;
      let tools: unknown[] = [];

      if (endpointConfig.transport === 'http-sse') {
        // Get OAuth access token
        const accessToken = await this.getAccessToken(userId, provider);

        // Create HTTP+SSE client
        const httpClient = new MCPHttpClient(endpointConfig.endpoint, accessToken);

        // Initialize connection
        const initResult = await httpClient.initialize();

        // Discover tools
        tools = await httpClient.discoverTools();

        mcpInstance = httpClient;

        // Store session info in database
        await this.updateMCPStatus(
          userId,
          provider,
          'connected',
          tools.length,
          undefined,
          httpClient.getSessionId(),
          endpointConfig.endpoint,
          initResult.protocolVersion
        );
      } else {
        // Fallback to stdio (for backward compatibility)
        switch (provider) {
          case 'google':
            mcpInstance = new GoogleCalendarMCP();
            break;
          default:
            throw new Error(`Stdio MCP not available for provider: ${provider}`);
        }

        // Discover tools
        tools = await mcpInstance.discoverTools();

        // Update status
        await this.updateMCPStatus(userId, provider, 'connected', tools.length);
      }

      logger.info('MCP tools discovered', {
        userId,
        provider,
        toolsCount: tools.length,
        transport: endpointConfig.transport
      });

      // Start health monitoring
      const healthCheckInterval = setInterval(
        () => this.performHealthCheck(connectionKey),
        this.healthCheckIntervalMs
      );

      // Store connection info
      this.connections.set(connectionKey, {
        provider,
        userId,
        instance: mcpInstance,
        transport: endpointConfig.transport,
        lastHealthCheck: new Date(),
        healthCheckInterval
      });

      logger.info('MCP connection established', {
        userId,
        provider,
        transport: endpointConfig.transport,
        toolsCount: tools.length
      });

      return {
        success: true,
        toolsCount: tools.length
      };
    } catch (error) {
      logger.error('MCP connection failed', {
        userId,
        provider,
        error: (error as Error).message
      });

      await this.updateMCPStatus(
        userId,
        provider,
        'error',
        0,
        (error as Error).message
      );

      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Get OAuth access token for provider
   */
  private async getAccessToken(userId: string, provider: string): Promise<string> {
    const oauthToken = await prisma.oAuthToken.findFirst({
      where: { userId, provider }
    });

    if (!oauthToken) {
      throw new Error(`No OAuth token found for ${provider}`);
    }

    return decryptToken(oauthToken.accessToken);
  }

  /**
   * Disconnect MCP server
   */
  async disconnectMCPServer(userId: string, provider: string): Promise<void> {
    const connectionKey = `${userId}:${provider}`;
    const connection = this.connections.get(connectionKey);

    if (connection) {
      // Stop health check interval
      clearInterval(connection.healthCheckInterval);

      // Disconnect if instance has disconnect method (duck typing)
      if (typeof (connection.instance as any).disconnect === 'function') {
        await (connection.instance as any).disconnect();
      }

      // Remove from active connections
      this.connections.delete(connectionKey);

      // Update database status
      await this.updateMCPStatus(userId, provider, 'disconnected');

      logger.info('MCP connection closed', { userId, provider });
    }
  }

  /**
   * Get MCP instance for a user/provider
   */
  getMCPInstance(userId: string, provider: string): MCPInstance | undefined {
    const connectionKey = `${userId}:${provider}`;
    const connection = this.connections.get(connectionKey);
    return connection?.instance;
  }

  /**
   * Call MCP tool
   */
  async callTool(
    userId: string,
    provider: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const instance = this.getMCPInstance(userId, provider);

    if (!instance) {
      throw new Error(`No active MCP connection for ${provider}`);
    }

    // Duck typing: check if instance has executeTool (GoogleCalendarMCP) or callTool (MCPHttpClient)
    if (typeof (instance as unknown as { executeTool?: (userId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown> }).executeTool === 'function') {
      // GoogleCalendarMCP style: executeTool(userId, toolName, args)
      return await (instance as unknown as { executeTool: (userId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown> }).executeTool(userId, toolName, args);
    } else if (typeof (instance as unknown as { callTool?: (toolName: string, args: Record<string, unknown>) => Promise<unknown> }).callTool === 'function') {
      // MCPHttpClient style: callTool(toolName, args)
      return await (instance as unknown as { callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown> }).callTool(toolName, args);
    } else {
      throw new Error(`Tool calling not supported for this MCP instance`);
    }
  }

  /**
   * Check if MCP is connected
   */
  isConnected(userId: string, provider: string): boolean {
    const connectionKey = `${userId}:${provider}`;
    return this.connections.has(connectionKey);
  }

  /**
   * Perform health check for a connection
   */
  private async performHealthCheck(connectionKey: string): Promise<void> {
    const connection = this.connections.get(connectionKey);

    if (!connection) {
      return;
    }

    try {
      let healthy = false;

      // Duck typing: check if instance has ping method (HTTP+SSE), otherwise use tool discovery
      if (typeof (connection.instance as any).ping === 'function') {
        healthy = await (connection.instance as any).ping();
      } else if (typeof (connection.instance as any).discoverTools === 'function') {
        // Fallback: try tool discovery
        const tools = await (connection.instance as any).discoverTools();
        healthy = tools.length > 0;
      }

      if (healthy) {
        connection.lastHealthCheck = new Date();

        // Update database - clear error on successful health check
        await this.updateMCPStatus(
          connection.userId,
          connection.provider,
          'connected',
          0,
          null // Clear error message
        );

        logger.debug('MCP health check passed', {
          userId: connection.userId,
          provider: connection.provider,
          transport: connection.transport
        });
      } else {
        throw new Error('Health check failed');
      }
    } catch (error) {
      logger.error('MCP health check failed', {
        userId: connection.userId,
        provider: connection.provider,
        error: (error as Error).message
      });

      // Update status to error
      await this.updateMCPStatus(
        connection.userId,
        connection.provider,
        'error',
        0,
        (error as Error).message
      );

      // Handle session not found (404) - reinitialize
      if ((error as Error).message.includes('Session not found')) {
        logger.info('MCP session expired, reinitializing', {
          userId: connection.userId,
          provider: connection.provider
        });

        await this.disconnectMCPServer(connection.userId, connection.provider);
        await this.connectMCPServer(connection.userId, connection.provider);
      } else {
        // Try to reconnect with exponential backoff
        this.scheduleReconnect(connection.userId, connection.provider);
      }
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(userId: string, provider: string, attempt: number = 1): void {
    if (attempt > this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached', { userId, provider });
      return;
    }

    const backoffTime = this.reconnectBackoffMs * Math.pow(2, attempt - 1);

    logger.info('Scheduling MCP reconnection', {
      userId,
      provider,
      attempt,
      backoffMs: backoffTime
    });

    setTimeout(async () => {
      try {
        await this.disconnectMCPServer(userId, provider);
        const result = await this.connectMCPServer(userId, provider);

        if (!result.success) {
          this.scheduleReconnect(userId, provider, attempt + 1);
        }
      } catch (error) {
        logger.error('Reconnection attempt failed', {
          userId,
          provider,
          attempt,
          error: (error as Error).message
        });
        this.scheduleReconnect(userId, provider, attempt + 1);
      }
    }, backoffTime);
  }

  /**
   * Update MCP status in database
   */
  private async updateMCPStatus(
    userId: string,
    provider: string,
    status: string,
    toolsCount: number = 0,
    error?: string | null,
    sessionId?: string | null,
    endpoint?: string,
    protocolVersion?: string
  ): Promise<void> {
    try {
      const updateData: {
        mcpConnected: boolean;
        mcpStatus: string;
        mcpToolsCount?: number;
        mcpError?: string | null;
        mcpLastHealthCheck: Date;
        mcpSessionId?: string | null;
        mcpEndpoint?: string;
        mcpProtocolVersion?: string;
      } = {
        mcpConnected: status === 'connected',
        mcpStatus: status,
        mcpToolsCount: toolsCount,
        mcpError: error,
        mcpLastHealthCheck: new Date()
      };

      // Add session info if provided
      if (sessionId !== undefined) {
        updateData.mcpSessionId = sessionId;
      }
      if (endpoint) {
        updateData.mcpEndpoint = endpoint;
      }
      if (protocolVersion) {
        updateData.mcpProtocolVersion = protocolVersion;
      }

      await prisma.serviceConnection.upsert({
        where: {
          userId_provider: {
            userId,
            provider
          }
        },
        create: {
          userId,
          provider,
          connected: false, // OAuth not connected yet
          ...updateData
        },
        update: updateData
      });
    } catch (dbError) {
      logger.error('Failed to update MCP status in database', {
        userId,
        provider,
        error: (dbError as Error).message
      });
    }
  }

  /**
   * Get all active MCP connections for a user
   */
  getUserConnections(userId: string): MCPConnectionInfo[] {
    const userConnections: MCPConnectionInfo[] = [];

    for (const [, connection] of this.connections.entries()) {
      if (connection.userId === userId) {
        userConnections.push(connection);
      }
    }

    return userConnections;
  }

  /**
   * Initialize MCP connections for user's authenticated services
   */
  async initializeUserMCPConnections(userId: string): Promise<void> {
    logger.info('Initializing user MCP connections', { userId });

    try {
      // Get all OAuth-connected services for this user
      const serviceConnections = await prisma.serviceConnection.findMany({
        where: { userId, connected: true }
      });

      // Try to connect MCP for each service
      for (const service of serviceConnections) {
        await this.connectMCPServer(userId, service.provider);
      }

      logger.info('User MCP connections initialized', {
        userId,
        count: serviceConnections.length
      });
    } catch (error) {
      logger.error('Failed to initialize user MCP connections', {
        userId,
        error: (error as Error).message
      });
    }
  }

  /**
   * Cleanup all connections (for graceful shutdown)
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up all MCP connections');

    for (const [, connection] of this.connections.entries()) {
      await this.disconnectMCPServer(connection.userId, connection.provider);
    }

    logger.info('All MCP connections cleaned up');
  }
}

// Singleton instance
export const mcpConnectionManagerV2 = new MCPConnectionManagerV2();
