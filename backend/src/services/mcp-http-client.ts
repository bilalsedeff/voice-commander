/**
 * MCP HTTP+SSE Client
 *
 * Implements HTTP+SSE transport for remote MCP servers following MCP specification 2025-03-26.
 * Handles session management, reconnection, and resumability.
 *
 * Dependencies:
 * - node-fetch: HTTP client
 * - eventsource: SSE client
 *
 * Input: MCP endpoint URL, OAuth tokens
 * Output: JSON-RPC responses from MCP server
 *
 * Example:
 * const client = new MCPHttpClient('https://mcp.google.com/calendar', oauthToken);
 * await client.initialize();
 * const result = await client.callTool('create_event', { ... });
 */

import { EventSource } from 'eventsource';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

interface MCPInitializeParams {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: {
    name: string;
    version: string;
  };
  sessionId?: string;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface MCPToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: unknown;
  }>;
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: string | number;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: string | number | null;
}

interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export class MCPHttpClient {
  private endpoint: string;
  private accessToken: string;
  private sessionId: string | null = null;
  private protocolVersion = '2025-03-26';
  private sseStream: EventSource | null = null;
  private lastEventId: string | null = null;
  private serverInfo: MCPInitializeResult | null = null;
  private notificationHandlers: Map<string, (params: unknown) => void> = new Map();

  constructor(endpoint: string, accessToken: string) {
    this.endpoint = endpoint;
    this.accessToken = accessToken;
  }

  /**
   * Initialize MCP connection and establish session
   */
  async initialize(): Promise<MCPInitializeResult> {
    try {
      const initParams: MCPInitializeParams = {
        protocolVersion: this.protocolVersion,
        capabilities: {
          tools: {},
          resources: {}
        },
        clientInfo: {
          name: 'voice-mcp-gateway',
          version: '1.0.0'
        }
      };

      const response = await this.sendRequest('initialize', initParams);

      // Extract session ID from response header
      if (response.headers) {
        const sessionId = response.headers.get('Mcp-Session-Id');
        if (sessionId) {
          this.sessionId = sessionId;
          logger.info('MCP session established', {
            endpoint: this.endpoint,
            sessionId: this.sessionId
          });
        }
      }

      this.serverInfo = response.result as MCPInitializeResult;

      // Establish SSE stream for notifications
      await this.connectSSE();

      logger.info('MCP HTTP client initialized', {
        endpoint: this.endpoint,
        serverInfo: this.serverInfo
      });

      return this.serverInfo;
    } catch (error) {
      logger.error('MCP initialization failed', {
        endpoint: this.endpoint,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Establish SSE stream for server-to-client notifications
   */
  private async connectSSE(): Promise<void> {
    if (!this.sessionId) {
      throw new Error('Cannot connect SSE without session ID');
    }

    const sseUrl = `${this.endpoint}/mcp`;
    const eventSourceInitDict: any = {
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': this.sessionId,
        'Authorization': `Bearer ${this.accessToken}`
      }
    };

    // Add Last-Event-ID for resumability
    if (this.lastEventId) {
      eventSourceInitDict.headers['Last-Event-ID'] = this.lastEventId;
    }

    this.sseStream = new EventSource(sseUrl, eventSourceInitDict);

    this.sseStream.addEventListener('message', (event: any) => {
      try {
        this.lastEventId = event.lastEventId || null;

        const message = JSON.parse(event.data);

        if (message.method) {
          // This is a notification or server request
          this.handleNotification(message);
        } else if (message.result || message.error) {
          // This is a response to our request
          // Handled by sendRequest promise
        }
      } catch (error) {
        logger.error('Failed to parse SSE message', {
          error: (error as Error).message,
          data: event.data
        });
      }
    });

    this.sseStream.onerror = () => {
      logger.error('SSE connection error', {
        endpoint: this.endpoint,
        sessionId: this.sessionId
      });

      // Attempt reconnection
      setTimeout(() => {
        this.reconnect();
      }, 5000);
    };

    logger.info('SSE stream established', {
      endpoint: this.endpoint,
      sessionId: this.sessionId
    });
  }

  /**
   * Handle server notifications
   */
  private handleNotification(notification: JSONRPCNotification): void {
    const handler = this.notificationHandlers.get(notification.method);

    if (handler) {
      handler(notification.params);
    } else {
      logger.debug('Unhandled MCP notification', {
        method: notification.method,
        params: notification.params
      });
    }
  }

  /**
   * Register notification handler
   */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Send JSON-RPC request to MCP server
   */
  private async sendRequest(
    method: string,
    params?: unknown
  ): Promise<{ result?: unknown; headers?: any; error?: { code: number; message: string } }> {
    const requestId = uuidv4();

    const jsonrpcRequest: JSONRPCRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: requestId
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${this.accessToken}`
    };

    // Add session ID if we have one
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const response = await fetch(`${this.endpoint}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonrpcRequest)
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Session not found - reconnection required');
      }
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
    }

    // Handle 202 Accepted (response will come via SSE)
    if (response.status === 202) {
      // Response will be delivered via SSE stream
      return { result: { accepted: true }, headers: response.headers };
    }

    // Handle immediate JSON response
    const jsonResponse: JSONRPCResponse = await response.json() as JSONRPCResponse;

    if (jsonResponse.error) {
      throw new Error(`MCP error: ${jsonResponse.error.message}`);
    }

    return { result: jsonResponse.result, headers: response.headers };
  }

  /**
   * Discover available tools from MCP server
   */
  async discoverTools(): Promise<MCPTool[]> {
    try {
      const response = await this.sendRequest('tools/list');
      const tools = (response.result as { tools: MCPTool[] }).tools || [];

      logger.debug('MCP tools discovered', {
        endpoint: this.endpoint,
        count: tools.length
      });

      return tools;
    } catch (error) {
      logger.error('Failed to discover MCP tools', {
        endpoint: this.endpoint,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Call an MCP tool
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    try {
      const response = await this.sendRequest('tools/call', {
        name,
        arguments: args
      });

      return response.result as MCPToolResult;
    } catch (error) {
      logger.error('MCP tool call failed', {
        endpoint: this.endpoint,
        tool: name,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Ping MCP server to check connection health
   */
  async ping(): Promise<boolean> {
    try {
      await this.sendRequest('ping');
      return true;
    } catch (error) {
      logger.error('MCP ping failed', {
        endpoint: this.endpoint,
        error: (error as Error).message
      });
      return false;
    }
  }

  /**
   * Reconnect after connection loss
   */
  private async reconnect(): Promise<void> {
    logger.info('Attempting MCP reconnection', {
      endpoint: this.endpoint,
      sessionId: this.sessionId
    });

    // Close existing SSE stream
    if (this.sseStream) {
      this.sseStream.close();
      this.sseStream = null;
    }

    try {
      // Try to resume with existing session
      if (this.sessionId) {
        await this.connectSSE();
        logger.info('MCP session resumed', { sessionId: this.sessionId });
      } else {
        // Reinitialize
        await this.initialize();
        logger.info('MCP session reinitialized');
      }
    } catch (error) {
      logger.error('MCP reconnection failed', {
        endpoint: this.endpoint,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Disconnect and clean up
   */
  async disconnect(): Promise<void> {
    logger.info('Disconnecting MCP client', {
      endpoint: this.endpoint,
      sessionId: this.sessionId
    });

    // Close SSE stream
    if (this.sseStream) {
      this.sseStream.close();
      this.sseStream = null;
    }

    // Send DELETE to terminate session
    if (this.sessionId) {
      try {
        await fetch(`${this.endpoint}/mcp`, {
          method: 'DELETE',
          headers: {
            'Mcp-Session-Id': this.sessionId,
            'Authorization': `Bearer ${this.accessToken}`
          }
        });
      } catch (error) {
        logger.warn('Failed to terminate MCP session', {
          sessionId: this.sessionId,
          error: (error as Error).message
        });
      }
    }

    this.sessionId = null;
    this.serverInfo = null;
    this.lastEventId = null;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get server info
   */
  getServerInfo(): MCPInitializeResult | null {
    return this.serverInfo;
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.sessionId !== null && this.sseStream !== null;
  }
}
