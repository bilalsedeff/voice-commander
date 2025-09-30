/**
 * Context Preservation Engine for Voice Conversations
 *
 * Maintains conversation context, command history, and session state to enable
 * natural follow-up commands and contextual understanding across voice interactions.
 *
 * Dependencies:
 * - winston: https://github.com/winstonjs/winston
 * - uuid: https://github.com/uuidjs/uuid
 *
 * Input: Voice commands, session data, conversation history
 * Output: Enriched context for intent recognition and command execution
 *
 * Example:
 * const context = new ContextManager();
 * await context.updateContext(command, result);
 * const enrichedCommand = await context.enrichCommand("list that directory");
 * // Resolves "that directory" to previous directory reference
 */

import { EventEmitter } from "events";
import * as winston from "winston";
import { v4 as uuidv4 } from "uuid";
import {
  VoiceCommand,
  VoiceCommandResult,
  VoiceSession,
  MCPToolResult,
  ValidationError,
  VoiceProcessingError
} from "../utils/types";

export interface ConversationContext {
  sessionId: string;
  userId: string;
  startTime: Date;
  lastActivity: Date;
  totalCommands: number;
  
  // Current working context
  currentDirectory: string;
  activeFiles: Set<string>;
  activeProcesses: Map<string, ProcessContext>;
  openSearches: Map<string, SearchContext>;
  
  // Command history and patterns
  commandHistory: HistoricalCommand[];
  entityReferences: Map<string, EntityReference>;
  conversationFlow: ConversationNode[];
  
  // User preferences learned from context
  preferences: {
    frequentDirectories: Map<string, number>;
    preferredTools: Map<string, number>;
    riskTolerance: 'low' | 'medium' | 'high';
    communicationStyle: 'verbose' | 'concise' | 'technical';
  };
}

export interface ProcessContext {
  id: string;
  command: string;
  startTime: Date;
  status: 'running' | 'completed' | 'failed';
  lastOutput: string;
  workingDirectory: string;
}

export interface SearchContext {
  id: string;
  pattern: string;
  directory: string;
  results: Array<{
    file: string;
    matches: number;
    lastAccessed: Date;
  }>;
  startTime: Date;
}

export interface HistoricalCommand {
  id: string;
  command: VoiceCommand;
  result: VoiceCommandResult;
  timestamp: Date;
  executionTime: number;
  success: boolean;
  contextSnapshot: Partial<ConversationContext>;
}

export interface EntityReference {
  type: 'file' | 'directory' | 'process' | 'search' | 'variable';
  value: string;
  aliases: string[];
  lastReferenced: Date;
  referenceCount: number;
  confidence: number;
}

export interface ConversationNode {
  id: string;
  command: VoiceCommand;
  dependencies: string[]; // IDs of commands this depends on
  followUps: string[]; // IDs of commands that followed this
  contextualReferences: string[]; // Entity IDs referenced
  timestamp: Date;
}

export interface ContextEnrichmentResult {
  originalCommand: string;
  enrichedCommand: VoiceCommand;
  resolvedReferences: Map<string, string>;
  contextualHints: string[];
  confidence: number;
}

export class ContextManager extends EventEmitter {
  private logger!: winston.Logger;
  private contexts: Map<string, ConversationContext> = new Map();
  private contextTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private maxContextAge: number = 3600000;
  private maxHistoryLength: number = 100;

