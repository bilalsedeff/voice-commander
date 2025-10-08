/**
 * OAuth Service
 *
 * Handles OAuth 2.0 PKCE flow for multiple providers (Google, Slack, Notion, GitHub).
 * Implements secure authorization, token exchange, and token refresh.
 *
 * Dependencies:
 * - axios: HTTP client
 * - @prisma/client: Database ORM
 * - crypto: Node.js crypto module
 *
 * Input: Provider name, OAuth codes, user credentials
 * Output: Authorization URLs, access tokens, user data
 *
 * Example:
 * const authUrl = await oauthService.getAuthorizationUrl('google', userId);
 * const tokens = await oauthService.exchangeCodeForTokens('google', code, codeVerifier);
 */

import axios from 'axios';
import prisma from '../config/database';
import logger from '../utils/logger';
import { generatePKCE, generateState } from '../utils/pkce';
import { encryptToken, decryptToken } from '../utils/encryption';

// OAuth provider configuration
interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  userInfoEndpoint?: string;
}

// OAuth tokens response
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}

// OAuth user info
export interface OAuthUserInfo {
  id: string;
  email?: string;
  name?: string;
  picture?: string;
}

// PKCE state data type
type PKCEStateData = {
  codeVerifier: string;
  state: string;
  userId: string;
  provider: string;
  timestamp: number;
};

// Temporary PKCE state storage (in production, use Redis)
const pkceStateStore = new Map<string, PKCEStateData>();

/**
 * Get OAuth provider configuration
 */
function getProviderConfig(provider: string): OAuthProviderConfig {
  const configs: Record<string, OAuthProviderConfig> = {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/oauth/google/callback',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userInfoEndpoint: 'https://www.googleapis.com/oauth2/v2/userinfo',
      scopes: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/contacts.readonly',
        'https://www.googleapis.com/auth/contacts',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
      ]
    },
    slack: {
      clientId: process.env.SLACK_CLIENT_ID || '',
      clientSecret: process.env.SLACK_CLIENT_SECRET || '',
      redirectUri: process.env.SLACK_REDIRECT_URI || 'http://localhost:3001/api/oauth/slack/callback',
      authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
      tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
      scopes: [
        'channels:read',
        'chat:write',
        'users:read',
        'users:read.email'
      ]
    },
    notion: {
      clientId: process.env.NOTION_CLIENT_ID || '',
      clientSecret: process.env.NOTION_CLIENT_SECRET || '',
      redirectUri: process.env.NOTION_REDIRECT_URI || 'http://localhost:3001/api/oauth/notion/callback',
      authorizationEndpoint: 'https://api.notion.com/v1/oauth/authorize',
      tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
      scopes: [] // Notion doesn't use scopes in URL
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      redirectUri: process.env.GITHUB_REDIRECT_URI || 'http://localhost:3001/api/oauth/github/callback',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      userInfoEndpoint: 'https://api.github.com/user',
      scopes: ['user:email', 'repo']
    }
  };

  const config = configs[provider];
  if (!config) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  // Validate configuration
  if (!config.clientId || !config.clientSecret) {
    throw new Error(`OAuth provider ${provider} is not configured. Missing client ID or secret.`);
  }

  return config;
}

/**
 * Generate OAuth authorization URL with PKCE
 *
 * @param provider - OAuth provider name
 * @param userId - User ID requesting authorization
 * @returns Authorization URL to redirect user
 */
