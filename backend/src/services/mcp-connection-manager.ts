/**
 * MCP Connection Manager
 *
 * Manages MCP server connections lifecycle:
 * - Connection establishment and teardown
 * - Health monitoring with automatic recovery
 * - Status tracking in database
 * - Auto-connect on OAuth authorization
 */

import { PrismaClient } from '@prisma/client';
import { GoogleCalendarMCP } from '../mcp/google-calendar-mcp';
import logger from '../utils/logger';

const prisma = new PrismaClient();

interface MCPConnectionInfo {
  provider: string;
  userId: string;
  instance: GoogleCalendarMCP; // Will be union type when we add more services
  lastHealthCheck: Date;
  healthCheckInterval: NodeJS.Timeout;
}

export class MCPConnectionManager {
  private connections: Map<string, MCPConnectionInfo> = new Map();
  private healthCheckIntervalMs = 30000; // 30 seconds

  /**
   * Initialize MCP connection for a service
   */
  async connectMCPServer(
    userId: string,
    provider: string
  ): Promise<{ success: boolean; error?: string }> {
    const connectionKey = `${userId}:${provider}`;

    try {
      logger.info('Initializing MCP connection', { userId, provider });

      // Update status to connecting
      await this.updateMCPStatus(userId, provider, 'connecting');

      // Create MCP instance based on provider
      let mcpInstance;
      switch (provider) {
        case 'google':
          mcpInstance = new GoogleCalendarMCP();
          break;

        // Add more services here:
        // case 'slack':
        //   mcpInstance = new SlackMCP();
        //   break;

        default:
          throw new Error(`MCP server not available for provider: ${provider}`);
      }

      // Test connection by discovering tools
      const tools = await mcpInstance.discoverTools();
      logger.info('MCP tools discovered', {
        userId,
        provider,
        toolsCount: tools.length
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
        lastHealthCheck: new Date(),
        healthCheckInterval
      });

      // Update status to connected
      await this.updateMCPStatus(userId, provider, 'connected', tools.length);

      logger.info('MCP connection established', {
        userId,
        provider,
        toolsCount: tools.length
      });

      return { success: true };
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
   * Disconnect MCP server
   */
  async disconnectMCPServer(userId: string, provider: string): Promise<void> {
    const connectionKey = `${userId}:${provider}`;
    const connection = this.connections.get(connectionKey);

    if (connection) {
      // Stop health check interval
      clearInterval(connection.healthCheckInterval);

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
  getMCPInstance(userId: string, provider: string): GoogleCalendarMCP | undefined {
    const connectionKey = `${userId}:${provider}`;
    const connection = this.connections.get(connectionKey);
    return connection?.instance;
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
      // Try to discover tools as health check
      const tools = await connection.instance.discoverTools();

      connection.lastHealthCheck = new Date();

      // Update database
      await this.updateMCPStatus(
        connection.userId,
        connection.provider,
        'connected',
        tools.length
      );

      logger.debug('MCP health check passed', {
        userId: connection.userId,
        provider: connection.provider,
        toolsCount: tools.length
      });
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

      // Try to reconnect
      setTimeout(() => {
        this.attemptReconnect(connection.userId, connection.provider);
      }, 5000);
    }
  }

  /**
   * Attempt to reconnect a failed MCP connection
   */
  private async attemptReconnect(userId: string, provider: string): Promise<void> {
    const connectionKey = `${userId}:${provider}`;

    // Check if connection still exists (user might have disconnected)
    if (!this.connections.has(connectionKey)) {
      return;
    }

    logger.info('Attempting MCP reconnection', { userId, provider });

    // Disconnect and reconnect
    await this.disconnectMCPServer(userId, provider);
    await this.connectMCPServer(userId, provider);
  }

  /**
   * Update MCP status in database
   */
  private async updateMCPStatus(
    userId: string,
    provider: string,
    status: string,
    toolsCount: number = 0,
    error?: string
  ): Promise<void> {
    try {
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
          mcpConnected: status === 'connected',
          mcpStatus: status,
          mcpToolsCount: toolsCount,
          mcpError: error,
          mcpLastHealthCheck: new Date()
        },
        update: {
          mcpConnected: status === 'connected',
          mcpStatus: status,
          mcpToolsCount: toolsCount,
          mcpError: error,
          mcpLastHealthCheck: new Date()
        }
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

    for (const [key, connection] of this.connections.entries()) {
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

    for (const [key, connection] of this.connections.entries()) {
      await this.disconnectMCPServer(connection.userId, connection.provider);
    }

    logger.info('All MCP connections cleaned up');
  }
}

// Singleton instance
export const mcpConnectionManager = new MCPConnectionManager();
