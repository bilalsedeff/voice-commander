/**
 * Winston Logger Configuration
 *
 * Centralized logging utility for backend API server.
 * Provides structured JSON logging with different log levels and transports.
 *
 * Dependencies:
 * - winston: https://github.com/winstonjs/winston
 *
 * Input: Log level from environment, log messages with metadata
 * Output: Formatted logs to console and file (production)
 *
 * Example:
 * logger.info('User logged in', { userId: '123', ip: '127.0.0.1' });
 * logger.error('Authentication failed', { error: error.message });
 */

import winston from 'winston';
import path from 'path';

// Log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4
};

// Log colors for console output
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'cyan'
};

// Add colors to winston
winston.addColors(colors);

// Determine log level from environment
const level = (): string => {
  const env = process.env.NODE_ENV || 'development';
  const isDevelopment = env === 'development';
  return isDevelopment ? 'debug' : 'info';
};

// Custom format for console output (development)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}${
      Object.keys(info).length > 3 ? ' ' + JSON.stringify(
        Object.fromEntries(
          Object.entries(info).filter(([key]) => !['timestamp', 'level', 'message'].includes(key))
        )
      ) : ''
    }`
  )
);

// JSON format for file output (production)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create transports
const transports: winston.transport[] = [
  // Console transport (always active)
  new winston.transports.Console({
    format: consoleFormat
  })
];

// Add file transports in production
if (process.env.NODE_ENV === 'production') {
  const logsDir = path.join(process.cwd(), 'logs');

  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: level(),
  levels,
  transports,
  // Don't exit on handled exceptions
  exitOnError: false
});

// Stream for Morgan HTTP logging middleware
export const morganStream = {
  write: (message: string) => {
    logger.http(message.trim());
  }
};

export default logger;

// Validation function for testing
if (require.main === module) {
  console.log('📝 Testing logger utility...\n');

  try {
    // Test different log levels
    logger.error('Test error message', { code: 'ERR001' });
    logger.warn('Test warning message', { userId: '123' });
    logger.info('Test info message', { action: 'login' });
    logger.http('Test HTTP message', { method: 'GET', path: '/api/test' });
    logger.debug('Test debug message', { data: { key: 'value' } });

    console.log('\n✅ Logger tests passed!');
    console.log('Check console output above for formatted logs');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Logger test failed:', (error as Error).message);
    process.exit(1);
  }
}