export async function getAuthorizationUrl(
  provider: string,
  userId: string
): Promise<string> {
  try {
    const config = getProviderConfig(provider);
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePKCE();
    const state = generateState();

    // Store PKCE parameters temporarily (5 minutes expiry)
    const stateKey = `${userId}:${provider}:${state}`;
    pkceStateStore.set(stateKey, {
      codeVerifier,
      state,
      userId,
      provider,
      timestamp: Date.now()
    });

    // Clean up expired entries (older than 5 minutes)
    cleanupExpiredPKCEStates();

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod
    });

    // Add scopes if provider uses them
    if (config.scopes.length > 0) {
      params.append('scope', config.scopes.join(' '));
    }

    // Provider-specific parameters
    if (provider === 'google') {
      params.append('access_type', 'offline'); // Get refresh token
      params.append('prompt', 'consent'); // Force consent screen
    }

    const authUrl = `${config.authorizationEndpoint}?${params.toString()}`;

    logger.info('OAuth authorization URL generated', {
      provider,
      userId,
      state
    });

    return authUrl;

  } catch (error) {
    logger.error('Failed to generate authorization URL', {
      provider,
      userId,
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Exchange authorization code for tokens
 *
 * @param provider - OAuth provider name
 * @param code - Authorization code from callback
 * @param state - State parameter for CSRF validation
 * @returns Access and refresh tokens
 */
export async function exchangeCodeForTokens(
  provider: string,
  code: string,
  state: string
): Promise<{ tokens: OAuthTokens; userId: string }> {
  try {
    // Find and validate PKCE state
    let pkceData: PKCEStateData | undefined = undefined;
    let stateKey = '';

    for (const [key, value] of pkceStateStore.entries()) {
      if (value.state === state && value.provider === provider) {
        pkceData = value;
        stateKey = key;
        break;
      }
    }

    if (!pkceData) {
      throw new Error('Invalid or expired state parameter');
    }

    // Remove used PKCE data
    pkceStateStore.delete(stateKey);

    const config = getProviderConfig(provider);

    // Exchange code for tokens
    const tokenResponse = await axios.post(
      config.tokenEndpoint,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: pkceData.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }
    );

    const tokens: OAuthTokens = {
      accessToken: tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token,
      expiresIn: tokenResponse.data.expires_in,
      scope: tokenResponse.data.scope
    };

    // Store tokens in database (encrypted)
    await storeOAuthTokens(pkceData.userId, provider, tokens);

    logger.info('OAuth tokens exchanged successfully', {
      provider,
      userId: pkceData.userId
    });

    return {
      tokens,
      userId: pkceData.userId
    };

  } catch (error) {
    logger.error('Failed to exchange authorization code', {
      provider,
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Store OAuth tokens in database (encrypted)
 */
async function storeOAuthTokens(
  userId: string,
  provider: string,
  tokens: OAuthTokens
): Promise<void> {
  try {
    const encryptedAccessToken = encryptToken(tokens.accessToken);
    const encryptedRefreshToken = tokens.refreshToken
      ? encryptToken(tokens.refreshToken)
      : null;

    const expiresAt = tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000)
      : null;

    // ALWAYS store in OAuthToken table (for embedded MCP like GoogleCalendarMCP)
    await prisma.oAuthToken.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
        scope: tokens.scope
      },
      update: {
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
        scope: tokens.scope,
        updatedAt: new Date()
      }
    });

    // Find MCP server for this provider
    const mcpServer = await prisma.mCPServer.findFirst({
      where: { provider, authType: 'oauth' }
    });

    if (mcpServer) {
      // Also store in UserMCPConfig table (for process-based MCP)
      await prisma.userMCPConfig.upsert({
        where: {
          userId_mcpServerId: {
            userId,
            mcpServerId: mcpServer.id
          }
        },
        create: {
          userId,
          mcpServerId: mcpServer.id,
          oauthAccessToken: encryptedAccessToken,
          oauthRefreshToken: encryptedRefreshToken,
          oauthExpiresAt: expiresAt,
          status: 'disconnected'
        },
        update: {
          oauthAccessToken: encryptedAccessToken,
          oauthRefreshToken: encryptedRefreshToken,
          oauthExpiresAt: expiresAt,
          status: 'disconnected',
          updatedAt: new Date()
        }
      });
    }

    // Update service connection status (for frontend compatibility)
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
        connected: true,
        lastSync: new Date()
      },
      update: {
        connected: true,
        lastSync: new Date(),
        updatedAt: new Date()
      }
    });

    logger.info('OAuth tokens stored successfully', {
      userId,
      provider,
      mcpServerId: mcpServer?.id
    });

    // ✅ MCP connection handled by MCPConnectionManagerV2 (embedded GoogleCalendarMCP)
    // No external process needed - uses user's OAuth tokens directly with googleapis

  } catch (error) {
    logger.error('Failed to store OAuth tokens', {
      userId,
      provider,
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Get stored OAuth tokens for user and provider
 */
export async function getOAuthTokens(
  userId: string,
  provider: string
): Promise<OAuthTokens | null> {
  try {
    const tokenRecord = await prisma.oAuthToken.findUnique({
      where: {
        userId_provider: {
          userId,
          provider
        }
      }
    });

    if (!tokenRecord) {
      return null;
    }

    // Decrypt tokens
    const accessToken = decryptToken(tokenRecord.accessToken);
    const refreshToken = tokenRecord.refreshToken
      ? decryptToken(tokenRecord.refreshToken)
      : undefined;

    return {
      accessToken,
      refreshToken,
      expiresIn: tokenRecord.expiresAt
        ? Math.floor((tokenRecord.expiresAt.getTime() - Date.now()) / 1000)
        : undefined,
      scope: tokenRecord.scope || undefined
    };

  } catch (error) {
    logger.error('Failed to get OAuth tokens', {
      userId,
      provider,
      error: (error as Error).message
    });
    return null;
  }
}

/**
 * Disconnect OAuth provider for user
 */
export async function disconnectProvider(
  userId: string,
  provider: string
): Promise<void> {
  try {
    // Delete OAuth tokens
    await prisma.oAuthToken.deleteMany({
      where: {
        userId,
        provider
      }
    });

    // Update service connection status
    await prisma.serviceConnection.updateMany({
      where: {
        userId,
        provider
      },
      data: {
        connected: false,
        updatedAt: new Date()
      }
    });

    logger.info('OAuth provider disconnected', {
      userId,
      provider
    });

  } catch (error) {
    logger.error('Failed to disconnect provider', {
      userId,
      provider,
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Clean up expired PKCE states (older than 5 minutes)
 */
function cleanupExpiredPKCEStates(): void {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

  for (const [key, value] of pkceStateStore.entries()) {
    if (value.timestamp < fiveMinutesAgo) {
      pkceStateStore.delete(key);
    }
  }
}
