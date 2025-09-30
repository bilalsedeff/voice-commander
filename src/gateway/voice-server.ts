/**
 * Voice MCP Gateway - Main Server
 *
 * Integrates all components: WebSocket server, voice processing, MCP client,
 * and web dashboard for complete voice-enabled MCP gateway functionality.
 *
 * Dependencies:
 * - All project components
 * - dotenv: https://github.com/motdotla/dotenv
 * - express: https://expressjs.com/
 *
 * Input: Environment configuration, voice commands, MCP connections
 * Output: Real-time voice processing with MCP integration
 *
 * Example:
 * npm run dev
 * // Starts complete voice MCP gateway on ports 8720 (HTTP) and 8721 (WebSocket)
 */

import dotenv from "dotenv";
import path from "path";
import express from "express";
import fs from "fs";
import { createServer, Server } from "http";
import winston from "winston";
import { VoiceWebSocketServer } from "./websocket-server";
import { MCPClient, createDesktopCommanderConfig } from "../aggregator/mcp-client";
import { VoiceProcessor } from "../voice/audio-processor";
import {
  VoiceConfig,
  VoiceCommandResult,
  ValidationError,
  PerformanceMetrics
} from "../utils/types";

// Constants
const DEFAULT_HTTP_PORT = 8720;
const DEFAULT_WEBSOCKET_PORT = 8721;
const LOG_FILE_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const LOG_MAX_FILES = 5;
const PERFORMANCE_MONITOR_TIMEOUT = 10000; // 10 seconds
const MCP_CONNECTION_TIMEOUT = 5000; // 5 seconds

// Load environment variables
dotenv.config();

// Performance monitoring decorator
function serverPerformanceMonitor(_target: unknown, propertyName: string, descriptor: PropertyDescriptor) {
  const method = descriptor.value;

  descriptor.value = async function (...args: unknown[]) {
    const start = performance.now();
    const logger = winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [new winston.transports.Console()]
    });

    try {
      const result = await method.apply(this, args);
      const duration = performance.now() - start;

      logger.info(`Server ${propertyName} completed`, {
        duration: Math.round(duration),
        operation: propertyName
      });

      return result;
    } catch (error) {
      const duration = performance.now() - start;
      logger.error(`Server ${propertyName} failed after ${Math.round(duration)}ms`, {
        error: (error as Error).message,
        operation: propertyName
      });
      throw error;
    }
  };
}

export class VoiceMCPGateway {
  private logger!: winston.Logger;
  private app!: express.Application;
  private httpServer!: Server;
  private webSocketServer!: VoiceWebSocketServer;
  private mcpClient!: MCPClient;
  private voiceProcessor!: VoiceProcessor;
  private isRunning = false;
  private performanceMetrics: PerformanceMetrics[] = [];

  constructor() {
    this.setupLogger();
    this.validateEnvironment();
    this.setupHTTPServer();
    // Components will be initialized asynchronously in start() method
  }

