/**
 * Confirmation Workflows for High-Risk Voice Operations
 *
 * Implements secure confirmation patterns for destructive and high-risk commands
 * with voice-based confirmation, timeout handling, and audit logging.
 *
 * Dependencies:
 * - winston: https://github.com/winstonjs/winston
 * - uuid: https://github.com/uuidjs/uuid
 *
 * Input: Voice command, risk level, user session, confirmation audio
 * Output: Confirmed operation or rejection with security audit trail
 *
 * Example:
 * const workflow = new ConfirmationWorkflow();
 * const result = await workflow.requestConfirmation(command, session);
 * // Plays: "This will delete file config.json. Say 'confirm' to proceed."
 */

import { EventEmitter } from "events";
import * as winston from "winston";
import { v4 as uuidv4 } from "uuid";
import {
  VoiceCommand,
  RiskLevel,
  VoiceSession,
  ValidationError,
  DESKTOP_COMMANDER_TOOLS
} from "../utils/types";

export interface ConfirmationRequest {
  id: string;
  command: VoiceCommand;
  riskLevel: RiskLevel;
  sessionId: string;
  userId: string;
  timestamp: Date;
  timeoutMs: number;
  confirmationText: string;
  requiresDoubleConfirmation: boolean;
}

export interface ConfirmationResult {
  confirmed: boolean;
  confirmationId: string;
  userResponse: string;
  confidence: number;
  timestamp: Date;
  timeToConfirm: number;
  securityAudit: {
    ipAddress?: string;
    userAgent?: string;
    riskAssessment: string;
  };
}

export interface ConfirmationConfig {
  lowRiskTimeout: number;
  mediumRiskTimeout: number;
  highRiskTimeout: number;
  requiredConfidenceThreshold: number;
  enableDoubleConfirmation: boolean;
  allowedConfirmationPhrases: string[];
  rejectionPhrases: string[];
}

export class ConfirmationWorkflow extends EventEmitter {
  private logger!: winston.Logger;
  private config!: ConfirmationConfig;
  private pendingConfirmations: Map<string, ConfirmationRequest> = new Map();
  private confirmationHistory: Map<string, ConfirmationResult[]> = new Map();

