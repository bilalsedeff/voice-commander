/**
 * JWT Utility for Authentication
 *
 * Provides secure JWT token generation and verification for user authentication.
 * Implements access token + refresh token pattern for enhanced security.
 *
 * Dependencies:
 * - jsonwebtoken: https://github.com/auth0/node-jsonwebtoken
 *
 * Input: User payload, JWT secrets from environment
 * Output: Signed JWT tokens or verified payload
 *
 * Example:
 * const { accessToken, refreshToken } = generateTokens({ userId: "123" });
 * const payload = verifyAccessToken(accessToken);
 */

import jwt from 'jsonwebtoken';

// JWT payload interface
export interface JWTPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

// Token pair interface
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Get JWT secret from environment
 */
function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters for security');
  }

  return secret;
}

/**
 * Get JWT refresh secret from environment
 */
function getJWTRefreshSecret(): string {
  const secret = process.env.JWT_REFRESH_SECRET;

  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET environment variable is required');
  }

  if (secret.length < 32) {
    throw new Error('JWT_REFRESH_SECRET must be at least 32 characters for security');
  }

  return secret;
}

/**
 * Generate access and refresh tokens for user
 *
 * @param payload - User data to encode in token
 * @returns Token pair with access and refresh tokens
 */
export function generateTokens(payload: Omit<JWTPayload, 'iat' | 'exp'>): TokenPair {
  if (!payload.userId || !payload.email) {
    throw new Error('userId and email are required in JWT payload');
  }

  const secret = getJWTSecret();
  const refreshSecret = getJWTRefreshSecret();

  // Access token expires in 24 hours (configurable)
  const expiresIn = process.env.JWT_EXPIRES_IN || '24h';
  const accessToken = jwt.sign(payload, secret, {
    expiresIn,
    algorithm: 'HS256'
  } as jwt.SignOptions);

  // Refresh token expires in 7 days (configurable)
  const refreshExpiresIn = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
  const refreshToken = jwt.sign(payload, refreshSecret, {
    expiresIn: refreshExpiresIn,
    algorithm: 'HS256'
  } as jwt.SignOptions);

  // Convert expiresIn to milliseconds for frontend
  const expiresInMs = convertExpiresIn(expiresIn);

  return {
    accessToken,
    refreshToken,
    expiresIn: expiresInMs
  };
}

/**
 * Verify access token
 *
 * @param token - JWT access token to verify
 * @returns Decoded payload if valid
 * @throws Error if token is invalid or expired
 */
export function verifyAccessToken(token: string): JWTPayload {
  if (!token) {
    throw new Error('Token is required');
  }

  const secret = getJWTSecret();

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256']
    }) as JWTPayload;

    return decoded;
  } catch (error) {
    if ((error as Error).name === 'TokenExpiredError') {
      throw new Error('Access token expired');
    }
    if ((error as Error).name === 'JsonWebTokenError') {
      throw new Error('Invalid access token');
    }
    throw error;
  }
}

/**
 * Verify refresh token
 *
 * @param token - JWT refresh token to verify
 * @returns Decoded payload if valid
 * @throws Error if token is invalid or expired
 */
export function verifyRefreshToken(token: string): JWTPayload {
  if (!token) {
    throw new Error('Refresh token is required');
  }

  const secret = getJWTRefreshSecret();

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256']
    }) as JWTPayload;

    return decoded;
  } catch (error) {
    if ((error as Error).name === 'TokenExpiredError') {
      throw new Error('Refresh token expired');
    }
    if ((error as Error).name === 'JsonWebTokenError') {
      throw new Error('Invalid refresh token');
    }
    throw error;
  }
}

/**
 * Decode token without verification (for debugging only)
 *
 * @param token - JWT token to decode
 * @returns Decoded payload (unverified)
 */
export function decodeToken(token: string): JWTPayload | null {
  try {
    return jwt.decode(token) as JWTPayload;
  } catch {
    return null;
  }
}

/**
 * Convert expiresIn string to milliseconds
 *
 * @param expiresIn - Duration string (e.g., "24h", "7d")
 * @returns Duration in milliseconds
 */
function convertExpiresIn(expiresIn: string): number {
  const value = parseInt(expiresIn);
  const unit = expiresIn.slice(-1);

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000; // Default 24 hours
  }
}

// Validation function for testing
if (require.main === module) {
  console.log('🔑 Testing JWT utility...\n');

  try {
    // Set test JWT secrets
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long-for-security';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-characters-long-for-security';

    // Test 1: Generate tokens
    console.log('Test 1: Generate tokens');
    const payload = {
      userId: '123e4567-e89b-12d3-a456-426614174000',
      email: 'test@example.com'
    };
    const tokens = generateTokens(payload);
    console.log(`✓ Access token: ${tokens.accessToken.substring(0, 30)}...`);
    console.log(`✓ Refresh token: ${tokens.refreshToken.substring(0, 30)}...`);
    console.log(`✓ Expires in: ${tokens.expiresIn}ms`);

    // Test 2: Verify access token
    console.log('\nTest 2: Verify access token');
    const verified = verifyAccessToken(tokens.accessToken);
    console.log(`✓ Verified userId: ${verified.userId}`);
    console.log(`✓ Verified email: ${verified.email}`);

    if (verified.userId !== payload.userId || verified.email !== payload.email) {
      throw new Error('Token payload mismatch');
    }

    // Test 3: Verify refresh token
    console.log('\nTest 3: Verify refresh token');
    const verifiedRefresh = verifyRefreshToken(tokens.refreshToken);
    console.log(`✓ Verified refresh userId: ${verifiedRefresh.userId}`);

    // Test 4: Decode token
    console.log('\nTest 4: Decode token (unverified)');
    const decoded = decodeToken(tokens.accessToken);
    console.log(`✓ Decoded payload: ${JSON.stringify(decoded)}`);

    // Test 5: Error handling - invalid token
    console.log('\nTest 5: Error handling');
    try {
      verifyAccessToken('invalid-token');
      throw new Error('Should have thrown error for invalid token');
    } catch (error) {
      if ((error as Error).message.includes('Invalid access token')) {
        console.log('✓ Invalid token error handled correctly');
      } else {
        throw error;
      }
    }

    // Test 6: Error handling - missing payload fields
    try {
      generateTokens({ userId: '', email: 'test@example.com' });
      throw new Error('Should have thrown error for empty userId');
    } catch (error) {
      if ((error as Error).message.includes('userId and email are required')) {
        console.log('✓ Missing payload error handled correctly');
      } else {
        throw error;
      }
    }

    console.log('\n✅ All JWT tests passed!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ JWT test failed:', (error as Error).message);
    process.exit(1);
  }
}
