/**
 * API Client for Voice Commander Backend
 *
 * Handles all HTTP requests to the backend with automatic token management
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface User {
  id: string;
  email: string;
  name?: string;
}

interface LoginResponse {
  success: boolean;
  user: User;
  tokens: AuthTokens;
}

interface RegisterResponse extends LoginResponse {}

interface OAuthConnection {
  provider: string;
  connected: boolean;
  lastSync: string | null;
  mcpConnected: boolean;
  mcpStatus: string;
  mcpLastHealthCheck: string | null;
  mcpError: string | null;
  mcpToolsCount: number;
  createdAt: string;
  updatedAt: string;
}

interface OAuthConnectionsResponse {
  success: boolean;
  connections: OAuthConnection[];
}

/**
 * Check if user is authenticated by checking if we can access /api/auth/me
 * Tokens are now in httpOnly cookies, so we can't check localStorage
 */
async function checkAuth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      credentials: 'include' // Send cookies with request
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Make authenticated API request (with cookies)
 * Cookies are sent automatically with credentials: 'include'
 */
async function authenticatedFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    credentials: 'include', // Send cookies with request
    headers,
  });

  // If unauthorized, redirect to login (cookies will be cleared by logout endpoint)
  if (response.status === 401 || response.status === 403) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
  }

  return response;
}

/**
 * Authentication API
 */
export const auth = {
  async register(email: string, password: string, name?: string): Promise<{ success: boolean; user: User }> {
    const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
      method: 'POST',
      credentials: 'include', // Send/receive cookies
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Registration failed');
    }

    return await response.json();
  },

  async login(email: string, password: string): Promise<{ success: boolean; user: User }> {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      credentials: 'include', // Send/receive cookies
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Login failed');
    }

    return await response.json();
  },

  async logout(): Promise<void> {
    try {
      await authenticatedFetch('/api/auth/logout', {
        method: 'POST',
      });
    } finally {
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
    }
  },

  async getCurrentUser(): Promise<User> {
    const response = await authenticatedFetch('/api/auth/me');

    if (!response.ok) {
      throw new Error('Failed to get current user');
    }

    const data = await response.json();
    return data.user;
  },

  async isAuthenticated(): Promise<boolean> {
    return await checkAuth();
  },
};

/**
 * OAuth API
 */
