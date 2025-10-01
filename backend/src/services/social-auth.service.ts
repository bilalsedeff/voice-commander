/**
 * Social Authentication Service
 *
 * Handles OAuth-based authentication (login/register) with social providers
 * like Google and GitHub. Different from oauth.service.ts which handles
 * service connections (Calendar, Slack, etc.)
 */

import axios from 'axios';
import { prisma } from '../config/database';
import { generateTokens } from '../utils/jwt';
import { generatePKCE, generateState } from '../utils/pkce';
import crypto from 'crypto';
import logger from '../utils/logger';

interface SocialAuthProvider {
  name: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

interface GoogleUserInfo {
  sub: string; // Google user ID
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
}

interface GitHubUserInfo {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

// Temporary storage for PKCE state (5 minutes)
const pkceStateStore = new Map<string, {
  codeVerifier: string;
  state: string;
  provider: string;
  timestamp: number;
}>();

// Cleanup expired PKCE states every minute
setInterval(() => {
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;

  for (const [key, value] of pkceStateStore.entries()) {
    if (now - value.timestamp > fiveMinutes) {
      pkceStateStore.delete(key);
    }
  }
}, 60 * 1000);

/**
 * Get provider configuration
 */
function getProviderConfig(provider: string): SocialAuthProvider {
  const configs: Record<string, SocialAuthProvider> = {
    google: {
      name: 'Google',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userInfoEndpoint: 'https://www.googleapis.com/oauth2/v3/userinfo',
      clientId: process.env.GOOGLE_AUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: process.env.GOOGLE_AUTH_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback',
      scope: 'openid email profile',
    },
    github: {
      name: 'GitHub',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      userInfoEndpoint: 'https://api.github.com/user',
      clientId: process.env.GITHUB_AUTH_CLIENT_ID || process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_AUTH_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET || '',
      redirectUri: process.env.GITHUB_AUTH_REDIRECT_URI || 'http://localhost:3001/api/auth/github/callback',
      scope: 'read:user user:email',
    },
  };

  const config = configs[provider.toLowerCase()];
  if (!config) {
    throw new Error(`Unsupported social auth provider: ${provider}`);
  }

  if (!config.clientId || !config.clientSecret) {
    throw new Error(`${config.name} authentication is not configured. Please set client ID and secret in .env`);
  }

  return config;
}

/**
 * Generate authorization URL for social login
 */
export async function getSocialAuthUrl(provider: string): Promise<string> {
  const config = getProviderConfig(provider);
  const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePKCE();
  const state = generateState();

  // Store PKCE parameters temporarily
  const stateKey = `${provider}:${state}`;
  pkceStateStore.set(stateKey, {
    codeVerifier,
    state,
    provider,
    timestamp: Date.now(),
  });

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  });

  // Google-specific parameters
  if (provider === 'google') {
    params.append('access_type', 'offline');
    params.append('prompt', 'consent');
  }

  const authUrl = `${config.authorizationEndpoint}?${params.toString()}`;

  logger.info('Generated social auth URL', {
    provider,
    state,
    redirectUri: config.redirectUri,
  });

  return authUrl;
}

/**
 * Handle OAuth callback and create/login user
 */
