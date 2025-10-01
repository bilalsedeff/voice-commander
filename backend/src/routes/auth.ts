/**
 * Authentication Routes
 *
 * Express routes for user authentication: register, login, token refresh, logout.
 * Implements secure authentication flow with rate limiting and input validation.
 *
 * Dependencies:
 * - express: https://expressjs.com/
 * - @/services/auth.service: Authentication business logic
 * - @/middleware/auth: Authentication middleware
 *
 * Routes:
 * - POST /api/auth/register - Register new user
 * - POST /api/auth/login - Login existing user
 * - POST /api/auth/refresh - Refresh access token
 * - POST /api/auth/logout - Logout user
 * - GET /api/auth/me - Get current user profile
 *
 * Example:
 * POST /api/auth/register
 * Body: { "email": "user@example.com", "password": "password123", "name": "John Doe" }
 */

import { Router, Request, Response } from 'express';
import * as authService from '../services/auth.service';
import * as socialAuthService from '../services/social-auth.service';
import { authenticateToken, authRateLimiter } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post(
  '/register',
  authRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, password, name } = req.body;

      // Validate request body
      if (!email || !password || !name) {
        res.status(400).json({
          error: 'Validation error',
          message: 'Email, password, and name are required'
        });
        return;
      }

      // Register user
      const result = await authService.register({
        email,
        password,
        name
      });

      logger.info('User registered via API', {
        userId: result.user.id,
        email: result.user.email,
        ip: req.ip
      });

      res.status(201).json({
        success: true,
        user: result.user,
        tokens: result.tokens
      });

    } catch (error) {
      logger.error('Register API error', {
        error: (error as Error).message,
        ip: req.ip
      });

      // Handle specific error messages
      const message = (error as Error).message;
      if (message.includes('already registered')) {
        res.status(409).json({
          error: 'Email already exists',
          message
        });
        return;
      }

      if (message.includes('Invalid email') || message.includes('Password must')) {
        res.status(400).json({
          error: 'Validation error',
          message
        });
        return;
      }

      res.status(500).json({
        error: 'Registration failed',
        message: 'An error occurred during registration'
      });
    }
  }
);

/**
 * POST /api/auth/login
 * Login existing user
 */
router.post(
  '/login',
  authRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, password } = req.body;

      // Validate request body
      if (!email || !password) {
        res.status(400).json({
          error: 'Validation error',
          message: 'Email and password are required'
        });
        return;
      }

      // Login user
      const result = await authService.login({
        email,
        password
      });

      logger.info('User logged in via API', {
        userId: result.user.id,
        email: result.user.email,
        ip: req.ip
      });

      res.status(200).json({
        success: true,
        user: result.user,
        tokens: result.tokens
      });

    } catch (error) {
      logger.error('Login API error', {
        error: (error as Error).message,
        ip: req.ip
      });

      // Handle specific error messages
      const message = (error as Error).message;
      if (message.includes('Invalid email or password')) {
        res.status(401).json({
          error: 'Authentication failed',
          message: 'Invalid email or password'
        });
        return;
      }

      res.status(500).json({
        error: 'Login failed',
        message: 'An error occurred during login'
      });
    }
  }
);

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post(
  '/refresh',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { refreshToken } = req.body;

      // Validate request body
      if (!refreshToken) {
        res.status(400).json({
          error: 'Validation error',
          message: 'Refresh token is required'
        });
        return;
      }

      // Refresh token
      const tokens = await authService.refreshAccessToken({ refreshToken });

      logger.info('Token refreshed via API', {
        ip: req.ip
      });

      res.status(200).json({
        success: true,
        tokens
      });

    } catch (error) {
      logger.error('Refresh token API error', {
        error: (error as Error).message,
        ip: req.ip
      });

      // Handle specific error messages
      const message = (error as Error).message;
      if (message.includes('expired') || message.includes('Invalid')) {
        res.status(401).json({
          error: 'Invalid refresh token',
          message
        });
        return;
      }

      res.status(500).json({
        error: 'Token refresh failed',
        message: 'An error occurred while refreshing token'
      });
    }
  }
);

