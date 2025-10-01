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
 * Get stored JWT token from localStorage
 */
function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('accessToken');
}

/**
 * Store JWT tokens in localStorage
 */
function storeTokens(tokens: AuthTokens): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('accessToken', tokens.accessToken);
  localStorage.setItem('refreshToken', tokens.refreshToken);
  localStorage.setItem('tokenExpiry', (Date.now() + tokens.expiresIn).toString());
}

/**
 * Clear stored tokens
 */
function clearTokens(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('tokenExpiry');
}

/**
 * Make authenticated API request
 */
async function authenticatedFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getToken();
  if (!token) {
    throw new Error('No authentication token found');
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  // If unauthorized, clear tokens and redirect to login
  if (response.status === 401 || response.status === 403) {
    clearTokens();
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
  async register(email: string, password: string, name?: string): Promise<RegisterResponse> {
    const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Registration failed');
    }

    const data: RegisterResponse = await response.json();
    storeTokens(data.tokens);
    return data;
  },

  async login(email: string, password: string): Promise<LoginResponse> {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Login failed');
    }

    const data: LoginResponse = await response.json();
    storeTokens(data.tokens);
    return data;
  },

  async logout(): Promise<void> {
    try {
      await authenticatedFetch('/api/auth/logout', {
        method: 'POST',
      });
    } finally {
      clearTokens();
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

  isAuthenticated(): boolean {
    return !!getToken();
  },
};

/**
 * OAuth API
 */
export const oauth = {
  /**
   * Start OAuth flow for a provider
   * Redirects to backend OAuth authorization endpoint
   */
  async connect(provider: string): Promise<void> {
    const token = getToken();
    if (!token) {
      throw new Error('Please login first');
    }

    // Redirect to backend OAuth authorization endpoint with token as query parameter
    // Note: window.location.href redirect cannot send Authorization headers
    window.location.href = `${API_BASE_URL}/api/oauth/${provider}/authorize?token=${encodeURIComponent(token)}`;
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
};

/**
 * Voice Command API
 */
export const voice = {
  /**
   * Process a voice command
   */
  async processCommand(command: string): Promise<{
    success: boolean;
    type: 'single' | 'chained';
    result: any;
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
};

export default {
  auth,
  oauth,
  voice,
};
