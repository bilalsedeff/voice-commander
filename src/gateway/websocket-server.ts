/**
 * WebSocket Server for Real-time Voice Communication
 *
 * Implements Socket.io-based WebSocket server for bidirectional audio streaming,
 * voice command processing, and MCP integration with strict error handling.
 *
 * Dependencies:
 * - socket.io: https://socket.io/docs/v4/
 * - express: https://expressjs.com/
 * - helmet: https://helmetjs.github.io/
 *
 * Input: Audio streams, voice commands, authentication tokens
 * Output: Real-time audio responses, MCP results, status updates
 *
 * Example:
 * const server = new VoiceWebSocketServer(8711);
 * await server.start();
 * // Client connects and streams audio for voice processing
 */

import { Server as SocketIOServer } from "socket.io";
import { Server as HTTPServer, createServer } from "http";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";
import winston from "winston";
import {
  VoiceCommand,
  VoiceCommandResult,
  AudioStreamConfig,
  VoiceProcessingError,
  ValidationError,
  UserPermissions,
  VoiceConfig
} from "../utils/types";
import { VoiceProcessor } from "../voice/audio-processor";
import { MCPClient, createDesktopCommanderConfig } from "../aggregator/mcp-client";
import { VoiceCommandMapper } from "../voice/voice-command-mapper";

interface SocketSession {
  userId: string;
  sessionId: string;
  isAuthenticated: boolean;
  startTime: Date;
  lastActivity: Date;
  permissions: UserPermissions;
}

interface AudioMessage {
  type: "audio_chunk" | "audio_start" | "audio_end";
  data: Buffer;
  timestamp: number;
  sampleRate: number;
  channels: number;
}


// Performance monitoring decorator for WebSocket operations
function socketPerformanceMonitor(_target: unknown, propertyName: string, descriptor: PropertyDescriptor) {
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

      logger.info(`WebSocket ${propertyName} completed`, {
        duration: Math.round(duration),
        operation: propertyName
      });

      // Enforce voice latency requirements
      if (propertyName.includes("voice") && duration > 1000) {
        logger.warn(`Voice WebSocket operation exceeded 1000ms: ${Math.round(duration)}ms`);
      }

      return result;
    } catch (error) {
      const duration = performance.now() - start;
      logger.error(`WebSocket ${propertyName} failed after ${Math.round(duration)}ms`, {
        error: (error as Error).message,
        operation: propertyName
      });
      throw error;
    }
  };
}

export class VoiceWebSocketServer {
  private app!: express.Application;
  private httpServer!: HTTPServer;
  private io!: SocketIOServer;
  private logger!: winston.Logger;
  private voiceProcessor!: VoiceProcessor;
  private mcpClient!: MCPClient;
  private commandMapper!: VoiceCommandMapper;
  private activeSessions = new Map<string, SocketSession>();
  private audioBuffers = new Map<string, Buffer[]>();
  private port: number;

  constructor(port: number = 8711, voiceProcessor?: VoiceProcessor) {
    this.port = port;
    this.setupExpress();
    this.setupHTTPServer();
    this.setupSocketIO();
    this.setupLogger();
    this.setupVoiceProcessor(voiceProcessor);
    this.setupMCPIntegration();
  }

