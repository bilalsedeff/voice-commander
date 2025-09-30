/**
 * Voice Feedback System for Long-Running Operations
 *
 * Provides real-time voice updates for long-running MCP operations with
 * intelligent progress tracking, status announcements, and completion notifications.
 *
 * Dependencies:
 * - winston: https://github.com/winstonjs/winston
 * - uuid: https://github.com/uuidjs/uuid
 *
 * Input: Operation context, progress updates, completion status
 * Output: Real-time voice feedback with configurable verbosity
 *
 * Example:
 * const feedback = new LongOperationFeedback();
 * const operation = await feedback.startOperation("Searching files", session);
 * await feedback.updateProgress(operation.id, { progress: 50, message: "Found 10 matches" });
 * await feedback.completeOperation(operation.id, { success: true, results: "Search completed" });
 */

import { EventEmitter } from "events";
import * as winston from "winston";
import { v4 as uuidv4 } from "uuid";
import {
  VoiceSession,
  ValidationError,
  VoiceProcessingError,
  CircuitBreakerConfig
} from "../utils/types";

// Circuit breaker implementation for long operations
export class CircuitBreaker {
  private failureCount: number = 0;
  private lastFailureTime?: Date;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(private config: CircuitBreakerConfig) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const now = Date.now();
      const timeSinceLastFailure = this.lastFailureTime ? now - this.lastFailureTime.getTime() : 0;

      if (timeSinceLastFailure > this.config.resetTimeout) {
        this.state = 'half-open';
      } else {
        throw new VoiceProcessingError('Circuit breaker is open', 'CIRCUIT_OPEN');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failureCount = 0;
      }
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = new Date();

      if (this.failureCount >= this.config.failureThreshold) {
        this.state = 'open';
      }
      throw error;
    }
  }
}

export interface LongRunningOperation {
  id: string;
  sessionId: string;
  userId: string;
  type: 'search' | 'process' | 'file_operation' | 'analysis' | 'custom';
  description: string;
  startTime: Date;
  estimatedDuration?: number;
  currentPhase: string;
  progress: number; // 0-100
  status: 'starting' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  lastUpdate: Date;
  milestones: OperationMilestone[];
  metadata: Record<string, unknown>;
}

export interface OperationMilestone {
  id: string;
  name: string;
  description: string;
  timestamp: Date;
  progress: number;
  data?: Record<string, unknown>;
}

export interface ProgressUpdate {
  progress: number;
  phase?: string;
  message?: string;
  milestone?: string;
  estimatedTimeRemaining?: number;
  data?: Record<string, unknown>;
}

export interface CompletionResult {
  success: boolean;
  results?: unknown;
  errorMessage?: string;
  finalProgress: number;
  totalDuration: number;
  summary?: string;
}

export interface FeedbackConfiguration {
  verbosityLevel: 'minimal' | 'normal' | 'detailed';
  progressUpdateInterval: number; // milliseconds
  milestoneAnnouncements: boolean;
  completionSummary: boolean;
  errorDetailLevel: 'basic' | 'detailed';
  timeEstimationEnabled: boolean;
  interruptionHandling: 'pause' | 'continue' | 'cancel';
}

