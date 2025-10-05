/**
 * Voice Commander Backend API Server
 *
 * Express server for web-based voice orchestration platform.
 * Provides REST API endpoints for authentication, OAuth, service management, and voice commands.
 *
 * Dependencies:
 * - express: https://expressjs.com/
 * - cors: https://github.com/expressjs/cors
 * - helmet: https://helmetjs.github.io/
 * - @prisma/client: Database ORM
 *
 * Routes:
 * - /api/auth/* - Authentication endpoints
 * - /api/oauth/* - OAuth flow endpoints
 * - /api/services/* - Service management
 * - /api/voice/* - Voice command processing
 * - /health - Health check
 *
 * Example:
 * npm run dev (development with hot reload)
 * npm run build && npm start (production)
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import logger, { morganStream } from './utils/logger';
import { connectDatabase, disconnectDatabase, healthCheck } from './config/database';
import { apiRateLimiter } from './middleware/auth';
import authRoutes from './routes/auth';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = parseInt(process.env.PORT || '3001');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Cookie parsing middleware
app.use(cookieParser());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logging (Morgan → Winston)
import morgan from 'morgan';
app.use(morgan('combined', { stream: morganStream }));

// API rate limiting
app.use('/api', apiRateLimiter);

// ============================================================================
// ROUTES
// ============================================================================

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const dbHealthy = await healthCheck();

    const health = {
      status: dbHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbHealthy ? 'connected' : 'disconnected',
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: 'MB'
      }
    };

    const statusCode = dbHealthy ? 200 : 503;
    res.status(statusCode).json(health);

  } catch (error) {
    logger.error('Health check failed', {
      error: (error as Error).message
    });

    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    });
  }
});

// API version endpoint
app.get('/api', (_req: Request, res: Response) => {
  res.json({
    name: 'Voice Commander API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      auth: '/api/auth',
      oauth: '/api/oauth',
      services: '/api/services',
      voice: '/api/voice',
      health: '/health'
    }
  });
});

// Authentication routes
app.use('/api/auth', authRoutes);

// OAuth routes
import oauthRoutes from './routes/oauth';
app.use('/api/oauth', oauthRoutes);

// Service management routes (to be implemented)
// app.use('/api/services', serviceRoutes);

// Voice command routes
import voiceRoutes from './routes/voice';
app.use('/api/voice', voiceRoutes);

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((req: Request, res: Response) => {
  logger.warn('Route not found', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`,
    availableEndpoints: {
      auth: '/api/auth',
      health: '/health'
    }
  });
});

// Global error handler
app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', {
    error: error.message,
    stack: error.stack,
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : error.message
  });
});

// ============================================================================
// SERVER LIFECYCLE
// ============================================================================

/**
 * Start server
 */
async function startServer(): Promise<void> {
  try {
    logger.info('Starting Voice Commander Backend API Server...');

    // Connect to database
    logger.info('Connecting to database...');
    await connectDatabase();
    logger.info('✅ Database connected successfully');

    // Start HTTP server
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Voice Commander Backend API Server running`, {
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        frontendUrl: FRONTEND_URL,
        database: 'PostgreSQL'
      });

      console.log('\n🎤 Voice Commander Backend API Server\n');
      console.log('📍 Server Information:');
      console.log(`   • Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   • Port: ${PORT}`);
      console.log(`   • Frontend URL: ${FRONTEND_URL}`);
      console.log(`   • Database: PostgreSQL`);
      console.log('\n📍 API Endpoints:');
      console.log(`   • Health Check:    http://localhost:${PORT}/health`);
      console.log(`   • API Info:        http://localhost:${PORT}/api`);
      console.log(`   • Authentication:  http://localhost:${PORT}/api/auth`);
      console.log('\n🔑 Authentication Endpoints:');
      console.log(`   • POST /api/auth/register - Register new user`);
      console.log(`   • POST /api/auth/login - Login user`);
      console.log(`   • POST /api/auth/refresh - Refresh access token`);
      console.log(`   • POST /api/auth/logout - Logout user`);
      console.log(`   • GET /api/auth/me - Get current user`);
      console.log('\n📝 Next Steps:');
      console.log('   1. Ensure DATABASE_URL is set in .env');
      console.log('   2. Run: npm run db:push (to create tables)');
      console.log('   3. Test: POST http://localhost:3001/api/auth/register');
      console.log('\n🛑 To stop: Ctrl+C\n');
    });

    // Graceful shutdown
    process.on('SIGINT', () => gracefulShutdown(server, 'SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown(server, 'SIGTERM'));

  } catch (error) {
    logger.error('Failed to start server', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
async function gracefulShutdown(
  server: ReturnType<typeof app.listen>,
  signal: string
): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    // Disconnect from database
    await disconnectDatabase();

    logger.info('✅ Graceful shutdown completed');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// Start server if this file is run directly
if (require.main === module) {
  startServer();
}

export default app;
