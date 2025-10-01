/**
 * Voice Orchestrator
 *
 * Main orchestration layer for voice commands
 * - Maps voice → MCP tools
 * - Manages risk assessment
 * - Executes single and chained commands
 * - Coordinates with multiple MCP services
 */

import {
  VoiceCommand,
  CommandExecutionResult,
  ChainedCommandResult
} from '../mcp/types';
import { mcpConnectionManagerV2 } from '../services/mcp-connection-manager-v2';
import { CommandMapper } from './command-mapper';
import { RiskAssessor } from './risk-assessor';
import logger from '../utils/logger';

export class VoiceOrchestrator {
  private commandMapper: CommandMapper;
  private riskAssessor: RiskAssessor;
  private pendingConfirmations: Map<string, VoiceCommand>;

  constructor() {
    this.commandMapper = new CommandMapper();
    this.riskAssessor = new RiskAssessor();
    this.pendingConfirmations = new Map();
  }

  /**
   * Main entry point: Process voice command
   */
  async processVoiceCommand(
    userId: string,
    voiceText: string,
    connectedServices: string[]
  ): Promise<CommandExecutionResult | ChainedCommandResult> {
    logger.info('Processing voice command', { userId, voiceText });

    const startTime = Date.now();

    try {
      // Detect if single or chained command
      const commandTexts = this.commandMapper.detectCommandChain(voiceText);

      if (commandTexts.length === 1) {
        // Single command
        return await this.executeSingleCommand(
          userId,
          commandTexts[0],
          connectedServices
        );
      } else {
        // Chained commands
        return await this.executeChainedCommands(
          userId,
          commandTexts,
          connectedServices
        );
      }
    } catch (error) {
      logger.error('Voice command processing failed', {
        userId,
        error: (error as Error).message
      });

      return {
        success: false,
        service: 'unknown',
        action: 'process_command',
        error: (error as Error).message,
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * Execute a single voice command
   */
  private async executeSingleCommand(
    userId: string,
    voiceText: string,
    connectedServices: string[]
  ): Promise<CommandExecutionResult> {
    const startTime = Date.now();

    // Map voice text to structured command
    const command = await this.commandMapper.mapCommand(
      voiceText,
      connectedServices
    );

    logger.info('Command mapped', {
      service: command.service,
      action: command.action,
      riskLevel: command.riskAssessment.level
    });

    // Check risk level
    if (command.riskAssessment.requiresManualApproval) {
      // Store for confirmation
      const confirmationId = this.storeForConfirmation(userId, command);

      return {
        success: false,
        service: command.service,
        action: command.action,
        error: 'HIGH_RISK_CONFIRMATION_REQUIRED',
        data: {
          confirmationId,
          message: this.riskAssessor.getConfirmationMessage(
            command,
            command.riskAssessment
          )
        },
        executionTime: Date.now() - startTime
      };
    }

    if (command.riskAssessment.requiresConfirmation) {
      // Store for confirmation
      const confirmationId = this.storeForConfirmation(userId, command);

      return {
        success: false,
        service: command.service,
        action: command.action,
        error: 'CONFIRMATION_REQUIRED',
        data: {
          confirmationId,
          message: this.riskAssessor.getConfirmationMessage(
            command,
            command.riskAssessment
          )
        },
        executionTime: Date.now() - startTime
      };
    }

    // Resolve special identifiers (e.g., "LATEST" event)
    const resolvedCommand = await this.commandMapper.resolveSpecialIdentifiers(
      userId,
      command
    );

    // Execute command
    return await this.executeCommand(userId, resolvedCommand, startTime);
  }

  /**
   * Execute chained commands sequentially
   */
  private async executeChainedCommands(
    userId: string,
    commandTexts: string[],
    connectedServices: string[]
  ): Promise<ChainedCommandResult> {
    const startTime = Date.now();
    const results: CommandExecutionResult[] = [];

    logger.info('Executing command chain', {
      userId,
      commandCount: commandTexts.length
    });

    for (let i = 0; i < commandTexts.length; i++) {
      const commandText = commandTexts[i];
      logger.info(`Executing chain step ${i + 1}/${commandTexts.length}`, {
        command: commandText
      });

      try {
        const result = await this.executeSingleCommand(
          userId,
          commandText,
          connectedServices
        );

        results.push(result);

        // Stop chain if command failed
        if (!result.success) {
          logger.warn('Chain execution stopped due to failure', {
            step: i + 1,
            error: result.error
          });
          break;
        }
      } catch (error) {
        logger.error('Chain step failed', {
          step: i + 1,
          error: (error as Error).message
        });

        results.push({
          success: false,
          service: 'unknown',
          action: 'chain_step',
          error: (error as Error).message,
          executionTime: 0
        });

        break;
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    logger.info('Chain execution completed', {
      total: commandTexts.length,
      success: successCount,
      failed: failedCount
    });

    return {
      totalCommands: commandTexts.length,
      successCount,
      failedCount,
      results,
      totalExecutionTime: Date.now() - startTime
    };
  }

  /**
   * Execute a mapped command on the appropriate MCP service
   */
  private async executeCommand(
    userId: string,
    command: VoiceCommand,
    startTime: number
  ): Promise<CommandExecutionResult> {
    try {
      // Map service name to provider
      const providerMap: Record<string, string> = {
        'google_calendar': 'google',
        'slack': 'slack',
        'github': 'github',
        'notion': 'notion'
      };

      const provider = providerMap[command.service];
      if (!provider) {
        throw new Error(`Unknown service: ${command.service}`);
      }

      // Check if MCP connection exists
      if (!mcpConnectionManagerV2.isConnected(userId, provider)) {
        throw new Error(
          `MCP not connected for ${provider}. Please ensure OAuth is authorized and MCP connection is established.`
        );
      }

      // Execute tool via MCP Connection Manager V2
      const result = await mcpConnectionManagerV2.callTool(
        userId,
        provider,
        command.action,
        command.params
      );

      logger.info('Command executed successfully', {
        userId,
        provider,
        service: command.service,
        action: command.action
      });

      return {
        success: true,
        service: command.service,
        action: command.action,
        data: result,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      logger.error('Command execution failed', {
        userId,
        service: command.service,
        action: command.action,
        error: (error as Error).message
      });

      return {
        success: false,
        service: command.service,
        action: command.action,
        error: (error as Error).message,
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * Store command for user confirmation
   */
  private storeForConfirmation(userId: string, command: VoiceCommand): string {
    const confirmationId = `${userId}-${Date.now()}`;
    this.pendingConfirmations.set(confirmationId, command);

    // Auto-cleanup after 5 minutes
    setTimeout(() => {
      this.pendingConfirmations.delete(confirmationId);
    }, 5 * 60 * 1000);

    return confirmationId;
  }

  /**
   * Handle user confirmation for risky commands
   */
  async handleConfirmation(
    userId: string,
    confirmationId: string,
    userResponse: string
  ): Promise<CommandExecutionResult> {
    const command = this.pendingConfirmations.get(confirmationId);

    if (!command) {
      return {
        success: false,
        service: 'unknown',
        action: 'confirmation',
        error: 'Confirmation expired or not found',
        executionTime: 0
      };
    }

    const responseLower = userResponse.toLowerCase().trim();

    // Check for manual approval (HIGH risk)
    if (command.riskAssessment.requiresManualApproval) {
      if (responseLower !== 'approved') {
        this.pendingConfirmations.delete(confirmationId);
        return {
          success: false,
          service: command.service,
          action: command.action,
          error: 'Manual approval required: Type "APPROVED" exactly',
          executionTime: 0
        };
      }
    } else if (command.riskAssessment.requiresConfirmation) {
      // Check for standard confirmation (MEDIUM risk)
      if (responseLower !== 'confirm' && responseLower !== 'yes') {
        this.pendingConfirmations.delete(confirmationId);
        return {
          success: false,
          service: command.service,
          action: command.action,
          error: 'Command cancelled by user',
          executionTime: 0
        };
      }
    }

    // Remove from pending
    this.pendingConfirmations.delete(confirmationId);

    // Resolve and execute
    const resolvedCommand = await this.commandMapper.resolveSpecialIdentifiers(
      userId,
      command
    );

    logger.info('Executing confirmed command', {
      confirmationId,
      service: command.service,
      action: command.action
    });

    return await this.executeCommand(userId, resolvedCommand, Date.now());
  }

  /**
   * Get tool discovery info for connected services
   */
  async getServiceCapabilities(
    userId: string,
    connectedServices: string[]
  ): Promise<Record<string, any>> {
    const capabilities: Record<string, any> = {};

    const serviceDescriptions: Record<string, string> = {
      'google': 'Google Calendar integration for scheduling and events',
      'slack': 'Slack integration for messaging and team communication',
      'github': 'GitHub integration for repository and issue management',
      'notion': 'Notion integration for notes and documentation'
    };

    for (const service of connectedServices) {
      const provider = service === 'google_calendar' ? 'google' : service;

      if (mcpConnectionManagerV2.isConnected(userId, provider)) {
        try {
          const instance = mcpConnectionManagerV2.getMCPInstance(userId, provider);

          // Get tools via duck typing - type varies by MCP implementation
          let tools: unknown[] = [];
          if (typeof (instance as unknown as { discoverTools?: () => Promise<unknown[]> }).discoverTools === 'function') {
            tools = await (instance as unknown as { discoverTools: () => Promise<unknown[]> }).discoverTools();
          }

          capabilities[service] = {
            tools,
            description: serviceDescriptions[provider] || `${provider} integration`
          };
        } catch (error) {
          logger.error('Failed to get service capabilities', {
            userId,
            service,
            provider,
            error: (error as Error).message
          });
        }
      }
    }

    return capabilities;
  }
}