/**
 * POST /api/auth/logout
 * Logout user (invalidate refresh token)
 */
router.post(
  '/logout',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { refreshToken } = req.body;

      if (refreshToken) {
        await authService.logout(refreshToken);
      }

      logger.info('User logged out via API', {
        ip: req.ip
      });

      res.status(200).json({
        success: true,
        message: 'Logged out successfully'
      });

    } catch (error) {
      logger.error('Logout API error', {
        error: (error as Error).message,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Logout failed',
        message: 'An error occurred during logout'
      });
    }
  }
);

/**
 * GET /api/auth/me
 * Get current user profile (requires authentication)
 */
router.get(
  '/me',
  authenticateToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user?.userId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'User not authenticated'
        });
        return;
      }

      // Get user profile
      const user = await authService.getUserProfile(req.user.userId);

      res.status(200).json({
        success: true,
        user
      });

    } catch (error) {
      logger.error('Get profile API error', {
        error: (error as Error).message,
        userId: req.user?.userId
      });

      res.status(500).json({
        error: 'Failed to get profile',
        message: 'An error occurred while fetching user profile'
      });
    }
  }
);

/**
 * GET /api/auth/:provider
 * Start social authentication (Google, GitHub)
 */
router.get(
  '/:provider',
  authRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider } = req.params;

      if (!['google', 'github'].includes(provider.toLowerCase())) {
        res.status(400).json({
          error: 'Invalid provider',
          message: 'Supported providers: google, github'
        });
        return;
      }

      // Generate authorization URL
      const authUrl = await socialAuthService.getSocialAuthUrl(provider);

      // Redirect to provider OAuth page
      res.redirect(authUrl);

    } catch (error) {
      logger.error('Social auth initiation error', {
        provider: req.params.provider,
        error: (error as Error).message
      });

      res.status(500).json({
        error: 'Authentication failed',
        message: (error as Error).message
      });
    }
  }
);

/**
 * GET /api/auth/:provider/callback
 * Handle OAuth callback from social provider
 */
router.get(
  '/:provider/callback',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider } = req.params;
      const { code, state, error: oauthError } = req.query;

      // Handle OAuth errors from provider
      if (oauthError) {
        const errorDescription = req.query.error_description || oauthError;
        logger.error('OAuth callback error from provider', {
          provider,
          error: oauthError,
          description: errorDescription
        });

        res.redirect(`${process.env.FRONTEND_URL}/login?error=${encodeURIComponent(errorDescription as string)}`);
        return;
      }

      if (!code || !state) {
        res.redirect(`${process.env.FRONTEND_URL}/login?error=Missing+authorization+code`);
        return;
      }

      // Exchange code for tokens and create/login user
      const result = await socialAuthService.handleSocialAuthCallback(
        provider,
        code as string,
        state as string
      );

      logger.info('Social auth successful', {
        provider,
        userId: result.user.id,
        isNewUser: result.isNewUser
      });

      // Redirect to frontend with tokens in URL (will be moved to localStorage)
      const redirectUrl = new URL(`${process.env.FRONTEND_URL}/auth/callback`);
      redirectUrl.searchParams.set('access_token', result.tokens.accessToken);
      redirectUrl.searchParams.set('refresh_token', result.tokens.refreshToken);
      redirectUrl.searchParams.set('expires_in', result.tokens.expiresIn.toString());
      redirectUrl.searchParams.set('is_new_user', result.isNewUser.toString());

      res.redirect(redirectUrl.toString());

    } catch (error) {
      logger.error('Social auth callback error', {
        provider: req.params.provider,
        error: (error as Error).message
      });

      res.redirect(`${process.env.FRONTEND_URL}/login?error=${encodeURIComponent((error as Error).message)}`);
    }
  }
);

export default router;