  constructor(config?: Partial<ConfirmationConfig>) {
    super();
    this.setupLogger();
    this.loadConfiguration(config);
    this.setupCleanupInterval();
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
        new winston.transports.File({ filename: 'logs/confirmation-workflows.log' }),
        new winston.transports.File({ 
          filename: 'logs/security-audit.log',
          level: 'warn' // Security events
        })
      ]
    });
  }

  private loadConfiguration(userConfig?: Partial<ConfirmationConfig>): void {
    this.config = {
      lowRiskTimeout: 10000, // 10 seconds
      mediumRiskTimeout: 15000, // 15 seconds
      highRiskTimeout: 20000, // 20 seconds
      requiredConfidenceThreshold: 0.8,
      enableDoubleConfirmation: true,
      allowedConfirmationPhrases: [
        'confirm', 'yes', 'proceed', 'do it', 'execute', 'continue',
        'confirmed', 'affirmative', 'go ahead', 'i confirm'
      ],
      rejectionPhrases: [
        'cancel', 'no', 'stop', 'abort', 'reject', 'nevermind',
        'never mind', 'negative', 'decline', 'i decline'
      ],
      ...userConfig
    };
  }

  private setupCleanupInterval(): void {
    // Clean up expired confirmations every minute
    setInterval(() => {
      this.cleanupExpiredConfirmations();
    }, 60000);
  }

  async requestConfirmation(
    command: VoiceCommand,
    session: VoiceSession,
    additionalContext?: {
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<ConfirmationResult> {
    try {
      // Validate command requires confirmation
      const tool = DESKTOP_COMMANDER_TOOLS[command.mcpTool || ''];
      if (!tool) {
        throw new ValidationError(
          "Unknown tool for confirmation",
          "mcpTool",
          command.mcpTool
        );
      }

      if (!tool.requiresConfirmation) {
        // Low risk operation, auto-confirm
        return this.createAutoConfirmationResult(command, session);
      }

      // Create confirmation request
      const confirmationId = uuidv4();
      const timeout = this.getTimeoutForRiskLevel(command.riskLevel);
      const confirmationText = this.generateConfirmationText(command, tool.description);
      
      const request: ConfirmationRequest = {
        id: confirmationId,
        command,
        riskLevel: command.riskLevel,
        sessionId: session.id,
        userId: session.userId,
        timestamp: new Date(),
        timeoutMs: timeout,
        confirmationText,
        requiresDoubleConfirmation: command.riskLevel === 'high' && this.config.enableDoubleConfirmation
      };

      this.pendingConfirmations.set(confirmationId, request);

      this.logger.info('Confirmation requested', {
        confirmationId,
        sessionId: session.id,
        userId: session.userId,
        command: command.text,
        riskLevel: command.riskLevel,
        timeout
      });

      // Emit confirmation request event (for voice synthesis)
      this.emit('confirmationRequested', {
        confirmationId,
        text: confirmationText,
        timeout,
        riskLevel: command.riskLevel
      });

      // Wait for confirmation response
      return await this.waitForConfirmation(confirmationId, timeout, additionalContext);

    } catch (error) {
      this.logger.error('Confirmation request failed', {
        sessionId: session.id,
        command: command.text,
        error: (error as Error).message
      });
      throw error;
    }
  }

  async handleConfirmationResponse(
    confirmationId: string,
    userResponse: string,
    confidence: number
  ): Promise<void> {
    const request = this.pendingConfirmations.get(confirmationId);
    if (!request) {
      throw new ValidationError(
        "Invalid confirmation ID",
        "confirmationId",
        confirmationId
      );
    }

    try {
      const normalizedResponse = userResponse.toLowerCase().trim();
      const isConfirmation = this.isConfirmationPhrase(normalizedResponse);
      const isRejection = this.isRejectionPhrase(normalizedResponse);
      
      if (!isConfirmation && !isRejection) {
        // Ambiguous response, request clarification
        this.emit('clarificationNeeded', {
          confirmationId,
          userResponse,
          clarificationText: "I didn't understand. Please say 'confirm' to proceed or 'cancel' to abort."
        });
        return;
      }

      if (confidence < this.config.requiredConfidenceThreshold) {
        // Low confidence, request repeat
        this.emit('confirmationRepeatNeeded', {
          confirmationId,
          confidence,
          repeatText: "I didn't hear that clearly. Please repeat your confirmation."
        });
        return;
      }

      // Handle double confirmation for high-risk operations
      if (request.requiresDoubleConfirmation && isConfirmation) {
        const isAlreadyConfirmed = request.command.params?.doubleConfirmed === true;
        
        if (!isAlreadyConfirmed) {
          // First confirmation received, request second
          request.command.params = { ...request.command.params, doubleConfirmed: false };
          this.emit('doubleConfirmationRequested', {
            confirmationId,
            text: `This is a high-risk operation. Please confirm again: ${request.confirmationText}`
          });
          return;
        }
      }

      // Process final confirmation
      const result = this.createConfirmationResult(
        request,
        isConfirmation,
        userResponse,
        confidence
      );

      this.pendingConfirmations.delete(confirmationId);
      this.recordConfirmationHistory(request.userId, result);
      
      this.emit('confirmationCompleted', result);

    } catch (error) {
      this.logger.error('Confirmation response handling failed', {
        confirmationId,
        userResponse,
        error: (error as Error).message
      });
      throw error;
    }
  }

  private async waitForConfirmation(
    confirmationId: string,
    timeoutMs: number,
    additionalContext?: {
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<ConfirmationResult> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const request = this.pendingConfirmations.get(confirmationId);
        if (request) {
          this.pendingConfirmations.delete(confirmationId);
          
          const timeoutResult = this.createTimeoutResult(request, additionalContext);
          this.recordConfirmationHistory(request.userId, timeoutResult);
          
          this.logger.warn('Confirmation timeout', {
            confirmationId,
            sessionId: request.sessionId,
            userId: request.userId,
            command: request.command.text,
            riskLevel: request.riskLevel,
            timeoutMs
          });
          
          resolve(timeoutResult);
        }
      }, timeoutMs);

      const completionHandler = (result: ConfirmationResult) => {
        if (result.confirmationId === confirmationId) {
          clearTimeout(timeoutHandle);
          this.off('confirmationCompleted', completionHandler);
          resolve(result);
        }
      };

      this.on('confirmationCompleted', completionHandler);
    });
  }

  private getTimeoutForRiskLevel(riskLevel: RiskLevel): number {
    switch (riskLevel) {
      case 'low':
        return this.config.lowRiskTimeout;
      case 'medium':
        return this.config.mediumRiskTimeout;
      case 'high':
        return this.config.highRiskTimeout;
      default:
        return this.config.mediumRiskTimeout;
    }
  }

  private generateConfirmationText(command: VoiceCommand, toolDescription: string): string {
    const riskWarnings = {
      low: '',
      medium: 'This operation will modify your system. ',
      high: '⚠️ WARNING: This is a destructive operation that cannot be undone. '
    };

    const warning = riskWarnings[command.riskLevel] || '';
    const action = this.getActionDescription(command);
    
    return `${warning}${action} Say 'confirm' to proceed or 'cancel' to abort.`;
  }

  private getActionDescription(command: VoiceCommand): string {
    if (!command.mcpTool || !command.params) {
      return `This will execute: ${command.text}.`;
    }

    const actionDescriptions: Record<string, (params: Record<string, unknown>) => string> = {
      delete_file: (params) => `This will permanently delete file '${params.filename || params.path}'.`,
      kill_process: (params) => `This will terminate process ${params.pid || params.processId}.`,
      force_terminate: (params) => `This will forcefully kill process ${params.pid || params.processId}.`,
      write_file: (params) => `This will write content to file '${params.filename || params.path}'.`,
      execute_command: (params) => `This will execute command: '${params.command}'.`,
      set_config_value: (params) => `This will change configuration '${params.key}' to '${params.value}'.`,
      move_file: (params) => `This will move '${params.source}' to '${params.destination}'.`,
      edit_block: (params) => `This will edit file '${params.filename || params.path}'.`,
      create_directory: (params) => `This will create directory '${params.dirname || params.path}'.`
    };

    const descriptionFn = actionDescriptions[command.mcpTool];
    if (descriptionFn) {
      return descriptionFn(command.params);
    }

    return `This will execute ${command.mcpTool} with the provided parameters.`;
  }

  private isConfirmationPhrase(phrase: string): boolean {
    return this.config.allowedConfirmationPhrases.some(allowed => 
      phrase.includes(allowed) || this.phraseMatches(phrase, allowed)
    );
  }

  private isRejectionPhrase(phrase: string): boolean {
    return this.config.rejectionPhrases.some(rejection => 
      phrase.includes(rejection) || this.phraseMatches(phrase, rejection)
    );
  }

  private phraseMatches(userPhrase: string, targetPhrase: string): boolean {
    // Simple fuzzy matching for voice recognition errors
    const userWords = userPhrase.split(' ');
    const targetWords = targetPhrase.split(' ');
    
    return targetWords.every(targetWord => 
      userWords.some(userWord => 
        this.wordSimilarity(userWord, targetWord) > 0.7
      )
    );
  }

  private wordSimilarity(word1: string, word2: string): number {
    const maxLength = Math.max(word1.length, word2.length);
    if (maxLength === 0) return 1;
    
    const distance = this.levenshteinDistance(word1, word2);
    return 1 - (distance / maxLength);
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) matrix[0]![i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j]![0] = j;

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j]![i] = Math.min(
          matrix[j]![i - 1]! + 1,
          matrix[j - 1]![i]! + 1,
          matrix[j - 1]![i - 1]! + indicator
        );
      }
    }

    return matrix[str2.length]![str1.length]!;
  }

  private createAutoConfirmationResult(
    command: VoiceCommand,
    session: VoiceSession
  ): ConfirmationResult {
    return {
      confirmed: true,
      confirmationId: 'auto-' + uuidv4(),
      userResponse: 'auto-confirmed',
      confidence: 1.0,
      timestamp: new Date(),
      timeToConfirm: 0,
      securityAudit: {
        riskAssessment: `Low-risk operation ${command.mcpTool} auto-confirmed`
      }
    };
  }

  private createConfirmationResult(
    request: ConfirmationRequest,
    confirmed: boolean,
    userResponse: string,
    confidence: number,
    additionalContext?: {
      ipAddress?: string;
      userAgent?: string;
    }
  ): ConfirmationResult {
    const now = new Date();
    const timeToConfirm = now.getTime() - request.timestamp.getTime();

    const result: ConfirmationResult = {
      confirmed,
      confirmationId: request.id,
      userResponse,
      confidence,
      timestamp: now,
      timeToConfirm,
      securityAudit: {
        ...(additionalContext?.ipAddress !== undefined && { ipAddress: additionalContext.ipAddress }),
        ...(additionalContext?.userAgent !== undefined && { userAgent: additionalContext.userAgent }),
        riskAssessment: `${request.riskLevel}-risk operation ${confirmed ? 'confirmed' : 'rejected'} by user ${request.userId}`
      }
    };

    // Log security event
    this.logger.warn('Security confirmation event', {
      confirmationId: request.id,
      userId: request.userId,
      sessionId: request.sessionId,
      command: request.command.text,
      riskLevel: request.riskLevel,
      confirmed,
      timeToConfirm,
      confidence,
      ipAddress: additionalContext?.ipAddress
    });

    return result;
  }

  private createTimeoutResult(
    request: ConfirmationRequest,
    additionalContext?: {
      ipAddress?: string;
      userAgent?: string;
    }
  ): ConfirmationResult {
    return {
      confirmed: false,
      confirmationId: request.id,
      userResponse: 'timeout',
      confidence: 0,
      timestamp: new Date(),
      timeToConfirm: request.timeoutMs,
      securityAudit: {
        ...(additionalContext?.ipAddress !== undefined && { ipAddress: additionalContext.ipAddress }),
        ...(additionalContext?.userAgent !== undefined && { userAgent: additionalContext.userAgent }),
        riskAssessment: `${request.riskLevel}-risk operation timed out for user ${request.userId}`
      }
    };
  }

  private recordConfirmationHistory(userId: string, result: ConfirmationResult): void {
    if (!this.confirmationHistory.has(userId)) {
      this.confirmationHistory.set(userId, []);
    }
    
    const userHistory = this.confirmationHistory.get(userId)!;
    userHistory.push(result);
    
    // Keep only last 100 confirmations per user
    if (userHistory.length > 100) {
      userHistory.splice(0, userHistory.length - 100);
    }
  }

  private cleanupExpiredConfirmations(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, request] of this.pendingConfirmations.entries()) {
      if (now - request.timestamp.getTime() > request.timeoutMs + 5000) { // 5s grace period
        expired.push(id);
      }
    }

    expired.forEach(id => {
      this.pendingConfirmations.delete(id);
      this.logger.debug('Cleaned up expired confirmation', { confirmationId: id });
    });

    if (expired.length > 0) {
      this.logger.info('Cleaned up expired confirmations', { count: expired.length });
    }
  }

  // Public API methods
  getConfirmationHistory(userId: string): ConfirmationResult[] {
    return this.confirmationHistory.get(userId) || [];
  }

  getPendingConfirmations(): ConfirmationRequest[] {
    return Array.from(this.pendingConfirmations.values());
  }

  cancelConfirmation(confirmationId: string): boolean {
    const deleted = this.pendingConfirmations.delete(confirmationId);
    if (deleted) {
      this.logger.info('Confirmation cancelled', { confirmationId });
    }
    return deleted;
  }

  updateConfiguration(newConfig: Partial<ConfirmationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Confirmation configuration updated', { newConfig });
  }

  // Risk assessment method for high-risk commands
  assessRisk(command: VoiceCommand): { riskScore: number; requiresConfirmation: boolean; reason: string } {
    let riskScore = 0;
    const reasons: string[] = [];

    // Check for destructive operations
    const destructiveTools = ['delete_file', 'kill_process', 'force_terminate', 'format_drive'];
    if (command.mcpTool && destructiveTools.includes(command.mcpTool)) {
      riskScore += 50;
      reasons.push('Destructive operation');
    }

    // Check for system modifications
    const systemTools = ['set_config_value', 'write_file', 'edit_block', 'execute_command'];
    if (command.mcpTool && systemTools.includes(command.mcpTool)) {
      riskScore += 30;
      reasons.push('System modification');
    }

    // Check for sensitive paths
    const params = command.params || {};
    const sensitivePathPatterns = ['/etc/', '/sys/', 'System32', 'Windows\\System'];
    const pathParams = ['path', 'filename', 'source', 'destination', 'directory'];

    for (const param of pathParams) {
      const value = params[param];
      if (typeof value === 'string') {
        for (const pattern of sensitivePathPatterns) {
          if (value.includes(pattern)) {
            riskScore += 40;
            reasons.push('Sensitive path accessed');
            break;
          }
        }
      }
    }

    // Check for admin/sudo commands
    if (command.text.toLowerCase().includes('sudo') || command.text.toLowerCase().includes('admin')) {
      riskScore += 30;
      reasons.push('Administrative privileges required');
    }

    // Determine if confirmation is required
    const requiresConfirmation = riskScore >= 30;
    const reason = reasons.length > 0 ? reasons.join(', ') : 'Low risk operation';

    this.logger.debug('Risk assessment completed', {
      command: command.text,
      tool: command.mcpTool,
      riskScore,
      requiresConfirmation,
      reason
    });

    return { riskScore, requiresConfirmation, reason };
  }
}