export const oauth = {
  /**
   * Start OAuth flow for a provider
   * Redirects to backend OAuth authorization endpoint
   * Cookies are sent automatically with the redirect
   */
  async connect(provider: string): Promise<void> {
    // Check if user is authenticated (cookies will be sent automatically)
    const isAuth = await checkAuth();
    if (!isAuth) {
      throw new Error('Please login first');
    }

    // Redirect to backend OAuth authorization endpoint
    // Cookies will be sent automatically by the browser
    window.location.href = `${API_BASE_URL}/api/oauth/${provider}/authorize`;
  },

  /**
   * Disconnect OAuth provider
   */
  async disconnect(provider: string): Promise<void> {
    const response = await authenticatedFetch(`/api/oauth/${provider}/disconnect`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Disconnect failed');
    }

    return response.json();
  },

  /**
   * Get all OAuth connections for current user
   */
  async getConnections(): Promise<OAuthConnection[]> {
    const response = await authenticatedFetch('/api/oauth/connections');

    if (!response.ok) {
      throw new Error('Failed to get connections');
    }

    const data: OAuthConnectionsResponse = await response.json();
    return data.connections;
  },

  /**
   * Force refresh MCP connection for a provider
   * Attempts to connect/reconnect MCP server and fetch tool list
   */
  async refreshConnection(provider: string): Promise<{
    success: boolean;
    message: string;
    error?: string;
    connection?: OAuthConnection;
  }> {
    const response = await authenticatedFetch(`/api/oauth/refresh/${provider}`, {
      method: 'POST',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Refresh failed');
    }

    return response.json();
  },
};

/**
 * Voice Command API
 */
export const voice = {
  /**
   * Process a voice command (legacy non-streaming)
   */
  async processCommand(command: string): Promise<{
    success: boolean;
    type: 'single' | 'chained';
    result: unknown;
    message: string;
  }> {
    const response = await authenticatedFetch('/api/voice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Voice command failed');
    }

    return response.json();
  },

  /**
   * Stream voice command execution with real-time updates
   */
  async streamCommand(
    command: string,
    callbacks: {
      onProgress?: (update: { step: string; message: string; timestamp: string; data?: unknown }) => void;
      onResult?: (result: unknown) => void;
      onError?: (error: { message: string; code?: string }) => void;
      onDone?: () => void;
    },
    sessionId?: string
  ): Promise<void> {
    const url = `${API_BASE_URL}/api/voice/llm/stream`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include', // Send cookies automatically
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          query: command,
          ...(sessionId && { sessionId }) // Include sessionId if provided
        }),
      });

      if (!response.ok) {
        // Handle unauthorized
        if (response.status === 401 || response.status === 403) {
          if (typeof window !== 'undefined') {
            window.location.href = '/login';
          }
          return;
        }

        const errorData = await response.json().catch(() => ({ message: 'Request failed' }));
        throw new Error(errorData.message || `HTTP ${response.status}`);
      }

      // Read SSE stream
      console.log('🔄 SSE: Starting to read stream...', {
        hasBody: !!response.body,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries())
      }); // DEBUG

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        console.error('❌ SSE: Response body is not readable');
        throw new Error('Response body is not readable');
      }

      let buffer = '';

      console.log('✅ SSE: Reader ready, starting to read chunks...'); // DEBUG

      while (true) {
        const { done, value } = await reader.read();

        console.log('📦 SSE: Chunk received', { done, bytesLength: value?.length }); // DEBUG

        if (done) {
          callbacks.onDone?.();
          break;
        }

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            eventData = line.slice(5).trim();
          } else if (line === '' && eventType && eventData) {
            // Complete event - process it
            try {
              const data = JSON.parse(eventData);

              console.log('📡 SSE Event:', eventType, data); // DEBUG

              switch (eventType) {
                case 'progress':
                  console.log('📊 Progress event received:', data); // DEBUG
                  callbacks.onProgress?.(data as { step: string; message: string; timestamp: string; data?: unknown });
                  break;

                case 'result':
                  console.log('✅ Result event received:', data); // DEBUG
                  callbacks.onResult?.(data);
                  break;

                case 'error':
                  console.log('❌ Error event received:', data); // DEBUG
                  callbacks.onError?.(data as { message: string; code?: string });
                  break;

                case 'done':
                  console.log('🏁 Done event received:', data); // DEBUG
                  // Send done event data to onResult callback first (contains results array)
                  if (data && typeof data === 'object') {
                    // Wait for onResult to complete (it's async and generates TTS)
                    await callbacks.onResult?.(data);
                  }
                  // Then call onDone (after TTS message is ready)
                  callbacks.onDone?.();
                  break;

                default:
                  console.warn('Unknown SSE event type:', eventType, data);
              }
            } catch (parseError) {
              console.error('Failed to parse SSE event data:', eventData, parseError);
            }

            eventType = '';
            eventData = '';
          }
        }
      }
    } catch (error) {
      console.error('SSE streaming error:', error);
      const errorObj = error instanceof Error ? error : new Error('Unknown SSE error');
      callbacks.onError?.({
        message: errorObj.message,
        code: 'SSE_ERROR'
      });
    }
  },

  /**
   * Confirm a risky command
   */
  async confirmCommand(confirmationId: string, userResponse: string): Promise<{
    success: boolean;
    result: any;
    message: string;
  }> {
    const response = await authenticatedFetch('/api/voice/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ confirmationId, response: userResponse }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Confirmation failed');
    }

    return response.json();
  },

  /**
   * Get available voice capabilities
   */
  async getCapabilities(): Promise<{
    success: boolean;
    connectedServices: string[];
    capabilities: Record<string, any>;
  }> {
    const response = await authenticatedFetch('/api/voice/capabilities');

    if (!response.ok) {
      throw new Error('Failed to get capabilities');
    }

    return response.json();
  },

  /**
   * Get example voice commands
   */
  async getExamples(): Promise<{
    success: boolean;
    examples: Record<string, string[]>;
    chainedExamples: string[];
    connectedServices: string[];
  }> {
    const response = await authenticatedFetch('/api/voice/examples');

    if (!response.ok) {
      throw new Error('Failed to get examples');
    }

    return response.json();
  },

  /**
   * Initialize MCP connections for OAuth-connected services
   */
  async initMCPConnections(): Promise<{
    success: boolean;
    initialized: number;
    results: Array<{
      provider: string;
      status: string;
      mcpConnected: boolean;
      toolsCount: number;
      error?: string;
    }>;
  }> {
    const response = await authenticatedFetch('/api/voice/mcp-init', {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error('Failed to initialize MCP connections');
    }

    return response.json();
  },

  /**
   * Generate natural conversational TTS response from tool results
   */
  async generateNaturalResponse(
    query: string,
    toolResults: Array<{
      success: boolean;
      tool: string;
      service: string;
      data?: unknown;
      error?: string;
    }>,
    options?: {
      conversationContext?: string;
      keepShort?: boolean;
      askFollowUp?: boolean;
    }
  ): Promise<string> {
    const response = await authenticatedFetch('/api/voice/generate-response', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        toolResults,
        ...options
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to generate natural response');
    }

    const data = await response.json();
    return data.spokenResponse;
  },

  /**
   * Get MCP server status
   */
  async getMCPStatus(): Promise<{
    success: boolean;
    mcpServers: Array<{
      mcpServerId: string;
      name: string;
      displayName: string;
      provider: string | null;
      category: string | null;
      iconUrl: string | null;
      authType: string;
      status: string;
      isRunning: boolean;
      toolsCount: number;
      lastHealthCheck: Date | null;
      error: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    totalCount: number;
    connectedCount: number;
  }> {
    const response = await authenticatedFetch('/api/voice/mcp-status');

    if (!response.ok) {
      throw new Error('Failed to get MCP status');
    }

    return response.json();
  },

  /**
   * Start a new conversation session or resume existing one
   */
  async startSession(mode: 'continuous' | 'push_to_talk' = 'continuous'): Promise<{
    success: boolean;
    session: {
      id: string;
      userId: string;
      mode: string;
      status: string;
      totalTurns: number;
      createdAt: Date;
      updatedAt: Date;
    };
    isNew: boolean;
  }> {
    const response = await authenticatedFetch('/api/voice/session/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode }),
    });

    if (!response.ok) {
      throw new Error('Failed to start session');
    }

    return response.json();
  },

  /**
   * End current conversation session
   */
  async endSession(sessionId: string, status: 'completed' | 'timeout' = 'completed'): Promise<{
    success: boolean;
    sessionId: string;
  }> {
    const response = await authenticatedFetch(`/api/voice/session/${sessionId}/end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      throw new Error('Failed to end session');
    }

    return response.json();
  },

  /**
   * Get active conversation session
   */
  async getActiveSession(): Promise<{
    success: boolean;
    session: {
      id: string;
      userId: string;
      mode: string;
      status: string;
      totalTurns: number;
      createdAt: Date;
      updatedAt: Date;
    } | null;
  }> {
    const response = await authenticatedFetch('/api/voice/session/active');

    if (!response.ok) {
      throw new Error('Failed to get active session');
    }

    return response.json();
  },
};

/**
 * Activity History API
 */
export const activity = {
  /**
   * Get user activity history with pagination
   */
  async getHistory(options?: {
    page?: number;
    limit?: number;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    success: boolean;
    activities: Array<{
      id: string;
      timestamp: Date;
      type: 'session' | 'command' | 'oauth_connect' | 'oauth_disconnect';
      title: string;
      description: string;
      details?: Record<string, unknown>;
      success?: boolean;
      service?: string;
    }>;
    pagination: {
      page: number;
      limit: number;
      totalCount: number;
      totalPages: number;
      hasMore: boolean;
    };
  }> {
    const params = new URLSearchParams();
    if (options?.page) params.append('page', options.page.toString());
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.startDate) params.append('startDate', options.startDate.toISOString());
    if (options?.endDate) params.append('endDate', options.endDate.toISOString());

    const response = await authenticatedFetch(`/api/activity?${params.toString()}`);

    if (!response.ok) {
      throw new Error('Failed to fetch activity history');
    }

    return response.json();
  },

  /**
   * Get activity statistics for dashboard
   */
  async getStats(): Promise<{
    success: boolean;
    stats: {
      totalSessions: number;
      totalCommands: number;
      successfulCommands: number;
      successRate: string;
      connectedServices: number;
      period: string;
    };
  }> {
    const response = await authenticatedFetch('/api/activity/stats');

    if (!response.ok) {
      throw new Error('Failed to fetch activity stats');
    }

    return response.json();
  },
};

export default {
  auth,
  oauth,
  voice,
  activity,
};
