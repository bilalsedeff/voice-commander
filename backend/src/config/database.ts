/**
 * Database Configuration - Prisma Client Singleton
 *
 * Provides singleton Prisma client instance with connection pooling and error handling.
 * Implements best practices for database connection management.
 *
 * Dependencies:
 * - @prisma/client: https://www.prisma.io/docs/concepts/components/prisma-client
 *
 * Input: DATABASE_URL from environment
 * Output: Configured Prisma client instance
 *
 * Example:
 * import prisma from '@/config/database';
 * const users = await prisma.user.findMany();
 */

import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

// Prisma client singleton
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Create Prisma client with logging configuration
const prismaClientSingleton = (): PrismaClient => {
  return new PrismaClient({
    log: [
      {
        emit: 'event',
        level: 'query'
      },
      {
        emit: 'event',
        level: 'error'
      },
      {
        emit: 'event',
        level: 'warn'
      }
    ]
  });
};

// Use global variable in development to prevent multiple instances during hot reload
const prisma = globalThis.prisma ?? prismaClientSingleton();

// Set up logging
prisma.$on('query', (e) => {
  logger.debug('Database query', {
    query: e.query,
    params: e.params,
    duration: e.duration
  });
});

prisma.$on('error', (e) => {
  logger.error('Database error', {
    message: e.message,
    target: e.target
  });
});

prisma.$on('warn', (e) => {
  logger.warn('Database warning', {
    message: e.message,
    target: e.target
  });
});

// Store in global for development hot reload
if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma;
}

/**
 * Connect to database with retry logic
 */
export async function connectDatabase(): Promise<void> {
  const maxRetries = 5;
  const retryDelay = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await prisma.$connect();
      logger.info('Database connected successfully', {
        attempt,
        database: 'PostgreSQL'
      });
      return;
    } catch (error) {
      logger.error(`Database connection failed (attempt ${attempt}/${maxRetries})`, {
        error: (error as Error).message
      });

      if (attempt < maxRetries) {
        logger.info(`Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        throw new Error(`Failed to connect to database after ${maxRetries} attempts`);
      }
    }
  }
}

/**
 * Disconnect from database gracefully
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info('Database disconnected successfully');
  } catch (error) {
    logger.error('Database disconnection failed', {
      error: (error as Error).message
    });
  }
}

/**
 * Health check - verify database connection
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export { prisma };
export default prisma;