  constructor() {
    super();
    this.setupLogger();
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
        new winston.transports.File({ filename: 'logs/context-preservation.log' })
      ]
    });
  }

  private setupCleanupInterval(): void {
    // Clean up expired contexts every 10 minutes
    setInterval(() => {
      this.cleanupExpiredContexts();
    }, 600000);
  }

  async getOrCreateContext(session: VoiceSession): Promise<ConversationContext> {
    const existingContext = this.contexts.get(session.id);
    
    if (existingContext) {
      // Update last activity
      existingContext.lastActivity = new Date();
      this.refreshContextTimeout(session.id);
      return existingContext;
    }

    // Create new context
    const context: ConversationContext = {
      sessionId: session.id,
      userId: session.userId,
      startTime: session.startTime,
      lastActivity: new Date(),
      totalCommands: 0,
      
      currentDirectory: process.cwd(),
      activeFiles: new Set(),
      activeProcesses: new Map(),
      openSearches: new Map(),
      
      commandHistory: [],
      entityReferences: new Map(),
      conversationFlow: [],
      
      preferences: {
        frequentDirectories: new Map(),
        preferredTools: new Map(),
        riskTolerance: 'medium',
        communicationStyle: 'concise'
      }
    };

    this.contexts.set(session.id, context);
    this.refreshContextTimeout(session.id);
    
    this.logger.info('New conversation context created', {
      sessionId: session.id,
      userId: session.userId
    });

    return context;
  }

  async updateContext(
    sessionId: string,
    command: VoiceCommand,
    result: VoiceCommandResult
  ): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) {
      throw new ValidationError(
        "Session context not found",
        "sessionId",
        sessionId
      );
    }

    try {
      // Update basic context info
      context.totalCommands++;
      context.lastActivity = new Date();

      // Create historical record
      const historicalCommand: HistoricalCommand = {
        id: uuidv4(),
        command,
        result,
        timestamp: new Date(),
        executionTime: result.latency,
        success: result.success,
        contextSnapshot: this.createContextSnapshot(context)
      };

      // Add to history (with limit)
      context.commandHistory.unshift(historicalCommand);
      if (context.commandHistory.length > this.maxHistoryLength) {
        context.commandHistory.pop();
      }

      // Update context based on command type and result
      await this.updateContextBasedOnCommand(context, command, result);
      
      // Extract and update entity references
      await this.updateEntityReferences(context, command, result);
      
      // Update conversation flow
      this.updateConversationFlow(context, command, historicalCommand.id);
      
      // Learn user preferences
      this.updateUserPreferences(context, command, result);
      
      this.logger.debug('Context updated', {
        sessionId,
        commandType: command.mcpTool,
        totalCommands: context.totalCommands,
        activeFiles: context.activeFiles.size,
        activeProcesses: context.activeProcesses.size
      });

      // Emit context update event
      this.emit('contextUpdated', {
        sessionId,
        context: this.createContextSnapshot(context),
        lastCommand: command
      });

    } catch (error) {
      this.logger.error('Failed to update context', {
        sessionId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  async enrichCommand(
    sessionId: string,
    rawCommand: string,
    confidence: number
  ): Promise<ContextEnrichmentResult> {
    const context = this.contexts.get(sessionId);
    if (!context) {
      throw new ValidationError(
        "Session context not found",
        "sessionId",
        sessionId
      );
    }

    try {
      const resolvedReferences = new Map<string, string>();
      const contextualHints: string[] = [];
      let enrichedText = rawCommand;
      let enrichmentConfidence = confidence;

      // Resolve pronouns and demonstratives
      enrichedText = await this.resolvePronouns(context, enrichedText, resolvedReferences);
      
      // Resolve "that", "this", "the previous" references
      enrichedText = await this.resolveDemonstratives(context, enrichedText, resolvedReferences);
      
      // Resolve relative paths and file references
      enrichedText = await this.resolveFileReferences(context, enrichedText, resolvedReferences);
      
      // Add contextual hints for ambiguous commands
      contextualHints.push(...this.generateContextualHints(context, enrichedText));
      
      // Apply directory context if command seems file-related
      if (this.isFileRelatedCommand(enrichedText) && !this.hasExplicitPath(enrichedText)) {
        contextualHints.push(`Working directory: ${context.currentDirectory}`);
      }

      // Reduce confidence if many references were resolved
      if (resolvedReferences.size > 0) {
        enrichmentConfidence *= Math.max(0.7, 1 - (resolvedReferences.size * 0.1));
      }

      const enrichedCommand: VoiceCommand = {
        text: enrichedText,
        confidence: enrichmentConfidence,
        timestamp: new Date(),
        sessionId,
        riskLevel: 'low', // Will be determined during intent recognition
        params: this.extractImplicitParameters(context, enrichedText)
      };

      this.logger.debug('Command enriched with context', {
        sessionId,
        originalCommand: rawCommand,
        enrichedCommand: enrichedText,
        resolvedReferences: Object.fromEntries(resolvedReferences),
        contextualHints,
        confidence: enrichmentConfidence
      });

      return {
        originalCommand: rawCommand,
        enrichedCommand,
        resolvedReferences,
        contextualHints,
        confidence: enrichmentConfidence
      };

    } catch (error) {
      this.logger.error('Command enrichment failed', {
        sessionId,
        rawCommand,
        error: (error as Error).message
      });
      throw error;
    }
  }

  private async updateContextBasedOnCommand(
    context: ConversationContext,
    command: VoiceCommand,
    result: VoiceCommandResult
  ): Promise<void> {
    if (!command.mcpTool) return;

    switch (command.mcpTool) {
      case 'list_directory':
        if (command.params?.directory) {
          context.currentDirectory = command.params.directory as string;
        }
        break;
        
      case 'read_file':
      case 'write_file':
      case 'edit_block':
        if (command.params?.filename || command.params?.path) {
          const filename = (command.params.filename || command.params.path) as string;
          context.activeFiles.add(filename);
        }
        break;
        
      case 'start_process':
      case 'execute_command':
        if (result.success && command.params?.command) {
          const processId = uuidv4();
          context.activeProcesses.set(processId, {
            id: processId,
            command: command.params.command as string,
            startTime: new Date(),
            status: 'running',
            lastOutput: '',
            workingDirectory: context.currentDirectory
          });
        }
        break;
        
      case 'kill_process':
      case 'force_terminate':
        if (command.params?.processId) {
          const processId = command.params.processId as string;
          const process = context.activeProcesses.get(processId);
          if (process) {
            process.status = 'completed';
          }
        }
        break;
        
      case 'start_search':
        if (command.params?.pattern) {
          const searchId = uuidv4();
          context.openSearches.set(searchId, {
            id: searchId,
            pattern: command.params.pattern as string,
            directory: (command.params.directory as string) || context.currentDirectory,
            results: [],
            startTime: new Date()
          });
        }
        break;
        
      case 'stop_search':
        if (command.params?.searchId) {
          context.openSearches.delete(command.params.searchId as string);
        }
        break;
    }
  }

  private async updateEntityReferences(
    context: ConversationContext,
    command: VoiceCommand,
    result: VoiceCommandResult
  ): Promise<void> {
    const params = command.params || {};
    
    // Extract file references
    ['filename', 'path', 'source', 'destination'].forEach(param => {
      if (params[param]) {
        this.addEntityReference(context, 'file', params[param] as string);
      }
    });
    
    // Extract directory references
    ['directory', 'dirname'].forEach(param => {
      if (params[param]) {
        this.addEntityReference(context, 'directory', params[param] as string);
      }
    });
    
    // Extract process references
    ['processId', 'pid'].forEach(param => {
      if (params[param]) {
        this.addEntityReference(context, 'process', params[param] as string);
      }
    });
    
    // Extract search pattern references
    if (params.pattern) {
      this.addEntityReference(context, 'search', params.pattern as string);
    }
  }

  private addEntityReference(
    context: ConversationContext,
    type: EntityReference['type'],
    value: string,
    aliases: string[] = []
  ): void {
    const key = `${type}:${value}`;
    const existing = context.entityReferences.get(key);
    
    if (existing) {
      existing.lastReferenced = new Date();
      existing.referenceCount++;
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
    } else {
      context.entityReferences.set(key, {
        type,
        value,
        aliases,
        lastReferenced: new Date(),
        referenceCount: 1,
        confidence: 0.8
      });
    }
  }

  private updateConversationFlow(
    context: ConversationContext,
    command: VoiceCommand,
    commandId: string
  ): void {
    const node: ConversationNode = {
      id: commandId,
      command,
      dependencies: this.findCommandDependencies(context, command),
      followUps: [],
      contextualReferences: this.findContextualReferences(context, command),
      timestamp: new Date()
    };
    
    // Link to previous commands
    if (context.conversationFlow.length > 0) {
      const previousNode = context.conversationFlow[context.conversationFlow.length - 1];
      if (previousNode) {
        previousNode.followUps.push(commandId);
      }
    }
    
    context.conversationFlow.push(node);
    
    // Keep flow history manageable
    if (context.conversationFlow.length > 50) {
      context.conversationFlow.shift();
    }
  }

  private findCommandDependencies(
    context: ConversationContext,
    command: VoiceCommand
  ): string[] {
    const dependencies: string[] = [];
    
    // Look for references to previous commands in recent history
    const recentCommands = context.commandHistory.slice(0, 5);
    
    for (const historical of recentCommands) {
      // Check if current command references results from previous commands
      if (this.commandReferencesHistorical(command, historical)) {
        dependencies.push(historical.id);
      }
    }
    
    return dependencies;
  }

  private commandReferencesHistorical(
    current: VoiceCommand,
    historical: HistoricalCommand
  ): boolean {
    const currentText = current.text.toLowerCase();
    
    // Check for temporal references
    const temporalRefs = ['that', 'the previous', 'last', 'before', 'earlier'];
    if (temporalRefs.some(ref => currentText.includes(ref))) {
      return true;
    }
    
    // Check for shared entity references
    const currentParams = Object.values(current.params || {}).map(v => String(v).toLowerCase());
    const historicalParams = Object.values(historical.command.params || {}).map(v => String(v).toLowerCase());
    
    return currentParams.some(param => historicalParams.includes(param));
  }

  private findContextualReferences(
    context: ConversationContext,
    command: VoiceCommand
  ): string[] {
    const references: string[] = [];
    const commandText = command.text.toLowerCase();
    
    // Find entity references in the command
    for (const [key, entity] of context.entityReferences.entries()) {
      if (commandText.includes(entity.value.toLowerCase()) ||
          entity.aliases.some(alias => commandText.includes(alias.toLowerCase()))) {
        references.push(key);
      }
    }
    
    return references;
  }

  private updateUserPreferences(
    context: ConversationContext,
    command: VoiceCommand,
    result: VoiceCommandResult
  ): void {
    // Track tool usage
    if (command.mcpTool) {
      const currentCount = context.preferences.preferredTools.get(command.mcpTool) || 0;
      context.preferences.preferredTools.set(command.mcpTool, currentCount + 1);
    }
    
    // Track directory usage
    if (command.params?.directory) {
      const dir = command.params.directory as string;
      const currentCount = context.preferences.frequentDirectories.get(dir) || 0;
      context.preferences.frequentDirectories.set(dir, currentCount + 1);
    }
    
    // Infer communication style from command patterns
    if (command.text.length > 50) {
      context.preferences.communicationStyle = 'verbose';
    } else if (command.text.split(' ').length < 4) {
      context.preferences.communicationStyle = 'concise';
    }
    
    // Infer risk tolerance from confirmations
    if (result.success && command.riskLevel === 'high') {
      context.preferences.riskTolerance = 'high';
    }
  }

  private async resolvePronouns(
    context: ConversationContext,
    text: string,
    resolvedReferences: Map<string, string>
  ): Promise<string> {
    let result = text;
    
    // Simple pronoun resolution for "it", "them"
    const pronouns = ['it', 'them', 'those', 'these'];
    
    for (const pronoun of pronouns) {
      if (result.toLowerCase().includes(pronoun)) {
        const lastEntityRef = this.getLastEntityReference(context);
        if (lastEntityRef) {
          result = result.replace(new RegExp(`\\b${pronoun}\\b`, 'gi'), lastEntityRef.value);
          resolvedReferences.set(pronoun, lastEntityRef.value);
        }
      }
    }
    
    return result;
  }

  private async resolveDemonstratives(
    context: ConversationContext,
    text: string,
    resolvedReferences: Map<string, string>
  ): Promise<string> {
    let result = text;
    
    // Resolve "that file", "this directory", etc.
    const patterns = [
      { pattern: /\bthat (file|directory|folder|process)\b/gi, type: ['file', 'directory', 'directory', 'process'] },
      { pattern: /\bthe (previous|last) (file|directory|command)\b/gi, type: ['file', 'directory', 'variable'] }
    ];
    
    for (const patternInfo of patterns) {
      const matches = Array.from(result.matchAll(patternInfo.pattern));
      
      for (const match of matches) {
        const entityType = patternInfo.type[0] as EntityReference['type'];
        const lastEntity = this.getLastEntityReferenceByType(context, entityType);
        
        if (lastEntity) {
          result = result.replace(match[0], lastEntity.value);
          resolvedReferences.set(match[0], lastEntity.value);
        }
      }
    }
    
    return result;
  }

  private async resolveFileReferences(
    context: ConversationContext,
    text: string,
    resolvedReferences: Map<string, string>
  ): Promise<string> {
    let result = text;
    
    // Convert relative paths to absolute based on current directory
    const relativePathPattern = /(?:^|\s)(\.?\/[^\s]+)/g;
    const matches = Array.from(result.matchAll(relativePathPattern));
    
    for (const match of matches) {
      const relativePath = match[1];
      if (relativePath) {
        const absolutePath = this.resolveRelativePath(context.currentDirectory, relativePath);
        result = result.replace(relativePath, absolutePath);
        resolvedReferences.set(relativePath, absolutePath);
      }
    }
    
    return result;
  }

  private generateContextualHints(context: ConversationContext, command: string): string[] {
    const hints: string[] = [];
    
    // Add active process hints
    if (context.activeProcesses.size > 0 && command.toLowerCase().includes('process')) {
      const processes = Array.from(context.activeProcesses.values())
        .map(p => `${p.command} (${p.id})`)
        .slice(0, 3);
      hints.push(`Active processes: ${processes.join(', ')}`);
    }
    
    // Add recent file hints
    if (context.activeFiles.size > 0 && this.isFileRelatedCommand(command)) {
      const files = Array.from(context.activeFiles).slice(0, 3);
      hints.push(`Recent files: ${files.join(', ')}`);
    }
    
    // Add search context hints
    if (context.openSearches.size > 0 && command.toLowerCase().includes('search')) {
      const searches = Array.from(context.openSearches.values())
        .map(s => `"${s.pattern}" in ${s.directory}`)
        .slice(0, 2);
      hints.push(`Active searches: ${searches.join(', ')}`);
    }
    
    return hints;
  }

  private isFileRelatedCommand(command: string): boolean {
    const fileKeywords = ['file', 'read', 'write', 'edit', 'create', 'delete', 'move', 'copy'];
    return fileKeywords.some(keyword => command.toLowerCase().includes(keyword));
  }

  private hasExplicitPath(command: string): boolean {
    return /[\\/\\\\]/.test(command) || /^[a-zA-Z]:/.test(command);
  }

  private extractImplicitParameters(
    context: ConversationContext,
    command: string
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    
    // Add current directory if command seems to need it
    if (this.isFileRelatedCommand(command) && !this.hasExplicitPath(command)) {
      params.implicitDirectory = context.currentDirectory;
    }
    
    return params;
  }

  private getLastEntityReference(context: ConversationContext): EntityReference | null {
    let latest: EntityReference | null = null;
    let latestTime = new Date(0);
    
    for (const entity of context.entityReferences.values()) {
      if (entity.lastReferenced > latestTime) {
        latest = entity;
        latestTime = entity.lastReferenced;
      }
    }
    
    return latest;
  }

  private getLastEntityReferenceByType(
    context: ConversationContext,
    type: EntityReference['type']
  ): EntityReference | null {
    let latest: EntityReference | null = null;
    let latestTime = new Date(0);
    
    for (const entity of context.entityReferences.values()) {
      if (entity.type === type && entity.lastReferenced > latestTime) {
        latest = entity;
        latestTime = entity.lastReferenced;
      }
    }
    
    return latest;
  }

  private resolveRelativePath(currentDir: string, relativePath: string): string {
    // Simple path resolution - in production use path.resolve()
    if (relativePath.startsWith('./')) {
      return `${currentDir}/${relativePath.slice(2)}`;
    }
    if (relativePath.startsWith('../')) {
      const parentDir = currentDir.split('/').slice(0, -1).join('/');
      return `${parentDir}/${relativePath.slice(3)}`;
    }
    return relativePath;
  }

  private createContextSnapshot(context: ConversationContext): Partial<ConversationContext> {
    return {
      sessionId: context.sessionId,
      currentDirectory: context.currentDirectory,
      totalCommands: context.totalCommands,
      activeFiles: new Set(context.activeFiles),
      activeProcesses: new Map(context.activeProcesses),
      preferences: { ...context.preferences }
    };
  }

  private refreshContextTimeout(sessionId: string): void {
    // Clear existing timeout
    const existingTimeout = this.contextTimeouts.get(sessionId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    
    // Set new timeout
    const timeout = setTimeout(() => {
      this.contexts.delete(sessionId);
      this.contextTimeouts.delete(sessionId);
      this.logger.info('Context expired and removed', { sessionId });
    }, this.maxContextAge);
    
    this.contextTimeouts.set(sessionId, timeout);
  }

  private cleanupExpiredContexts(): void {
    const now = Date.now();
    const expired: string[] = [];
    
    for (const [sessionId, context] of this.contexts.entries()) {
      if (now - context.lastActivity.getTime() > this.maxContextAge) {
        expired.push(sessionId);
      }
    }
    
    expired.forEach(sessionId => {
      this.contexts.delete(sessionId);
      const timeout = this.contextTimeouts.get(sessionId);
      if (timeout) {
        clearTimeout(timeout);
        this.contextTimeouts.delete(sessionId);
      }
    });
    
    if (expired.length > 0) {
      this.logger.info('Cleaned up expired contexts', { count: expired.length });
    }
  }

  // Public API methods
  getContext(sessionId: string): ConversationContext | undefined {
    return this.contexts.get(sessionId);
  }

  getAllContexts(): ConversationContext[] {
    return Array.from(this.contexts.values());
  }

  clearContext(sessionId: string): boolean {
    const deleted = this.contexts.delete(sessionId);
    const timeout = this.contextTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.contextTimeouts.delete(sessionId);
    }
    return deleted;
  }

  getCommandHistory(sessionId: string, limit: number = 10): HistoricalCommand[] {
    const context = this.contexts.get(sessionId);
    if (!context) return [];
    
    return context.commandHistory.slice(0, limit);
  }

  getEntityReferences(sessionId: string): EntityReference[] {
    const context = this.contexts.get(sessionId);
    if (!context) return [];
    
    return Array.from(context.entityReferences.values())
      .sort((a, b) => b.lastReferenced.getTime() - a.lastReferenced.getTime());
  }
}

// Validation function kept for testing purposes, but not auto-executed
export async function validateContextManager(): Promise<void> {
    const failures: string[] = [];
    let totalTests = 0;

    const contextManager = new ContextManager();
    const testSession: VoiceSession = {
      id: "test-session",
      userId: "test-user",
      startTime: new Date(),
      lastActivity: new Date(),
      mcpConnections: [],
      isActive: true
    };

    // Test 1: Context creation and retrieval
    totalTests++;
    try {
      const context = await contextManager.getOrCreateContext(testSession);
      if (!context || context.sessionId !== testSession.id) {
        failures.push("Context creation test: Failed to create or retrieve context");
      } else {
        console.log("✓ Context creation and retrieval working");
      }
    } catch (error) {
      failures.push(`Context creation test: ${(error as Error).message}`);
    }

    // Test 2: Command enrichment with pronouns
    totalTests++;
    try {
      // First, update context with a file command
      const fileCommand: VoiceCommand = {
        text: "read file package.json",
        confidence: 0.9,
        timestamp: new Date(),
        sessionId: testSession.id,
        riskLevel: "low",
        mcpTool: "read_file",
        params: { filename: "package.json" }
      };
      
      const fileResult: VoiceCommandResult = {
        transcript: "read file package.json",
        command: fileCommand,
        mcpCall: { method: "read_file", params: { filename: "package.json" }, id: 1 },
        result: { content: "file content", isText: true },
        audioResponse: Buffer.alloc(0),
        latency: 100,
        success: true
      };
      
      await contextManager.updateContext(testSession.id, fileCommand, fileResult);
      
      // Then test pronoun resolution
      const enrichmentResult = await contextManager.enrichCommand(
        testSession.id,
        "delete it",
        0.9
      );
      
      if (!enrichmentResult.enrichedCommand.text.includes("package.json")) {
        failures.push("Pronoun resolution test: 'it' was not resolved to 'package.json'");
      } else {
        console.log("✓ Pronoun resolution working");
      }
    } catch (error) {
      failures.push(`Pronoun resolution test: ${(error as Error).message}`);
    }

    // Test 3: Entity reference tracking
    totalTests++;
    try {
      const entityRefs = contextManager.getEntityReferences(testSession.id);
      if (entityRefs.length === 0 || !entityRefs.some(ref => ref.value === "package.json")) {
        failures.push("Entity reference test: File reference not tracked");
      } else {
        console.log("✓ Entity reference tracking working");
      }
    } catch (error) {
      failures.push(`Entity reference test: ${(error as Error).message}`);
    }

    // Test 4: Command history
    totalTests++;
    try {
      const history = contextManager.getCommandHistory(testSession.id, 5);
      if (history.length === 0 || !history[0]?.command.text.includes("package.json")) {
        failures.push("Command history test: History not properly maintained");
      } else {
        console.log("✓ Command history working");
      }
    } catch (error) {
      failures.push(`Command history test: ${(error as Error).message}`);
    }

    // Report results
    if (failures.length > 0) {
      console.error(`❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
      failures.forEach(f => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log(`✅ VALIDATION PASSED - All ${totalTests} tests successful`);
      console.log("Context preservation system is validated and ready for production use");
      process.exit(0);
    }
  }