export async function handleSocialAuthCallback(
  provider: string,
  code: string,
  state: string
): Promise<{
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  };
  isNewUser: boolean;
}> {
  try {
    const config = getProviderConfig(provider);

    // Validate state parameter
    const stateKey = `${provider}:${state}`;
    const pkceData = pkceStateStore.get(stateKey);

    if (!pkceData) {
      throw new Error('Invalid or expired state parameter');
    }

    if (pkceData.provider !== provider) {
      throw new Error('Provider mismatch');
    }

    // Exchange code for tokens
    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        config.tokenEndpoint,
        new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          code_verifier: pkceData.codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: config.redirectUri,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        }
      );
    } catch (error) {
      logger.error('Token exchange failed', {
        provider,
        error: error instanceof Error ? error.message : String(error),
        response: (error as Error & { response?: { data?: unknown } }).response?.data,
      });
      throw new Error(`Failed to exchange code for tokens: ${error instanceof Error ? error.message : String(error)}`);
    }

    const accessToken = tokenResponse.data.access_token;

    if (!accessToken) {
      logger.error('No access token in response', { provider, data: tokenResponse.data });
      throw new Error('No access token received from provider');
    }

    logger.info('Token exchange successful', { provider, hasAccessToken: !!accessToken });

    // Get user info from provider
    let email: string;
    let name: string | null;

    if (provider === 'google') {
      let userInfoResponse;
      try {
        userInfoResponse = await axios.get<GoogleUserInfo>(
          config.userInfoEndpoint,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
      } catch (error) {
        logger.error('Failed to get user info from Google', {
          error: error instanceof Error ? error.message : String(error),
          response: (error as Error & { response?: { data?: unknown } }).response?.data,
        });
        throw new Error(`Failed to get user info: ${error instanceof Error ? error.message : String(error)}`);
      }

      const userInfo = userInfoResponse.data;

      logger.info('Google user info received', {
        hasEmail: !!userInfo.email,
        hasName: !!userInfo.name,
        hasSub: !!userInfo.sub,
        emailVerified: userInfo.email_verified,
      });

      email = userInfo.email;
      name = userInfo.name;
      // providerId = userInfo.sub; // Reserved for future use
      // avatarUrl = userInfo.picture || null; // Reserved for future use

      if (!userInfo.email_verified) {
        throw new Error('Google email not verified');
      }
    } else if (provider === 'github') {
      const userInfoResponse = await axios.get<GitHubUserInfo>(
        config.userInfoEndpoint,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      const userInfo = userInfoResponse.data;
      name = userInfo.name || userInfo.login;
      // providerId = userInfo.id.toString(); // Reserved for future use
      // avatarUrl = userInfo.avatar_url; // Reserved for future use

      // GitHub might not return email in user endpoint
      if (userInfo.email) {
        email = userInfo.email;
      } else {
        // Fetch primary email
        const emailsResponse = await axios.get<GitHubEmail[]>(
          'https://api.github.com/user/emails',
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/vnd.github.v3+json',
            },
          }
        );

        const primaryEmail = emailsResponse.data.find(e => e.primary && e.verified);
        if (!primaryEmail) {
          throw new Error('No verified email found in GitHub account');
        }
        email = primaryEmail.email;
      }
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    logger.info('About to check if user exists', { email, provider });

    // Check if user exists
    let user = await prisma.user.findUnique({
      where: { email },
    });

    logger.info('User lookup result', { userExists: !!user, email });

    let isNewUser = false;

    if (!user) {
      logger.info('Creating new user', { email, name });
      // Create new user
      user = await prisma.user.create({
        data: {
          email,
          name,
          password: crypto.randomBytes(32).toString('hex'), // Random password (won't be used)
        },
      });
      isNewUser = true;

      logger.info('New user registered via social auth', {
        provider,
        userId: user.id,
        email: user.email,
      });
    } else {
      logger.info('Existing user logged in via social auth', {
        provider,
        userId: user.id,
        email: user.email,
      });
    }

    logger.info('About to generate JWT tokens', { userId: user.id });

    // Generate JWT tokens
    const tokens = generateTokens({ userId: user.id, email: user.email });

    logger.info('JWT tokens generated', { hasAccessToken: !!tokens.accessToken, hasRefreshToken: !!tokens.refreshToken });

    // Calculate expiry
    const expiresAt = new Date(Date.now() + tokens.expiresIn);

    logger.info('About to create session', { userId: user.id });

    // Store session in database
    await prisma.session.create({
      data: {
        userId: user.id,
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt,
      },
    });

    logger.info('Session created successfully', { userId: user.id });

    // Clean up PKCE state
    pkceStateStore.delete(stateKey);

    const response = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      },
      isNewUser,
    };

    logger.info('Social auth callback complete', {
      provider,
      userId: user.id,
      isNewUser,
      hasAccessToken: !!tokens.accessToken,
      hasRefreshToken: !!tokens.refreshToken,
    });

    return response;
  } catch (error) {
    logger.error('Social auth service error', {
      provider,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