// Validation function for confirmation workflows
export async function validateConfirmationWorkflow(): Promise<void> {
    const failures: string[] = [];
    let totalTests = 0;

    const workflow = new ConfirmationWorkflow();
    const testSession: VoiceSession = {
      id: "test-session",
      userId: "test-user",
      startTime: new Date(),
      lastActivity: new Date(),
      mcpConnections: [],
      isActive: true
    };

    // Test 1: Auto-confirmation for low-risk operations
    totalTests++;
    try {
      const lowRiskCommand: VoiceCommand = {
        text: "read file package.json",
        confidence: 0.95,
        timestamp: new Date(),
        sessionId: "test-session",
        riskLevel: "low",
        mcpTool: "read_file",
        params: { filename: "package.json" }
      };

      const result = await workflow.requestConfirmation(lowRiskCommand, testSession);
      if (!result.confirmed || result.confirmationId.indexOf('auto-') !== 0) {
        failures.push("Auto-confirmation test: Low-risk operation should auto-confirm");
      } else {
        console.log("✓ Auto-confirmation for low-risk operations working");
      }
    } catch (error) {
      failures.push(`Auto-confirmation test: ${(error as Error).message}`);
    }

    // Test 2: Confirmation text generation
    totalTests++;
    try {
      const highRiskCommand: VoiceCommand = {
        text: "delete file important.txt",
        confidence: 0.95,
        timestamp: new Date(),
        sessionId: "test-session",
        riskLevel: "high",
        mcpTool: "delete_file",
        params: { filename: "important.txt" }
      };

      // Test confirmation text generation without waiting
      let confirmationText = '';
      workflow.on('confirmationRequested', (event) => {
        confirmationText = event.text;
      });

      // Start confirmation but cancel immediately to test text generation
      const confirmationPromise = workflow.requestConfirmation(highRiskCommand, testSession);
      
      // Wait a bit for the event to fire
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (!confirmationText.includes('delete') || !confirmationText.includes('important.txt')) {
        failures.push("Confirmation text test: Generated text doesn't contain expected content");
      } else {
        console.log("✓ Confirmation text generation working");
      }
      
      // Cancel the pending confirmation
      workflow.cancelConfirmation(confirmationText.split(' ')[0] || 'unknown');
      
    } catch (error) {
      failures.push(`Confirmation text test: ${(error as Error).message}`);
    }

    // Test 3: Phrase recognition
    totalTests++;
    try {
      const testPhrases = {
        confirmations: ['confirm', 'yes', 'proceed', 'do it'],
        rejections: ['cancel', 'no', 'stop', 'abort']
      };

      // Access private methods through proper interface for testing
      const workflowAny = workflow as unknown as {
        isConfirmationPhrase: (phrase: string) => boolean;
        isRejectionPhrase: (phrase: string) => boolean;
      };
      
      let allConfirmationsRecognized = true;
      for (const phrase of testPhrases.confirmations) {
        if (!workflowAny.isConfirmationPhrase(phrase)) {
          allConfirmationsRecognized = false;
          break;
        }
      }

      let allRejectionsRecognized = true;
      for (const phrase of testPhrases.rejections) {
        if (!workflowAny.isRejectionPhrase(phrase)) {
          allRejectionsRecognized = false;
          break;
        }
      }

      if (!allConfirmationsRecognized || !allRejectionsRecognized) {
        failures.push("Phrase recognition test: Not all phrases recognized correctly");
      } else {
        console.log("✓ Phrase recognition working");
      }
    } catch (error) {
      failures.push(`Phrase recognition test: ${(error as Error).message}`);
    }

    // Test 4: Configuration updates
    totalTests++;
    try {
      const workflowWithConfig = workflow as unknown as { config: ConfirmationConfig };
      const originalTimeout = workflowWithConfig.config.highRiskTimeout;
      workflow.updateConfiguration({ highRiskTimeout: 30000 });
      const newTimeout = workflowWithConfig.config.highRiskTimeout;
      
      if (newTimeout !== 30000) {
        failures.push("Configuration update test: Configuration not updated correctly");
      } else {
        console.log("✓ Configuration updates working");
      }
    } catch (error) {
      failures.push(`Configuration update test: ${(error as Error).message}`);
    }

    // Report results
    if (failures.length > 0) {
      console.error(`❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
      failures.forEach(f => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log(`✅ VALIDATION PASSED - All ${totalTests} tests successful`);
      console.log("Confirmation workflows system is validated and ready for production use");
      process.exit(0);
    }
  }

// Validation function kept for testing purposes, but not auto-executed