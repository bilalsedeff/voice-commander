/**
 * Authentication Middleware
 *
 * Verifies JWT tokens in request headers and attaches user info to request object.
 * Implements secure authentication flow with proper error handling.
 *
 * Dependencies:
 * - express: https://expressjs.com/
 * - @/utils/jwt: JWT verification utilities
 * - @/utils/logger: Winston logger
 *
 * Input: Request with Authorization header containing Bearer token
 * Output: Authenticated request with user info or 401 error
 *
 * Example:
 * app.get('/api/protected', authenticateToken, (req, res) => {
 *   res.json({ user: req.user });
 * });
 */

import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JWTPayload } from '../utils/jwt';
import logger from '../utils/logger';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/**
 * Authenticate JWT token from Authorization header
 *
 * Expects header format: "Authorization: Bearer <token>"
 */
export function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    // Extract token from Authorization header or query parameter
    const authHeader = req.headers['authorization'];
    let token = authHeader?.split(' ')[1]; // Bearer <token>

    // Fallback to query parameter (for OAuth redirects that can't send headers)
    if (!token && req.query.token && typeof req.query.token === 'string') {
      token = req.query.token;
      logger.debug('Token extracted from query parameter', { path: req.path });
    }

    if (!token) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'No token provided'
      });
      return;
    }

    // Verify token
    const payload = verifyAccessToken(token);

    // Attach user info to request
    req.user = payload;

    logger.debug('Token authenticated successfully', {
      userId: payload.userId,
      email: payload.email,
      path: req.path
    });

    next();

  } catch (error) {
    logger.warn('Authentication failed', {
      error: (error as Error).message,
      path: req.path,
      ip: req.ip
    });

    if ((error as Error).message === 'Access token expired') {
      res.status(401).json({
        error: 'Token expired',
        message: 'Please refresh your token'
      });
      return;
    }

    res.status(403).json({
      error: 'Invalid token',
      message: 'Authentication failed'
    });
  }
}

/**
 * Optional authentication middleware
 *
 * Attaches user if token is present, but doesn't require it
 * Useful for endpoints that work for both authenticated and anonymous users
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];

    if (token) {
      const payload = verifyAccessToken(token);
      req.user = payload;

      logger.debug('Optional auth: Token found and verified', {
        userId: payload.userId
      });
    } else {
      logger.debug('Optional auth: No token provided, continuing as anonymous');
    }

    next();

  } catch (error) {
    logger.debug('Optional auth: Invalid token, continuing as anonymous', {
      error: (error as Error).message
    });
    next();
  }
}

/**
 * Rate limiting middleware for authentication endpoints
 *
 * Prevents brute force attacks by limiting requests per IP
 */
import rateLimit from 'express-rate-limit';

export const authRateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '5'), // 5 requests per window
  message: {
    error: 'Too many requests',
    message: 'Too many authentication attempts, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path
    });

    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many authentication attempts, please try again later'
    });
  }
});

/**
 * General API rate limiter
 *
 * Protects all API endpoints from abuse
 */
export const apiRateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'), // 100 requests per window
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded, please slow down'
  },
  standardHeaders: true,
  legacyHeaders: false
});