  private setupLogger(): void {
    // Create logs directory if it doesn't exist
    const logsDir = path.join(process.cwd(), 'logs');

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
        // TEMP: Disable file transports to test event loop blocking
        // new winston.transports.File({
        //   filename: path.join(logsDir, 'voice-gateway.log'),
        //   maxsize: 10 * 1024 * 1024, // 10MB
        //   maxFiles: 5
        // }),
        // new winston.transports.File({
        //   filename: path.join(logsDir, 'error.log'),
        //   level: 'error',
        //   maxsize: 10 * 1024 * 1024, // 10MB
        //   maxFiles: 5
        // })
      ]
    });
  }

  private validateEnvironment(): void {
    const requiredEnvVars = [
      'OPENAI_API_KEY'
    ];

    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
      throw new ValidationError(
        `Missing required environment variables: ${missingVars.join(', ')}`,
        'environment',
        missingVars
      );
    }

    // Log environment configuration with proper logger
    this.logger.debug('Environment configuration loaded', {
      nodeEnv: process.env.NODE_ENV,
      portFromEnv: process.env.PORT,
      websocketPortFromEnv: process.env.WEBSOCKET_PORT,
      actualPort: process.env.PORT || DEFAULT_HTTP_PORT,
      actualWebSocketPort: process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT
    });

    this.logger.info('Environment validation passed', {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: process.env.PORT || DEFAULT_HTTP_PORT,
      websocketPort: process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT
    });
  }

  private setupHTTPServer(): void {
    console.log('[SIMPLE-EXPRESS] Creating simplified Express server...');

    // Create Express app using direct approach like working test server
    this.app = express();
    console.log('[SIMPLE-EXPRESS] Express app created');

    // Add basic middleware first
    this.app.use(express.json());

    // Request logging middleware with explicit console logging
    this.app.use((req, res, next) => {
      console.log(`[SIMPLE-EXPRESS] ${req.method} ${req.path} - ${new Date().toISOString()}`);
      next();
    });

    // Simple health endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'working',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Simple ping endpoint
    this.app.get('/ping', (req, res) => {
      res.json({ message: 'pong', timestamp: new Date().toISOString() });
    });

    // Root route
    this.app.get('/', (req, res) => {
      res.json({ message: 'Voice MCP Gateway', timestamp: new Date().toISOString() });
    });

    // Dashboard route - Full voice testing interface with dynamic ports
    this.app.get('/dashboard', (req, res) => {
      const dashboardPath = path.join(process.cwd(), 'src', 'dashboard', 'index.html');

      try {
        let dashboardContent = fs.readFileSync(dashboardPath, 'utf8');

        // Replace hardcoded WebSocket port with actual environment port
        const actualWebSocketPort = process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT;
        dashboardContent = dashboardContent.replace(
          /localhost:8711/g,
          `localhost:${actualWebSocketPort}`
        );

        // Replace any other hardcoded ports with actual HTTP port
        const actualHttpPort = process.env.PORT || DEFAULT_HTTP_PORT;
        dashboardContent = dashboardContent.replace(
          /localhost:8720/g,
          `localhost:${actualHttpPort}`
        );

        res.setHeader('Content-Type', 'text/html');
        res.send(dashboardContent);

        console.log(`[DASHBOARD] Served with WebSocket: ws://localhost:${actualWebSocketPort}`);

      } catch (error) {
        console.error('[DASHBOARD] Error serving dashboard:', (error as Error).message);
        res.status(500).json({
          error: 'Failed to load dashboard',
          message: (error as Error).message,
          webSocketPort: process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT,
          httpPort: process.env.PORT || DEFAULT_HTTP_PORT
        });
      }
    });

    // Test interface route - CRITICAL: This was missing and causing infinite loading
    this.app.get('/test', (req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Voice MCP Gateway - Test Interface</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .status { color: green; font-weight: bold; }
            .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
          </style>
        </head>
        <body>
          <h1>🎤 Voice MCP Gateway - Test Interface</h1>
          <div class="status">✅ HTTP Server is working!</div>
          <div class="status">🔗 WebSocket: ws://localhost:${process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT}</div>

          <h2>Available Endpoints:</h2>
          <div class="endpoint">
            <strong><a href="/dashboard">GET /dashboard</a></strong> - 🎤 Full Voice Interface (USE THIS FOR TESTING!)
          </div>
          <div class="endpoint">
            <strong>GET /health</strong> - Health check endpoint
          </div>
          <div class="endpoint">
            <strong>GET /ping</strong> - Simple ping endpoint
          </div>
          <div class="endpoint">
            <strong>GET /test</strong> - This test interface
          </div>

          <h2>Voice Commands:</h2>
          <ul>
            <li>"Read file package.json"</li>
            <li>"List files in current directory"</li>
            <li>"Run command npm test"</li>
            <li>"Show running processes"</li>
          </ul>

          <h2>Quick Tests:</h2>
          <button onclick="testHealth()">Test Health Endpoint</button>
          <button onclick="testPing()">Test Ping Endpoint</button>
          <div id="testResults" style="margin-top: 20px;"></div>

          <script>
            async function testHealth() {
              try {
                const response = await fetch('/health');
                const data = await response.json();
                document.getElementById('testResults').innerHTML =
                  '<div style="color: green;">Health Check: ' + JSON.stringify(data) + '</div>';
              } catch (error) {
                document.getElementById('testResults').innerHTML =
                  '<div style="color: red;">Health Check Failed: ' + error.message + '</div>';
              }
            }

            async function testPing() {
              try {
                const response = await fetch('/ping');
                const data = await response.json();
                document.getElementById('testResults').innerHTML =
                  '<div style="color: green;">Ping Test: ' + JSON.stringify(data) + '</div>';
              } catch (error) {
                document.getElementById('testResults').innerHTML =
                  '<div style="color: red;">Ping Test Failed: ' + error.message + '</div>';
              }
            }
          </script>
        </body>
        </html>
      `);
    });

    // Create HTTP server with Express app (like working test)
    this.httpServer = createServer(this.app);
  }

  @serverPerformanceMonitor
  private async initializeComponents(): Promise<void> {
    console.log('🔄 [INIT] Starting async component initialization...');

    // Initialize voice processing configuration
    console.log('🔧 [INIT] Creating voice config...');
    const voiceConfig: VoiceConfig = {
      sttEngine: (process.env.VOICE_STT_ENGINE as "whisper" | "assemblyai") || "whisper",
      ttsEngine: (process.env.VOICE_TTS_ENGINE as "openai" | "elevenlabs") || "openai",
      vadThreshold: parseFloat(process.env.VOICE_VAD_THRESHOLD || "0.5"),
      minSpeechDuration: parseInt(process.env.VOICE_MIN_SPEECH_DURATION || "250"),
      maxLatency: parseInt(process.env.VOICE_LATENCY_THRESHOLD || "1000")
    };
    console.log('✅ [INIT] Voice config created');

    // Initialize voice processor first (allow async initialization)
    console.log('🔄 [INIT] Initializing VoiceProcessor...');
    try {
      // FIXED: Test VoiceProcessor with synchronous constructor
      this.voiceProcessor = new VoiceProcessor(voiceConfig);
      // Allow event loop to process other tasks
      await new Promise(resolve => setImmediate(resolve));
    } catch (error) {
      console.error('❌ [INIT] VoiceProcessor failed:', (error as Error).message);
      throw error;
    }

    // Initialize WebSocket server with shared voice processor (allow async initialization)
    console.log('🔄 [INIT] Initializing VoiceWebSocketServer...');
    try {
      this.webSocketServer = new VoiceWebSocketServer(
        parseInt(process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT.toString()),
        this.voiceProcessor
      );
      // Allow event loop to process other tasks
      await new Promise(resolve => setImmediate(resolve));
    } catch (error) {
      console.error('❌ [INIT] VoiceWebSocketServer failed:', (error as Error).message);
      throw error;
    }

    console.log('🔄 [INIT] Initializing MCPClient...');
    try {
      this.mcpClient = new MCPClient(createDesktopCommanderConfig());
      // Allow event loop to process other tasks
      await new Promise(resolve => setImmediate(resolve));
    } catch (error) {
      console.error('❌ [INIT] MCPClient failed:', (error as Error).message);
      throw error;
    }

    console.log('🔄 [INIT] Setting up event handlers...');
    this.setupEventHandlers();
    // Allow event loop to process other tasks
    await new Promise(resolve => setImmediate(resolve));

    this.logger.info('Components initialized successfully');
  }

  private setupEventHandlers(): void {
    // Voice processor events - only if processor exists
    if (this.voiceProcessor) {
      this.voiceProcessor.on('voiceCommandProcessed', (result: VoiceCommandResult) => {
        this.handleVoiceCommandProcessed(result);
      });

      this.voiceProcessor.on('voiceCommandFailed', (result: VoiceCommandResult) => {
        this.handleVoiceCommandFailed(result);
      });

      this.voiceProcessor.on('performanceMetrics', (metrics: PerformanceMetrics) => {
        this.recordPerformanceMetrics(metrics);
      });
    } else {
      this.logger.warn('Skipping VoiceProcessor event handlers (processor not initialized)');
    }

    // MCP client events - only if client exists
    if (this.mcpClient) {
      this.mcpClient.on('connected', () => {
        this.logger.info('MCP client connected to Desktop Commander');
      });

      this.mcpClient.on('disconnected', () => {
        this.logger.warn('MCP client disconnected from Desktop Commander');
      });

      this.mcpClient.on('error', (error: Error) => {
        this.logger.error('MCP client error', { error: error.message });
      });
    } else {
      this.logger.warn('MCPClient not available for event handlers');
    }

    // Process events
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', { error: error.message, stack: error.stack });
      process.exit(1);
    });
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection', { reason, promise });
    });
  }

  @serverPerformanceMonitor
  async start(): Promise<void> {
    try {
      this.logger.info('Starting Voice MCP Gateway...');

      // Start HTTP server first (so it can handle requests immediately)
      const httpPort = parseInt(process.env.PORT || DEFAULT_HTTP_PORT.toString());

      console.log('[SIMPLE-EXPRESS] Starting HTTP server first for immediate request handling...');

      // Add connection debugging for HTTP requests
      this.httpServer.on('connection', (socket: import('net').Socket) => {
        console.log(`[HTTP] New connection from ${socket.remoteAddress}:${socket.remotePort}`);
      });

      this.httpServer.on('error', (err: Error) => {
        console.error('[HTTP] Server error:', err);
      });

      await new Promise<void>((resolve, reject) => {
        this.httpServer.listen(httpPort, '0.0.0.0', () => {
          console.log('[SIMPLE-EXPRESS] HTTP server listening - ready for requests');
          this.logger.info('✅ HTTP server started', { port: httpPort, host: '0.0.0.0' });
          resolve();
        }).on('error', (error: Error) => {
          console.error('[SIMPLE-EXPRESS] Listen error:', error);
          reject(error);
        });
      });

      // Initialize voice processing components
      console.log('[RESTORE] Enabling component initialization');
      await this.initializeComponents();

      // Enable MCP client connection AFTER HTTP server is stable
      if (process.env.DESKTOP_COMMANDER_ENABLED === 'true' && this.mcpClient) {
        try {
          const connectionPromise = this.mcpClient.connect();
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`MCP connection timeout after ${PERFORMANCE_MONITOR_TIMEOUT/1000} seconds`)), PERFORMANCE_MONITOR_TIMEOUT);
          });
          await Promise.race([connectionPromise, timeoutPromise]);
          this.logger.info('✅ MCP client connected');
        } catch (error) {
          this.logger.warn('⚠️  MCP client connection failed - continuing without MCP functionality', {
            error: (error as Error).message
          });
        }
      } else {
        this.logger.info('📋 MCP client disabled or not initialized');
      }

      // Enable WebSocket server AFTER HTTP server is stable
      if (this.webSocketServer) {
        await this.webSocketServer.start();
        this.logger.info('✅ WebSocket server started');
      } else {
        this.logger.info('📋 WebSocket server not initialized');
      }

      // TEMP: Skip integrated voice processing for now
      // this.setupIntegratedVoiceProcessing();

      this.isRunning = true;

      this.logger.info('🎉 Voice MCP Gateway started successfully', {
        httpPort: process.env.PORT || DEFAULT_HTTP_PORT,
        websocketPort: process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT,
        environment: process.env.NODE_ENV || 'development',
        mcpServer: 'Desktop Commander',
        voiceEngine: `${process.env.VOICE_STT_ENGINE || 'whisper'} + ${process.env.VOICE_TTS_ENGINE || 'openai'}`
      });

      this.logStartupInstructions();

    } catch (error) {
      this.logger.error('Failed to start Voice MCP Gateway', {
        error: (error as Error).message,
        stack: (error as Error).stack
      });
      throw error;
    }
  }

  private setupIntegratedVoiceProcessing(): void {
    // Ensure components are initialized before setting up integration
    if (!this.webSocketServer || !this.voiceProcessor || !this.mcpClient) {
      this.logger.warn('Components not fully initialized - skipping integrated voice processing setup');
      return;
    }

    // Override WebSocket server's voice command handler to integrate with our voice processor
    const originalServer = this.webSocketServer as any;

    // Intercept audio chunk processing
    originalServer.processAudioBuffer = async (
      socket: { id: string; emit: (event: string, data: unknown) => void },
      buffers: Buffer[]
    ): Promise<void> => {
      if (buffers.length === 0) return;

      const combinedBuffer = Buffer.concat(buffers);
      const session = originalServer.activeSessions.get(socket.id);

      if (!session?.isAuthenticated) {
        socket.emit('audio_error', {
          message: "Authentication required",
          timestamp: new Date().toISOString()
        });
        return;
      }

      try {
        // Process voice command through our integrated pipeline
        const result = await this.processVoiceCommandIntegrated(combinedBuffer, session.sessionId);

        // Send result back to client
        socket.emit('voice_result', result);

        this.logger.info('Integrated voice command processed', {
          sessionId: session.sessionId,
          command: result.transcript,
          latency: result.latency,
          success: result.success
        });

      } catch (error) {
        this.logger.error('Integrated voice processing failed', {
          sessionId: session.sessionId,
          error: (error as Error).message
        });

        socket.emit('voice_error', {
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  private async processVoiceCommandIntegrated(
    audioBuffer: Buffer,
    sessionId: string
  ): Promise<VoiceCommandResult> {
    const startTime = performance.now();

    try {
      // Step 1: Process voice command
      const voiceResult = await this.voiceProcessor.processVoiceCommand(audioBuffer, sessionId);

      // Step 2: Execute MCP command if voice processing was successful and MCP is available
      if (voiceResult.success && voiceResult.command.mcpTool) {
        const mcpStartTime = performance.now();

        try {
          // Check if MCP client is connected
          if (this.mcpClient.getStatus().status !== 'connected') {
            throw new Error('MCP client not connected');
          }

          const mcpResult = await this.mcpClient.callTool(
            voiceResult.command.mcpTool,
            voiceResult.command.params || {}
          );

          const mcpLatency = performance.now() - mcpStartTime;

          // Update result with actual MCP execution
          voiceResult.result = mcpResult;
          voiceResult.latency = Math.round(performance.now() - startTime);
          voiceResult.success = true;

          this.logger.info('MCP command executed successfully', {
            sessionId,
            tool: voiceResult.command.mcpTool,
            mcpLatency: Math.round(mcpLatency),
            totalLatency: voiceResult.latency
          });

          // Generate success response
          const responseText = this.generateSuccessResponse(voiceResult.command.mcpTool, mcpResult);
          const ttsResult = await this.generateTTSResponse(responseText);
          voiceResult.audioResponse = ttsResult;

        } catch (mcpError) {
          this.logger.error('MCP command execution failed', {
            sessionId,
            tool: voiceResult.command.mcpTool,
            error: (mcpError as Error).message
          });

          // Generate error response but keep original voice processing success
          const errorText = `Failed to execute ${voiceResult.command.mcpTool}: ${(mcpError as Error).message}`;
          const ttsResult = await this.generateTTSResponse(errorText);
          voiceResult.audioResponse = ttsResult;
          voiceResult.success = false;
        }
      }

      return voiceResult;

    } catch (error) {
      this.logger.error('Integrated voice processing failed', {
        sessionId,
        error: (error as Error).message
      });

      // Return error result
      return {
        transcript: "",
        command: {
          text: "",
          confidence: 0,
          timestamp: new Date(),
          sessionId,
          riskLevel: "low"
        },
        mcpCall: {
          method: "error",
          params: { error: (error as Error).message },
          id: Date.now()
        },
        result: {
          content: (error as Error).message,
          isText: true,
          mimeType: "text/plain"
        },
        audioResponse: await this.generateTTSResponse("Sorry, I couldn't process that command."),
        latency: Math.round(performance.now() - startTime),
        success: false
      };
    }
  }

  private generateSuccessResponse(tool: string, result: unknown): string {
    const responses: Record<string, string> = {
      read_file: `File read successfully. Content: ${result && typeof result === 'object' && 'content' in result && typeof (result as any).content === 'string' ? ((result as any).content as string).substring(0, 100) + '...' : 'Binary data'}`,
      list_directory: `Directory listing complete. Found ${result && typeof result === 'object' && 'content' in result && Array.isArray((result as any).content) ? ((result as any).content as any[]).length : 'multiple'} items.`,
      start_process: `Process started successfully.`,
      kill_process: `Process terminated successfully.`,
      list_processes: `Process list retrieved. Found multiple running processes.`,
      get_config: `Configuration retrieved successfully.`
    };

    return responses[tool] || `Command ${tool} executed successfully.`;
  }

  private async generateTTSResponse(text: string): Promise<Buffer> {
    try {
      // Use the voice processor's TTS functionality
      const ttsResult = await (this.voiceProcessor as any).textToSpeech(text);
      return ttsResult.audioBuffer;
    } catch (error) {
      this.logger.error('TTS generation failed', { error: (error as Error).message });
      return Buffer.alloc(0);
    }
  }

  private handleVoiceCommandProcessed(result: VoiceCommandResult): void {
    this.logger.info('Voice command processed successfully', {
      transcript: result.transcript,
      confidence: result.command.confidence,
      latency: result.latency,
      mcpTool: result.command.mcpTool
    });
  }

  private handleVoiceCommandFailed(result: VoiceCommandResult): void {
    this.logger.error('Voice command processing failed', {
      transcript: result.transcript,
      latency: result.latency,
      error: result.result.content
    });
  }

  private recordPerformanceMetrics(metrics: PerformanceMetrics): void {
    this.performanceMetrics.push(metrics);

    // Keep only last 1000 metrics
    if (this.performanceMetrics.length > 1000) {
      this.performanceMetrics = this.performanceMetrics.slice(-1000);
    }

    // Log performance warnings
    if (metrics.duration > 1000) {
      this.logger.warn('Performance threshold exceeded', {
        operation: metrics.operation,
        duration: metrics.duration,
        threshold: 1000
      });
    }
  }

  private logStartupInstructions(): void {
    const httpPort = process.env.PORT || DEFAULT_HTTP_PORT;
    const wsPort = process.env.WEBSOCKET_PORT || DEFAULT_WEBSOCKET_PORT;

    console.log('\n🎤 Voice MCP Gateway is running!\n');
    console.log('📍 Access Points:');
    console.log(`   • 🎤 Voice Interface: http://localhost:${httpPort}/dashboard`);
    console.log(`   • Test Interface:     http://localhost:${httpPort}/test`);
    console.log(`   • Health Check:       http://localhost:${httpPort}/health`);
    console.log(`   • WebSocket:          ws://localhost:${wsPort}`);
    console.log('\n🔧 Setup Instructions:');
    console.log('   1. Copy .env.example to .env');
    console.log('   2. Add your OpenAI API key to .env');
    console.log('   3. Install Desktop Commander: npm run mcp:desktop-commander');
    console.log('   4. Open the web interface and test voice commands');
    console.log('\n💬 Example Voice Commands:');
    console.log('   • "Read file package.json"');
    console.log('   • "List files in current directory"');
    console.log('   • "Run command npm test"');
    console.log('   • "Show running processes"');
    console.log('\n🎯 Performance Targets:');
    console.log('   • Voice Recognition: <300ms');
    console.log('   • MCP Execution: <200ms');
    console.log('   • TTS Generation: <400ms');
    console.log('   • End-to-End: <1000ms');
    console.log('\n📊 Monitoring:');
    console.log(`   • Logs: ./logs/voice-gateway.log`);
    console.log(`   • Errors: ./logs/error.log`);
    console.log('\n🛑 To stop: Ctrl+C\n');
  }

  async gracefulShutdown(signal: string): Promise<void> {
    this.logger.info(`Received ${signal}, shutting down gracefully...`);

    this.isRunning = false;

    try {
      // Stop HTTP server with force close after timeout
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.logger.warn('⚠️  Force closing HTTP server due to timeout');
            this.httpServer.closeAllConnections?.(); // Node 18.2+
            resolve();
          }, MCP_CONNECTION_TIMEOUT);

          this.httpServer.close(() => {
            clearTimeout(timeout);
            this.logger.info('✅ HTTP server stopped');
            resolve();
          });
        });
      }

      // Stop WebSocket server
      if (this.webSocketServer) {
        await this.webSocketServer.stop();
        this.logger.info('✅ WebSocket server stopped');
      }

      // Disconnect MCP client if connected
      try {
        await this.mcpClient.disconnect();
        this.logger.info('✅ MCP client disconnected');
      } catch (error) {
        this.logger.warn('⚠️  MCP client already disconnected');
      }

      this.logger.info('🎉 Voice MCP Gateway shut down successfully');

      // Give a moment for final cleanup
      setTimeout(() => {
        process.exit(0);
      }, 500);

    } catch (error) {
      this.logger.error('Error during shutdown', {
        error: (error as Error).message
      });
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    await this.gracefulShutdown('STOP');
  }

  getStatus(): {
    isRunning: boolean;
    uptime: number;
    performanceMetrics: PerformanceMetrics[];
    mcpStatus: unknown;
    webSocketStatus: unknown;
  } {
    return {
      isRunning: this.isRunning,
      uptime: process.uptime(),
      performanceMetrics: this.performanceMetrics.slice(-10), // Last 10 metrics
      mcpStatus: this.mcpClient ? this.mcpClient.getStatus() : { status: 'not_initialized' },
      webSocketStatus: this.webSocketServer ? this.webSocketServer.getStatus() : { status: 'not_initialized' }
    };
  }
}

// Main execution
async function main(): Promise<void> {
  try {
    console.log('🏁 main() function started');
    console.log('🔨 Creating VoiceMCPGateway instance...');
    const gateway = new VoiceMCPGateway();
    console.log('✅ VoiceMCPGateway instance created');
    console.log('🚀 Starting gateway...');
    await gateway.start();

    // Keep the process running
    process.stdin.resume();

  } catch (error) {
    console.error('Failed to start Voice MCP Gateway:', (error as Error).message);
    process.exit(1);
  }
}

// Start the server if this file is run directly
// ES module detection using import.meta.url
function isMainModule(): boolean {
  try {
    // For ES modules, check if the current file is the main entry point
    const mainArg = process.argv[1];
    if (!mainArg) return true; // Default to main if argv[1] is undefined

    const currentUrl = import.meta.url;
    const mainUrl = `file://${mainArg.replace(/\\/g, '/')}`;
    return currentUrl === mainUrl || mainArg.includes('voice-server');
  } catch {
    // Fallback: assume it's the main module if called via tsx or node
    const mainArg = process.argv[1];
    return mainArg ? mainArg.includes('voice-server') : true;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error('Startup error:', error);
    process.exit(1);
  });
}

export default VoiceMCPGateway;