export interface VoiceFeedbackEvent {
  operationId: string;
  type: 'start' | 'progress' | 'milestone' | 'completion' | 'error' | 'interruption';
  message: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  requiresResponse?: boolean;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export class LongOperationFeedback extends EventEmitter {
  private logger!: winston.Logger;
  private activeOperations: Map<string, LongRunningOperation> = new Map();
  private feedbackQueues: Map<string, VoiceFeedbackEvent[]> = new Map();
  private configuration: Map<string, FeedbackConfiguration> = new Map();
  private updateIntervals: Map<string, NodeJS.Timeout> = new Map();
  private voiceTemplates: Map<string, string[]> = new Map();
  private circuitBreaker: CircuitBreaker;

  constructor() {
    super();
    this.setupLogger();
    this.initializeVoiceTemplates();
    this.setupCleanupInterval();
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000,
      monitoringPeriod: 60000
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
        new winston.transports.File({ filename: 'logs/long-operation-feedback.log' })
      ]
    });
  }

  private initializeVoiceTemplates(): void {
    this.voiceTemplates = new Map([
      ['operation_start', [
        "Starting {operation}. I'll keep you updated on the progress.",
        "Beginning {operation}. This may take a moment.",
        "Initiating {operation}. I'll let you know when it's done."
      ]],
      
      ['progress_update', [
        "{operation} is {progress}% complete.",
        "Progress update: {progress}% done with {operation}.",
        "{operation} {phase}: {progress}% finished."
      ]],
      
      ['milestone_reached', [
        "Milestone reached: {milestone}.",
        "{milestone} completed.",
        "Good progress: {milestone} is done."
      ]],
      
      ['time_estimate', [
        "Estimated time remaining: {time}.",
        "Should be finished in about {time}.",
        "Approximately {time} left."
      ]],
      
      ['operation_complete', [
        "{operation} completed successfully.",
        "Finished {operation}. {summary}",
        "All done! {operation} took {duration}."
      ]],
      
      ['operation_failed', [
        "{operation} failed: {error}",
        "There was a problem with {operation}: {error}",
        "Sorry, {operation} couldn't be completed. {error}"
      ]],
      
      ['long_running_check', [
        "Still working on {operation}. {progress}% complete.",
        "{operation} is taking longer than expected. {progress}% done.",
        "Continuing with {operation}. Currently at {progress}%."
      ]]
    ]);
  }

  private setupCleanupInterval(): void {
    // Clean up completed operations every 5 minutes
    setInterval(() => {
      this.cleanupCompletedOperations();
    }, 300000);
  }

  async startOperation(
    description: string,
    session: VoiceSession,
    options: {
      type?: LongRunningOperation['type'];
      estimatedDuration?: number;
      metadata?: Record<string, unknown>;
      verbosity?: FeedbackConfiguration['verbosityLevel'];
    } = {}
  ): Promise<LongRunningOperation> {
    // Check session before try block to ensure proper error
    if (!session || !session.id || !session.userId) {
      throw new ValidationError(
        "Session is required",
        "session",
        undefined
      );
    }

    try {

      const operationId = uuidv4();

      const operation: LongRunningOperation = {
        id: operationId,
        sessionId: session.id,
        userId: session.userId,
        type: options.type || 'custom',
        description,
        startTime: new Date(),
        ...(options.estimatedDuration !== undefined && { estimatedDuration: options.estimatedDuration }),
        currentPhase: 'initializing',
        progress: 0,
        status: 'starting',
        lastUpdate: new Date(),
        milestones: [],
        metadata: options.metadata || {}
      };

      // Set up user-specific configuration
      const config: FeedbackConfiguration = {
        verbosityLevel: options.verbosity || 'normal',
        progressUpdateInterval: this.getUpdateInterval(options.verbosity || 'normal'),
        milestoneAnnouncements: true,
        completionSummary: true,
        errorDetailLevel: 'basic',
        timeEstimationEnabled: true,
        interruptionHandling: 'pause'
      };

      this.activeOperations.set(operationId, operation);
      this.feedbackQueues.set(operationId, []);
      this.configuration.set(operationId, config);

      // Announce operation start
      await this.announceOperationStart(operation);
      
      // Set up periodic progress checks
      this.setupProgressMonitoring(operationId);

      this.logger.info('Long-running operation started', {
        operationId,
        sessionId: session.id,
        userId: session.userId,
        type: operation.type,
        description
      });

      return operation;

    } catch (error) {
      this.logger.error('Failed to start long-running operation', {
        description,
        sessionId: session.id,
        error: (error as Error).message
      });
      throw error;
    }
  }

  async updateProgress(
    operationId: string,
    update: ProgressUpdate
  ): Promise<void> {
    const operation = this.activeOperations.get(operationId);
    if (!operation) {
      throw new ValidationError(
        "Operation not found",
        "operationId",
        operationId
      );
    }

    try {
      const previousProgress = operation.progress;
      
      // Update operation state
      operation.progress = Math.max(0, Math.min(100, update.progress));
      operation.lastUpdate = new Date();
      
      if (update.phase) {
        operation.currentPhase = update.phase;
      }
      
      if (update.data) {
        operation.metadata = { ...operation.metadata, ...update.data };
      }
      
      // Add milestone if specified
      if (update.milestone) {
        const milestone: OperationMilestone = {
          id: uuidv4(),
          name: update.milestone,
          description: update.message || update.milestone,
          timestamp: new Date(),
          progress: operation.progress,
          ...(update.data !== undefined && { data: update.data })
        };
        
        operation.milestones.push(milestone);
        await this.announceMilestone(operation, milestone);
      }
      
      // Check if significant progress has been made
      const config = this.configuration.get(operationId)!;
      const progressDelta = operation.progress - previousProgress;
      
      if (this.shouldAnnounceProgress(progressDelta, config, operation)) {
        await this.announceProgress(operation, update);
      }
      
      // Update estimated time remaining
      if (config.timeEstimationEnabled && update.estimatedTimeRemaining) {
        await this.announceTimeEstimate(operation, update.estimatedTimeRemaining);
      }

      this.logger.debug('Operation progress updated', {
        operationId,
        progress: operation.progress,
        phase: operation.currentPhase,
        milestone: update.milestone
      });

    } catch (error) {
      this.logger.error('Failed to update operation progress', {
        operationId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  async completeOperation(
    operationId: string,
    result: CompletionResult
  ): Promise<void> {
    const operation = this.activeOperations.get(operationId);
    if (!operation) {
      throw new ValidationError(
        "Operation not found",
        "operationId",
        operationId
      );
    }

    try {
      // Update operation status
      operation.status = result.success ? 'completed' : 'failed';
      operation.progress = result.finalProgress;
      operation.lastUpdate = new Date();
      
      // Clean up monitoring
      this.stopProgressMonitoring(operationId);
      
      // Announce completion
      if (result.success) {
        await this.announceCompletion(operation, result);
      } else {
        await this.announceFailure(operation, result);
      }
      
      this.logger.info('Long-running operation completed', {
        operationId,
        success: result.success,
        duration: result.totalDuration,
        finalProgress: result.finalProgress
      });
      
      // Keep operation in memory for a short time for potential queries
      setTimeout(() => {
        this.activeOperations.delete(operationId);
        this.feedbackQueues.delete(operationId);
        this.configuration.delete(operationId);
      }, 60000); // 1 minute

    } catch (error) {
      this.logger.error('Failed to complete operation', {
        operationId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  async pauseOperation(operationId: string): Promise<void> {
    const operation = this.activeOperations.get(operationId);
    if (!operation) {
      throw new ValidationError(
        "Operation not found",
        "operationId",
        operationId
      );
    }

    operation.status = 'paused';
    this.stopProgressMonitoring(operationId);
    
    await this.queueVoiceFeedback(operationId, {
      operationId,
      type: 'interruption',
      message: `${operation.description} has been paused.`,
      priority: 'normal',
      timestamp: new Date()
    });

    this.logger.info('Operation paused', { operationId });
  }

  async resumeOperation(operationId: string): Promise<void> {
    const operation = this.activeOperations.get(operationId);
    if (!operation) {
      throw new ValidationError(
        "Operation not found",
        "operationId",
        operationId
      );
    }

    operation.status = 'running';
    this.setupProgressMonitoring(operationId);
    
    await this.queueVoiceFeedback(operationId, {
      operationId,
      type: 'interruption',
      message: `Resuming ${operation.description}.`,
      priority: 'normal',
      timestamp: new Date()
    });

    this.logger.info('Operation resumed', { operationId });
  }

  async cancelOperation(operationId: string): Promise<void> {
    const operation = this.activeOperations.get(operationId);
    if (!operation) {
      throw new ValidationError(
        "Operation not found",
        "operationId",
        operationId
      );
    }

    operation.status = 'cancelled';
    this.stopProgressMonitoring(operationId);
    
    await this.queueVoiceFeedback(operationId, {
      operationId,
      type: 'interruption',
      message: `${operation.description} has been cancelled.`,
      priority: 'high',
      timestamp: new Date()
    });

    this.logger.info('Operation cancelled', { operationId });
    
    // Clean up immediately for cancelled operations
    setTimeout(() => {
      this.activeOperations.delete(operationId);
      this.feedbackQueues.delete(operationId);
      this.configuration.delete(operationId);
    }, 5000);
  }

  private getUpdateInterval(verbosity: FeedbackConfiguration['verbosityLevel']): number {
    switch (verbosity) {
      case 'minimal': return 30000; // 30 seconds
      case 'normal': return 15000;  // 15 seconds
      case 'detailed': return 5000; // 5 seconds
      default: return 15000;
    }
  }

  private setupProgressMonitoring(operationId: string): void {
    const config = this.configuration.get(operationId);
    if (!config) return;

    const interval = setInterval(async () => {
      const operation = this.activeOperations.get(operationId);
      if (!operation || operation.status !== 'running') {
        clearInterval(interval);
        return;
      }

      // Check for long-running operations that need attention
      const now = Date.now();
      const timeSinceLastUpdate = now - operation.lastUpdate.getTime();
      
      if (timeSinceLastUpdate > 60000) { // No update for 1 minute
        await this.announceLongRunningCheck(operation);
      }
      
    }, config.progressUpdateInterval);

    this.updateIntervals.set(operationId, interval);
  }

  private stopProgressMonitoring(operationId: string): void {
    const interval = this.updateIntervals.get(operationId);
    if (interval) {
      clearInterval(interval);
      this.updateIntervals.delete(operationId);
    }
  }

  private shouldAnnounceProgress(
    progressDelta: number,
    config: FeedbackConfiguration,
    operation: LongRunningOperation
  ): boolean {
    // Always announce major milestones (multiples of 25%)
    if (operation.progress % 25 === 0 && progressDelta > 0) {
      return true;
    }
    
    // Announce based on verbosity level
    const thresholds = {
      minimal: 50,   // Every 50%
      normal: 25,    // Every 25%
      detailed: 10   // Every 10%
    };
    
    const threshold = thresholds[config.verbosityLevel];
    return progressDelta >= threshold;
  }

  private async announceOperationStart(operation: LongRunningOperation): Promise<void> {
    const templates = this.voiceTemplates.get('operation_start')!;
    const template = this.selectRandomTemplate(templates);
    const message = this.formatTemplate(template, {
      operation: operation.description
    });

    await this.queueVoiceFeedback(operation.id, {
      operationId: operation.id,
      type: 'start',
      message,
      priority: 'normal',
      timestamp: new Date()
    });
  }

  private async announceProgress(
    operation: LongRunningOperation,
    update: ProgressUpdate
  ): Promise<void> {
    const templates = this.voiceTemplates.get('progress_update')!;
    const template = this.selectRandomTemplate(templates);
    const message = this.formatTemplate(template, {
      operation: operation.description,
      progress: operation.progress.toString(),
      phase: operation.currentPhase
    });

    await this.queueVoiceFeedback(operation.id, {
      operationId: operation.id,
      type: 'progress',
      message,
      priority: 'low',
      timestamp: new Date(),
      metadata: { progress: operation.progress, phase: operation.currentPhase }
    });
  }

  private async announceMilestone(
    operation: LongRunningOperation,
    milestone: OperationMilestone
  ): Promise<void> {
    const config = this.configuration.get(operation.id);
    if (!config?.milestoneAnnouncements) return;

    const templates = this.voiceTemplates.get('milestone_reached')!;
    const template = this.selectRandomTemplate(templates);
    const message = this.formatTemplate(template, {
      milestone: milestone.name,
      operation: operation.description
    });

    await this.queueVoiceFeedback(operation.id, {
      operationId: operation.id,
      type: 'milestone',
      message,
      priority: 'normal',
      timestamp: new Date(),
      metadata: { milestone: milestone.name }
    });
  }

  private async announceTimeEstimate(
    operation: LongRunningOperation,
    timeRemaining: number
  ): Promise<void> {
    const templates = this.voiceTemplates.get('time_estimate')!;
    const template = this.selectRandomTemplate(templates);
    const formattedTime = this.formatDuration(timeRemaining);
    const message = this.formatTemplate(template, {
      time: formattedTime,
      operation: operation.description
    });

    await this.queueVoiceFeedback(operation.id, {
      operationId: operation.id,
      type: 'progress',
      message,
      priority: 'low',
      timestamp: new Date(),
      metadata: { timeRemaining }
    });
  }

  private async announceCompletion(
    operation: LongRunningOperation,
    result: CompletionResult
  ): Promise<void> {
    const templates = this.voiceTemplates.get('operation_complete')!;
    const template = this.selectRandomTemplate(templates);
    const duration = this.formatDuration(result.totalDuration);
    const message = this.formatTemplate(template, {
      operation: operation.description,
      summary: result.summary || '',
      duration
    });

    await this.queueVoiceFeedback(operation.id, {
      operationId: operation.id,
      type: 'completion',
      message,
      priority: 'high',
      timestamp: new Date(),
      metadata: { success: true, duration: result.totalDuration }
    });
  }

  private async announceFailure(
    operation: LongRunningOperation,
    result: CompletionResult
  ): Promise<void> {
    const templates = this.voiceTemplates.get('operation_failed')!;
    const template = this.selectRandomTemplate(templates);
    const message = this.formatTemplate(template, {
      operation: operation.description,
      error: result.errorMessage || 'Unknown error'
    });

    await this.queueVoiceFeedback(operation.id, {
      operationId: operation.id,
      type: 'error',
      message,
      priority: 'urgent',
      timestamp: new Date(),
      metadata: { success: false, error: result.errorMessage }
    });
  }

  private async announceLongRunningCheck(operation: LongRunningOperation): Promise<void> {
    const templates = this.voiceTemplates.get('long_running_check')!;
    const template = this.selectRandomTemplate(templates);
    const message = this.formatTemplate(template, {
      operation: operation.description,
      progress: operation.progress.toString()
    });

    await this.queueVoiceFeedback(operation.id, {
      operationId: operation.id,
      type: 'progress',
      message,
      priority: 'normal',
      timestamp: new Date(),
      metadata: { longRunningCheck: true }
    });
  }

  private async queueVoiceFeedback(
    operationId: string,
    feedback: VoiceFeedbackEvent
  ): Promise<void> {
    const queue = this.feedbackQueues.get(operationId);
    if (queue) {
      queue.push(feedback);
    }

    // Emit event for voice synthesis
    this.emit('voiceFeedback', feedback);
    
    this.logger.debug('Voice feedback queued', {
      operationId,
      type: feedback.type,
      priority: feedback.priority,
      message: feedback.message.substring(0, 50) + '...'
    });
  }

  private selectRandomTemplate(templates: string[]): string {
    return templates[Math.floor(Math.random() * templates.length)] || '';
  }

  private formatTemplate(template: string, variables: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }

  private formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} and ${minutes % 60} minute${minutes % 60 !== 1 ? 's' : ''}`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else {
      return `${seconds} second${seconds !== 1 ? 's' : ''}`;
    }
  }

  private cleanupCompletedOperations(): void {
    const now = Date.now();
    const maxAge = 300000; // 5 minutes
    const toDelete: string[] = [];
    
    for (const [operationId, operation] of this.activeOperations.entries()) {
      if (['completed', 'failed', 'cancelled'].includes(operation.status)) {
        if (now - operation.lastUpdate.getTime() > maxAge) {
          toDelete.push(operationId);
        }
      }
    }
    
    toDelete.forEach(operationId => {
      this.activeOperations.delete(operationId);
      this.feedbackQueues.delete(operationId);
      this.configuration.delete(operationId);
      this.stopProgressMonitoring(operationId);
    });
    
    if (toDelete.length > 0) {
      this.logger.info('Cleaned up completed operations', { count: toDelete.length });
    }
  }

  // Public API methods
  getActiveOperations(): LongRunningOperation[] {
    return Array.from(this.activeOperations.values());
  }

  getOperation(operationId: string): LongRunningOperation | undefined {
    return this.activeOperations.get(operationId);
  }

  getOperationsBySession(sessionId: string): LongRunningOperation[] {
    return Array.from(this.activeOperations.values())
      .filter(op => op.sessionId === sessionId);
  }

  getFeedbackQueue(operationId: string): VoiceFeedbackEvent[] {
    return this.feedbackQueues.get(operationId) || [];
  }

  updateConfiguration(
    operationId: string,
    config: Partial<FeedbackConfiguration>
  ): void {
    const currentConfig = this.configuration.get(operationId);
    if (currentConfig) {
      this.configuration.set(operationId, { ...currentConfig, ...config });
    }
  }
}

// Validation function kept for testing purposes, but not auto-executed
export async function validateLongOperationFeedback(): Promise<void> {
    const failures: string[] = [];
    let totalTests = 0;

    const feedback = new LongOperationFeedback();
    const testSession = {
      id: "test-session",
      userId: "test-user",
      startTime: new Date(),
      lastActivity: new Date(),
      mcpConnections: [],
      isActive: true
    };

    // Test 1: Operation creation and start announcement
    totalTests++;
    try {
      let startAnnouncementReceived = false;
      
      feedback.on('voiceFeedback', (event: VoiceFeedbackEvent) => {
        if (event.type === 'start') {
          startAnnouncementReceived = true;
        }
      });
      
      const operation = await feedback.startOperation(
        "Test file search",
        testSession,
        { type: 'search', estimatedDuration: 10000 }
      );
      
      // Wait a bit for the event
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (!operation.id || !startAnnouncementReceived) {
        failures.push("Operation start test: Failed to create operation or announce start");
      } else {
        console.log("✓ Operation creation and start announcement working");
      }
    } catch (error) {
      failures.push(`Operation start test: ${(error as Error).message}`);
    }

    // Test 2: Progress updates
    totalTests++;
    try {
      const operations = feedback.getActiveOperations();
      if (operations.length === 0) {
        failures.push("Progress update test: No active operations found");
      } else {
        const operation = operations[0];
        if (!operation) {
          failures.push("Progress update test: Operation is undefined");
        } else {
          let progressAnnouncementReceived = false;

          feedback.on('voiceFeedback', (event: VoiceFeedbackEvent) => {
            if (event.type === 'progress') {
              progressAnnouncementReceived = true;
            }
          });

          await feedback.updateProgress(operation.id, {
            progress: 50,
            phase: 'processing',
            message: 'Halfway done'
          });

          // Wait for the event
          await new Promise(resolve => setTimeout(resolve, 100));

          if (operation.progress !== 50 || !progressAnnouncementReceived) {
            failures.push("Progress update test: Progress not updated or not announced");
          } else {
            console.log("✓ Progress updates working");
          }
        }
      }
    } catch (error) {
      failures.push(`Progress update test: ${(error as Error).message}`);
    }

    // Test 3: Operation completion
    totalTests++;
    try {
      const operations = feedback.getActiveOperations();
      if (operations.length === 0) {
        failures.push("Completion test: No active operations found");
      } else {
        const operation = operations[0];
        if (!operation) {
          failures.push("Completion test: Operation is undefined");
        } else {
          let completionAnnouncementReceived = false;

          feedback.on('voiceFeedback', (event: VoiceFeedbackEvent) => {
            if (event.type === 'completion') {
              completionAnnouncementReceived = true;
            }
          });

          await feedback.completeOperation(operation.id, {
            success: true,
            finalProgress: 100,
            totalDuration: 5000,
            summary: 'Search completed successfully'
          });

          // Wait for the event
          await new Promise(resolve => setTimeout(resolve, 100));

          if (operation.status !== 'completed' || !completionAnnouncementReceived) {
            failures.push("Completion test: Operation not marked complete or not announced");
          } else {
            console.log("✓ Operation completion working");
          }
        }
      }
    } catch (error) {
      failures.push(`Completion test: ${(error as Error).message}`);
    }

    // Test 4: Template formatting
    totalTests++;
    try {
      const testFeedback = feedback as any;
      const formatted = testFeedback.formatTemplate(
        "Test {operation} with {progress}% progress",
        { operation: "file search", progress: "75" }
      );
      
      if (!formatted.includes('file search') || !formatted.includes('75%')) {
        failures.push("Template formatting test: Variables not properly substituted");
      } else {
        console.log("✓ Template formatting working");
      }
    } catch (error) {
      failures.push(`Template formatting test: ${(error as Error).message}`);
    }

    // Report results
    if (failures.length > 0) {
      console.error(`❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
      failures.forEach(f => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log(`✅ VALIDATION PASSED - All ${totalTests} tests successful`);
      console.log("Long operation feedback system is validated and ready for production use");
      process.exit(0);
    }
  }