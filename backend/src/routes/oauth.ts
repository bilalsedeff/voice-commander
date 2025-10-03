/**
 * OAuth Routes
 *
 * Express routes for OAuth 2.0 PKCE flow with multiple providers.
 * Handles authorization requests, callbacks, and provider management.
 *
 * Dependencies:
 * - express: https://expressjs.com/
 * - ../services/oauth.service: OAuth business logic
 * - ../middleware/auth: Authentication middleware
 *
 * Routes:
 * - GET /api/oauth/:provider/authorize - Start OAuth flow
 * - GET /api/oauth/:provider/callback - OAuth callback
 * - DELETE /api/oauth/:provider/disconnect - Disconnect provider
 * - GET /api/oauth/connections - Get user's connected services
 *
 * Example:
 * GET /api/oauth/google/authorize
 * GET /api/oauth/google/callback?code=xxx&state=yyy
 */

import { Router, Request, Response } from 'express';
import * as oauthService from '../services/oauth.service';
import { authenticateToken } from '../middleware/auth';
import { mcpConnectionManagerV2 } from '../services/mcp-connection-manager-v2';
import logger from '../utils/logger';
import prisma from '../config/database';

const router = Router();

// Supported OAuth providers
const SUPPORTED_PROVIDERS = ['google', 'slack', 'notion', 'github'];

/**
 * GET /api/oauth/:provider/authorize
 * Start OAuth authorization flow
 * Requires authentication
 */
router.get(
  '/:provider/authorize',
  authenticateToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider } = req.params;

      // Validate provider
      if (!SUPPORTED_PROVIDERS.includes(provider)) {
        res.status(400).json({
          error: 'Invalid provider',
          message: `Provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`
        });
        return;
      }

      if (!req.user?.userId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'User not authenticated'
        });
        return;
      }

      // Generate authorization URL
      const authUrl = await oauthService.getAuthorizationUrl(
        provider,
        req.user.userId
      );

      logger.info('OAuth authorization started', {
        provider,
        userId: req.user.userId
      });

      // Redirect to OAuth provider
      res.redirect(authUrl);

    } catch (error) {
      logger.error('OAuth authorization failed', {
        provider: req.params.provider,
        error: (error as Error).message
      });

      res.status(500).json({
        error: 'Authorization failed',
        message: (error as Error).message
      });
    }
  }
);

/**
 * GET /api/oauth/:provider/callback
 * OAuth callback handler
 * Exchanges authorization code for tokens
 */
router.get(
  '/:provider/callback',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider } = req.params;
      const { code, state, error: oauthError } = req.query;

      // Validate provider
      if (!SUPPORTED_PROVIDERS.includes(provider)) {
        res.status(400).json({
          error: 'Invalid provider',
          message: `Provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`
        });
        return;
      }

      // Check for OAuth errors
      if (oauthError) {
        logger.error('OAuth provider returned error', {
          provider,
          error: oauthError
        });

        // Redirect to frontend with error
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}/dashboard?error=${oauthError}&provider=${provider}`);
        return;
      }

      // Validate required parameters
      if (!code || !state) {
        res.status(400).json({
          error: 'Missing parameters',
          message: 'Code and state parameters are required'
        });
        return;
      }

      // Exchange code for tokens
      const { tokens: _tokens, userId } = await oauthService.exchangeCodeForTokens(
        provider,
        code as string,
        state as string
      );

      logger.info('OAuth callback successful', {
        provider,
        userId
      });

      // ✅ Auto-connect embedded MCP (GoogleCalendarMCP, SlackMCP, etc.)
      // Uses user's OAuth tokens - no external process needed
      try {
        const mcpResult = await mcpConnectionManagerV2.connectMCPServer(userId, provider);
        if (mcpResult.success) {
          logger.info('MCP auto-connected after OAuth', {
            userId,
            provider,
            toolsCount: mcpResult.toolsCount
          });
        } else {
          logger.warn('MCP auto-connect failed after OAuth', {
            userId,
            provider,
            error: mcpResult.error
          });
        }
      } catch (mcpError) {
        logger.error('MCP auto-connect error', {
          userId,
          provider,
          error: (mcpError as Error).message
        });
      }

      // Redirect to frontend with success
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      res.redirect(`${frontendUrl}/dashboard?success=true&provider=${provider}`);

    } catch (error) {
      logger.error('OAuth callback failed', {
        provider: req.params.provider,
        error: (error as Error).message
      });

      // Redirect to frontend with error
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      res.redirect(`${frontendUrl}/dashboard?error=callback_failed&provider=${req.params.provider}`);
    }
  }
);

/**
 * DELETE /api/oauth/:provider/disconnect
 * Disconnect OAuth provider
 * Requires authentication
 */
router.delete(
  '/:provider/disconnect',
  authenticateToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider } = req.params;

      // Validate provider
      if (!SUPPORTED_PROVIDERS.includes(provider)) {
        res.status(400).json({
          error: 'Invalid provider',
          message: `Provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`
        });
        return;
      }

      if (!req.user?.userId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'User not authenticated'
        });
        return;
      }

      // Disconnect provider
      await oauthService.disconnectProvider(
        req.user.userId,
        provider
      );

      logger.info('OAuth provider disconnected via API', {
        provider,
        userId: req.user.userId
      });

      // ✅ Disconnect embedded MCP
      try {
        await mcpConnectionManagerV2.disconnectMCPServer(req.user.userId, provider);
        logger.info('MCP disconnected after OAuth disconnect', {
          userId: req.user.userId,
          provider
        });
      } catch (mcpError) {
        // Don't fail OAuth disconnect if MCP disconnect fails
        logger.warn('MCP disconnect failed', {
          userId: req.user.userId,
          provider,
          error: (mcpError as Error).message
        });
      }

      res.status(200).json({
        success: true,
        message: `${provider} disconnected successfully`
      });

    } catch (error) {
      logger.error('OAuth disconnect failed', {
        provider: req.params.provider,
        error: (error as Error).message
      });

      res.status(500).json({
        error: 'Disconnect failed',
        message: (error as Error).message
      });
    }
  }
);

/**
 * GET /api/oauth/connections
 * Get user's connected OAuth providers
 * Requires authentication
 */
router.get(
  '/connections',
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

      // Get all service connections for user
      const connections = await prisma.serviceConnection.findMany({
        where: {
          userId: req.user.userId
        },
        select: {
          provider: true,
          connected: true,
          lastSync: true,
          mcpConnected: true,
          mcpStatus: true,
          mcpLastHealthCheck: true,
          mcpError: true,
          mcpToolsCount: true,
          createdAt: true,
          updatedAt: true
        }
      });

      res.status(200).json({
        success: true,
        connections
      });

    } catch (error) {
      logger.error('Failed to get OAuth connections', {
        error: (error as Error).message,
        userId: req.user?.userId
      });

      res.status(500).json({
        error: 'Failed to get connections',
        message: (error as Error).message
      });
    }
  }
);

export default router;