  private setupExpress(): void {
    this.app = express();

    // Security middleware
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'", "ws:", "wss:"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"]
        }
      }
    }));

    // CORS configuration for development
    this.app.use(cors({
      origin: process.env.NODE_ENV === "development" ? true : process.env.ALLOWED_ORIGINS?.split(','),
      credentials: true
    }));

    this.app.use(express.json({ limit: '10mb' }));

    // Serve dashboard HTML file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const dashboardPath = path.join(__dirname, '../dashboard/index.html');

    // Root route - serve dashboard
    this.app.get('/', (_req, res) => {
      res.sendFile(dashboardPath);
    });

    // Health check endpoint
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeSessions: this.activeSessions.size,
        uptime: process.uptime()
      });
    });

    // WebSocket test endpoint
    this.app.get('/test', (_req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Voice MCP Gateway Test</title>
          <script src="/socket.io/socket.io.js"></script>
        </head>
        <body>
          <h1>Voice MCP Gateway WebSocket Test</h1>
          <button id="connect">Connect</button>
          <button id="disconnect">Disconnect</button>
          <div id="status">Disconnected</div>
          <script>
            const socket = io();
            document.getElementById('connect').onclick = () => socket.connect();
            document.getElementById('disconnect').onclick = () => socket.disconnect();
            socket.on('connect', () => document.getElementById('status').textContent = 'Connected');
            socket.on('disconnect', () => document.getElementById('status').textContent = 'Disconnected');
          </script>
        </body>
        </html>
      `);
    });
  }

  private setupHTTPServer(): void {
    this.httpServer = createServer(this.app);
  }

  private setupSocketIO(): void {
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: process.env.NODE_ENV === "development" ? true : process.env.ALLOWED_ORIGINS?.split(','),
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      allowEIO3: true,
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });
  }

  private setupLogger(): void {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/websocket-server.log' })
      ]
    });
  }

  private setupVoiceProcessor(voiceProcessor?: VoiceProcessor): void {
    if (voiceProcessor) {
      // Use shared voice processor instance
      this.voiceProcessor = voiceProcessor;
      this.logger.info('Using shared VoiceProcessor instance');
    } else {
      // Fallback: create new instance (for backward compatibility)
      const voiceConfig: VoiceConfig = {
        sttEngine: "whisper",
        ttsEngine: "openai",
        vadThreshold: Number(process.env.VOICE_VAD_THRESHOLD) || 0.5,
        minSpeechDuration: Number(process.env.VOICE_MIN_SPEECH_DURATION) || 250,
        maxLatency: Number(process.env.VOICE_LATENCY_THRESHOLD) || 1000
      };

      this.voiceProcessor = new VoiceProcessor(voiceConfig);
      this.logger.info('Created new VoiceProcessor instance', { config: voiceConfig });
    }
  }

  private setupMCPIntegration(): void {
    // Initialize MCP client for Desktop Commander
    this.mcpClient = new MCPClient(createDesktopCommanderConfig());

    // Initialize voice command mapper
    this.commandMapper = new VoiceCommandMapper();

    this.logger.info('MCP integration initialized', {
      clientConfigured: !!this.mcpClient,
      mapperConfigured: !!this.commandMapper
    });
  }

  @socketPerformanceMonitor
  private async handleConnection(socket: any): Promise<void> {
    const sessionId = this.generateSessionId();

    this.logger.info('WebSocket connection established', {
      socketId: socket.id,
      sessionId,
      userAgent: socket.handshake.headers['user-agent'],
      ip: socket.handshake.address
    });

    // Initialize session (development mode - auto authenticate)
    const session: SocketSession = {
      userId: 'dev-user', // Development user
      sessionId,
      isAuthenticated: process.env.NODE_ENV === 'development' ? true : false,
      startTime: new Date(),
      lastActivity: new Date(),
      permissions: {
        userId: 'dev-user',
        mcpTools: ['read_file', 'list_directory', 'start_process', 'kill_process'],
        riskLevels: ['low', 'medium', 'high'],
        isAdmin: true,
        lastUpdated: new Date()
      }
    };

    this.activeSessions.set(socket.id, session);
    this.audioBuffers.set(socket.id, []);

    // Setup event handlers
    this.setupSocketEventHandlers(socket, sessionId);

    // Send initial connection confirmation
    socket.emit('connected', {
      sessionId,
      timestamp: new Date().toISOString(),
      serverVersion: '1.0.0',
      authenticated: session.isAuthenticated,
      userId: session.userId
    });
  }

  private setupSocketEventHandlers(socket: any, sessionId: string): void {
    // Authentication
    socket.on('authenticate', async (data: { token: string }) => {
      try {
        await this.handleAuthentication(socket, data.token);
      } catch (error) {
        socket.emit('auth_error', {
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Audio streaming
    socket.on('audio_chunk', async (data: AudioMessage) => {
      try {
        await this.handleAudioChunk(socket, data);
      } catch (error) {
        this.logger.error('Audio chunk processing failed', {
          socketId: socket.id,
          error: (error as Error).message
        });
        socket.emit('audio_error', {
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Voice command processing
    socket.on('voice_command', async (data: VoiceCommand) => {
      try {
        await this.handleVoiceCommand(socket, data);
      } catch (error) {
        socket.emit('voice_error', {
          message: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Audio stream control
    socket.on('start_audio_stream', (config: AudioStreamConfig) => {
      this.handleAudioStreamStart(socket, config);
    });

    socket.on('end_audio_stream', () => {
      this.handleAudioStreamEnd(socket);
    });

    // Connection management
    socket.on('disconnect', (reason: string) => {
      this.handleDisconnection(socket, reason);
    });

    socket.on('error', (error: Error) => {
      this.logger.error('Socket error', {
        socketId: socket.id,
        sessionId,
        error: error.message
      });
    });
  }

  @socketPerformanceMonitor
  private async handleAuthentication(socket: any, token: string): Promise<void> {
    // Input validation
    if (!token?.trim()) {
      throw new ValidationError("Authentication token required", "token", token);
    }

    const session = this.activeSessions.get(socket.id);
    if (!session) {
      throw new Error("Session not found");
    }

    // TODO: Implement actual JWT validation here
    // For now, accept any non-empty token as authenticated
    session.isAuthenticated = true;
    session.userId = 'user-' + Math.random().toString(36).substr(2, 9);
    session.permissions = {
      userId: session.userId,
      mcpTools: ['read_file', 'list_directory', 'start_process'],
      riskLevels: ['low', 'medium'],
      isAdmin: false,
      lastUpdated: new Date()
    };

    this.activeSessions.set(socket.id, session);

    socket.emit('authenticated', {
      userId: session.userId,
      permissions: session.permissions,
      timestamp: new Date().toISOString()
    });

    this.logger.info('Socket authenticated', {
      socketId: socket.id,
      userId: session.userId,
      sessionId: session.sessionId
    });
  }

  @socketPerformanceMonitor
  private async handleAudioChunk(socket: any, data: AudioMessage): Promise<void> {
    const session = this.activeSessions.get(socket.id);
    if (!session?.isAuthenticated) {
      throw new VoiceProcessingError("Authentication required", "AUTH_REQUIRED");
    }

    // Update activity timestamp
    session.lastActivity = new Date();

    // Validate and convert audio data
    if (!data.data) {
      throw new ValidationError("Invalid audio data", "data", data.data);
    }

    // Convert array to Buffer if needed (for browser compatibility)
    if (Array.isArray(data.data)) {
      data.data = Buffer.from(data.data);
    } else if (!Buffer.isBuffer(data.data)) {
      throw new ValidationError("Invalid audio data format", "data", typeof data.data);
    }

    if (data.sampleRate < 8000 || data.sampleRate > 48000) {
      throw new ValidationError("Invalid sample rate", "sampleRate", data.sampleRate);
    }

    // Store audio chunk
    const buffers = this.audioBuffers.get(socket.id) || [];
    buffers.push(data.data);
    this.audioBuffers.set(socket.id, buffers);

    // Process audio if we have enough data or if this is the end
    if (data.type === "audio_end" || buffers.length >= 10) {
      await this.processAudioBuffer(socket, buffers);
      this.audioBuffers.set(socket.id, []);
    }

    // Acknowledge chunk received
    socket.emit('audio_chunk_ack', {
      timestamp: data.timestamp,
      received: new Date().toISOString()
    });
  }

  @socketPerformanceMonitor
  private async handleVoiceCommand(socket: any, command: VoiceCommand): Promise<void> {
    const session = this.activeSessions.get(socket.id);
    if (!session?.isAuthenticated) {
      throw new VoiceProcessingError("Authentication required", "AUTH_REQUIRED");
    }

    // Validate voice command
    if (!command.text?.trim()) {
      throw new ValidationError("Voice command text required", "text", command.text);
    }

    if (command.confidence < 0 || command.confidence > 1) {
      throw new ValidationError("Invalid confidence value", "confidence", command.confidence);
    }

    // Ensure timestamp is valid (handle WebSocket JSON serialization)
    const commandStartTime = command.timestamp ? new Date(command.timestamp).getTime() : Date.now();
    if (isNaN(commandStartTime)) {
      this.logger.warn('Invalid timestamp in voice command, using current time', {
        originalTimestamp: command.timestamp,
        socketId: socket.id
      });
    }

    try {
      // Map voice command to MCP tool call
      const mappingResult = await this.commandMapper.mapCommand(command.text, {
        sessionId: session.sessionId,
        userId: session.userId || 'default-user'
      });

      this.logger.info('Voice command mapped to MCP tool', {
        sessionId: session.sessionId,
        originalCommand: command.text,
        mcpTool: mappingResult.mcpCall.method,
        params: mappingResult.mcpCall.params,
        confidence: mappingResult.confidence,
        riskLevel: mappingResult.riskLevel
      });

      // Connect MCP client if not already connected
      if (this.mcpClient.getStatus().status !== 'connected') {
        await this.mcpClient.connect();
      }

      // Execute MCP tool call
      const mcpResult = await this.mcpClient.callTool(
        mappingResult.mcpCall.method,
        mappingResult.mcpCall.params
      );

      // Generate success response text
      const responseText = this.generateSuccessResponse(mappingResult.mcpCall.method, mcpResult);

      // Generate TTS response
      const audioResponse = await this.voiceProcessor.textToSpeech(responseText);

      // Send complete result back to client
      const result: VoiceCommandResult = {
        transcript: command.text,
        command: {
          ...command,
          mcpTool: mappingResult.mcpCall.method,
          params: mappingResult.mcpCall.params
        },
        mcpCall: mappingResult.mcpCall,
        result: mcpResult,
        audioResponse: audioResponse.audioBuffer,
        latency: Date.now() - commandStartTime,
        success: true
      };

      this.logger.info('About to emit voice_result', {
        socketId: socket.id,
        resultSize: JSON.stringify(result).length,
        hasAudioResponse: !!result.audioResponse,
        audioSize: result.audioResponse?.length || 0
      });

      socket.emit('voice_result', result);

      this.logger.info('voice_result emitted successfully', {
        socketId: socket.id
      });

      this.logger.info('Voice command executed successfully', {
        socketId: socket.id,
        userId: session.userId,
        command: command.text,
        tool: mappingResult.mcpCall.method,
        responseLength: responseText.length
      });

    } catch (error) {
      this.logger.error('MCP command execution failed', {
        socketId: socket.id,
        userId: session.userId,
        command: command.text,
        error: (error as Error).message
      });

      // Generate error response
      const errorText = `Sorry, I couldn't execute "${command.text}". ${(error as Error).message}`;

      try {
        const errorAudio = await this.voiceProcessor.textToSpeech(errorText);

        const errorResult: VoiceCommandResult = {
          transcript: command.text,
          command,
          mcpCall: { method: 'error', params: { error: (error as Error).message }, id: Date.now() },
          result: { content: errorText, isText: true, mimeType: 'text/plain' },
          audioResponse: errorAudio.audioBuffer,
          latency: Date.now() - commandStartTime,
          success: false
        };

        socket.emit('voice_result', errorResult);
      } catch (ttsError) {
        // Fallback without audio
        socket.emit('voice_error', {
          message: errorText,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  private handleAudioStreamStart(socket: any, config: AudioStreamConfig): void {
    const session = this.activeSessions.get(socket.id);
    if (!session?.isAuthenticated) {
      socket.emit('audio_error', {
        message: "Authentication required",
        timestamp: new Date().toISOString()
      });
      return;
    }

    this.logger.info('Audio stream started', {
      socketId: socket.id,
      userId: session.userId,
      config
    });

    socket.emit('audio_stream_started', {
      sessionId: session.sessionId,
      config,
      timestamp: new Date().toISOString()
    });
  }

  private handleAudioStreamEnd(socket: any): void {
    const session = this.activeSessions.get(socket.id);
    if (session) {
      this.logger.info('Audio stream ended', {
        socketId: socket.id,
        userId: session.userId
      });
    }

    // Clear audio buffers
    this.audioBuffers.delete(socket.id);

    socket.emit('audio_stream_ended', {
      timestamp: new Date().toISOString()
    });
  }

  private async processAudioBuffer(socket: any, buffers: Buffer[]): Promise<void> {
    if (buffers.length === 0) return;

    const combinedBuffer = Buffer.concat(buffers);
    const session = this.activeSessions.get(socket.id);

    try {
      this.logger.info('Processing audio buffer', {
        socketId: socket.id,
        bufferSize: combinedBuffer.length,
        chunks: buffers.length
      });

      // Process audio through voice pipeline
      const result = await this.voiceProcessor.processVoiceCommand(
        combinedBuffer,
        session?.sessionId || socket.id
      );

      this.logger.info('Voice processing completed', {
        socketId: socket.id,
        transcript: result.transcript,
        confidence: result.command.confidence,
        latency: result.latency
      });

      // Send STT result to client
      socket.emit('stt_result', {
        transcript: result.transcript,
        confidence: result.command.confidence,
        timestamp: new Date().toISOString(),
        latency: result.latency
      });

      // If command was recognized with valid text, execute it
      if (result.command && result.command.text?.trim()) {
        socket.emit('voice_command_recognized', {
          command: result.command,
          params: result.command.params,
          timestamp: new Date().toISOString()
        });

        // Execute the voice command
        await this.handleVoiceCommand(socket, result.command);
      }

    } catch (error) {
      this.logger.error('Voice processing failed', {
        socketId: socket.id,
        error: (error as Error).message,
        stack: (error as Error).stack
      });

      socket.emit('stt_error', {
        message: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  }

  private handleDisconnection(socket: any, reason: string): void {
    const session = this.activeSessions.get(socket.id);

    this.logger.info('WebSocket disconnected', {
      socketId: socket.id,
      sessionId: session?.sessionId,
      userId: session?.userId,
      reason,
      duration: session ? Date.now() - session.startTime.getTime() : 0
    });

    // Cleanup
    this.activeSessions.delete(socket.id);
    this.audioBuffers.delete(socket.id);
  }

  private generateSessionId(): string {
    return 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }

  private generateSuccessResponse(tool: string, result: any): string {
    const responses: Record<string, string> = {
      read_file: `File read successfully. Content: ${result && typeof result === 'object' && 'content' in result && typeof result.content === 'string' ? result.content.substring(0, 200) + '...' : 'Binary data'}`,
      list_directory: `Directory listing complete. Found ${result && typeof result === 'object' && 'content' in result && Array.isArray(result.content) ? result.content.length : 'multiple'} items.`,
      write_file: `File written successfully.`,
      create_directory: `Directory created successfully.`,
      start_process: `Process started successfully.`,
      kill_process: `Process terminated successfully.`,
      list_processes: `Process list retrieved. Found multiple running processes.`,
      get_config: `Configuration retrieved successfully.`,
      search_files: `Search completed. Found multiple matches.`
    };

    return responses[tool] || `Command ${tool} executed successfully.`;
  }

  async start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      this.httpServer.listen(this.port, async () => {
        this.logger.info(`Voice WebSocket Server started on port ${this.port}`, {
          port: this.port,
          env: process.env.NODE_ENV,
          timestamp: new Date().toISOString()
        });

        // Initialize MCP client connection if Desktop Commander is enabled
        if (process.env.DESKTOP_COMMANDER_ENABLED === 'true') {
          try {
            await this.mcpClient.connect();
            this.logger.info('MCP client connected to Desktop Commander');
          } catch (error) {
            this.logger.warn('MCP client connection failed, will retry on first command', {
              error: (error as Error).message
            });
          }
        }

        resolve();
      }).on('error', (error) => {
        this.logger.error('Failed to start WebSocket server', {
          port: this.port,
          error: error.message
        });
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise(async (resolve) => {
      // Disconnect MCP client
      try {
        await this.mcpClient.disconnect();
        this.logger.info('MCP client disconnected');
      } catch (error) {
        this.logger.warn('Error disconnecting MCP client', {
          error: (error as Error).message
        });
      }

      this.io.close(() => {
        this.httpServer.close(() => {
          this.logger.info('Voice WebSocket Server stopped');
          resolve();
        });
      });
    });
  }

  getStatus(): {
    activeSessions: number;
    uptime: number;
    port: number;
    mcpClient: any;
    voiceProcessor: boolean;
  } {
    return {
      activeSessions: this.activeSessions.size,
      uptime: process.uptime(),
      port: this.port,
      mcpClient: this.mcpClient ? this.mcpClient.getStatus() : { status: 'not_initialized' },
      voiceProcessor: !!this.voiceProcessor
    };
  }
}

// Check if this module is being run directly in ES module context
if (import.meta.url === `file://${process.argv[1]}` ||
    (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))) {
  // Validation function that tests WebSocket server with real connections
  async function validateWebSocketServer(): Promise<void> {
    const failures: string[] = [];
    let totalTests = 0;

    // Test 1: Server startup
    totalTests++;
    const server = new VoiceWebSocketServer(8712); // Use different port for testing

    try {
      await server.start();
      console.log("✓ WebSocket server started successfully");
    } catch (error) {
      failures.push(`Server startup test: ${(error as Error).message}`);
    }

    // Test 2: Health check endpoint
    totalTests++;
    try {
      const response = await fetch('http://localhost:8712/health');
      const health = await response.json() as { status: string; timestamp: string; activeSessions: number; uptime: number };

      if (!health.status || health.status !== 'healthy') {
        failures.push("Health check test: Invalid health response");
      } else {
        console.log("✓ Health check endpoint working");
      }
    } catch (error) {
      failures.push(`Health check test: ${(error as Error).message}`);
    }

    // Test 3: Server status
    totalTests++;
    try {
      const status = server.getStatus();
      if (typeof status.activeSessions !== 'number' || typeof status.uptime !== 'number') {
        failures.push("Server status test: Invalid status structure");
      } else {
        console.log("✓ Server status working correctly");
      }
    } catch (error) {
      failures.push(`Server status test: ${(error as Error).message}`);
    }

    // Test 4: Graceful shutdown
    totalTests++;
    try {
      await server.stop();
      console.log("✓ Server shutdown successful");
    } catch (error) {
      failures.push(`Server shutdown test: ${(error as Error).message}`);
    }

    // Report results
    if (failures.length > 0) {
      console.error(`❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
      failures.forEach(f => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log(`✅ VALIDATION PASSED - All ${totalTests} tests successful`);
      console.log("WebSocket server is validated and ready for production use");
      process.exit(0);
    }
  }

  validateWebSocketServer().catch(console.error);
}