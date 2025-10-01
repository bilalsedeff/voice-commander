/**
 * Risk Assessment System
 *
 * Evaluates command risk level (0-3) based on:
 * - Operation type (read, create, modify, delete)
 * - Data scope (single, multiple, bulk)
 * - Impact level (reversible, permanent)
 *
 * Risk Levels:
 * 0 - SAFE: Read-only operations, no modifications
 * 1 - LOW: Create operations, easily reversible
 * 2 - MEDIUM: Modify/delete operations, requires confirmation
 * 3 - HIGH: Bulk operations, irreversible, requires manual approval
 */

import { RiskLevel, CommandRiskAssessment, VoiceCommand } from '../mcp/types';
import logger from '../utils/logger';

export class RiskAssessor {
  /**
   * Assess risk level for a voice command
   */
  assessRisk(command: VoiceCommand): CommandRiskAssessment {
    const reasons: string[] = [];
    let riskLevel = RiskLevel.SAFE;

    // Check operation type
    const operationRisk = this.assessOperationType(command.action);
    if (operationRisk > riskLevel) {
      riskLevel = operationRisk;
      reasons.push(this.getOperationRiskReason(command.action));
    }

    // Check for bulk operations
    if (this.isBulkOperation(command)) {
      riskLevel = RiskLevel.HIGH;
      reasons.push('Bulk operation detected - affects multiple items');
    }

    // Check for destructive operations
    if (this.isDestructive(command.action)) {
      if (riskLevel < RiskLevel.MEDIUM) {
        riskLevel = RiskLevel.MEDIUM;
      }
      reasons.push('Destructive operation - data may be permanently lost');
    }

    // Check for sensitive data
    if (this.involvesSensitiveData(command)) {
      if (riskLevel < RiskLevel.MEDIUM) {
        riskLevel = RiskLevel.MEDIUM;
      }
      reasons.push('Operation involves sensitive data');
    }

    // Check for external notifications
    if (this.triggersExternalNotifications(command)) {
      if (riskLevel < RiskLevel.LOW) {
        riskLevel = RiskLevel.LOW;
      }
      reasons.push('Will send notifications to external parties');
    }

    const requiresConfirmation = riskLevel >= RiskLevel.MEDIUM;
    const requiresManualApproval = riskLevel >= RiskLevel.HIGH;

    logger.info('Risk assessment completed', {
      command: command.originalText,
      action: command.action,
      riskLevel,
      requiresConfirmation,
      requiresManualApproval,
      reasons
    });

    return {
      level: riskLevel,
      reasons,
      requiresConfirmation,
      requiresManualApproval
    };
  }

  /**
   * Assess risk based on operation type
   */
  private assessOperationType(action: string): RiskLevel {
    const actionLower = action.toLowerCase();

    // Read-only operations (Level 0)
    if (
      actionLower.includes('list') ||
      actionLower.includes('get') ||
      actionLower.includes('read') ||
      actionLower.includes('view') ||
      actionLower.includes('search') ||
      actionLower.includes('find')
    ) {
      return RiskLevel.SAFE;
    }

    // Create operations (Level 1)
    if (
      actionLower.includes('create') ||
      actionLower.includes('add') ||
      actionLower.includes('new') ||
      actionLower.includes('post') ||
      actionLower.includes('send') ||
      actionLower.includes('schedule')
    ) {
      return RiskLevel.LOW;
    }

    // Modify operations (Level 2)
    if (
      actionLower.includes('update') ||
      actionLower.includes('edit') ||
      actionLower.includes('modify') ||
      actionLower.includes('change') ||
      actionLower.includes('move') ||
      actionLower.includes('rename')
    ) {
      return RiskLevel.MEDIUM;
    }

    // Delete operations (Level 2-3)
    if (
      actionLower.includes('delete') ||
      actionLower.includes('remove') ||
      actionLower.includes('cancel') ||
      actionLower.includes('clear')
    ) {
      return RiskLevel.MEDIUM;
    }

    // Default to medium risk for unknown operations
    return RiskLevel.MEDIUM;
  }

  /**
   * Check if operation is bulk (affects multiple items)
   */
  private isBulkOperation(command: VoiceCommand): boolean {
    const text = command.originalText.toLowerCase();
    const params = command.params;

    // Check for bulk keywords
    if (
      text.includes('all') ||
      text.includes('every') ||
      text.includes('bulk') ||
      text.includes('multiple')
    ) {
      return true;
    }

    // Check if parameters indicate multiple items
    if (params.count && parseInt(params.count as string) > 5) {
      return true;
    }

    if (params.ids && Array.isArray(params.ids) && params.ids.length > 5) {
      return true;
    }

    return false;
  }

  /**
   * Check if operation is destructive (irreversible)
   */
  private isDestructive(action: string): boolean {
    const actionLower = action.toLowerCase();

    return (
      actionLower.includes('delete') ||
      actionLower.includes('remove') ||
      actionLower.includes('purge') ||
      actionLower.includes('clear') ||
      actionLower.includes('wipe')
    );
  }

  /**
   * Check if operation involves sensitive data
   */
  private involvesSensitiveData(command: VoiceCommand): boolean {
    const text = command.originalText.toLowerCase();
    const params = command.params;

    // Check for sensitive keywords
    const sensitiveKeywords = [
      'password',
      'secret',
      'token',
      'api key',
      'credential',
      'private',
      'confidential',
      'payment',
      'billing',
      'credit card'
    ];

    for (const keyword of sensitiveKeywords) {
      if (text.includes(keyword)) {
        return true;
      }
    }

    // Check parameter values for sensitive data patterns
    for (const value of Object.values(params)) {
      if (typeof value === 'string') {
        // Check for patterns that look like sensitive data
        if (
          /\b[A-Z0-9]{32,}\b/.test(value) || // API keys
          /\b\d{13,16}\b/.test(value) ||      // Credit card numbers
          /password/i.test(value)              // Password fields
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if operation triggers external notifications
   */
  private triggersExternalNotifications(command: VoiceCommand): boolean {
    const { action, params } = command;
    const actionLower = action.toLowerCase();

    // Calendar events with attendees
    if (
      actionLower.includes('event') &&
      params.attendees &&
      (params.attendees as string).length > 0
    ) {
      return true;
    }

    // Slack/messaging operations
    if (
      actionLower.includes('send') ||
      actionLower.includes('post') ||
      actionLower.includes('message')
    ) {
      return true;
    }

    // Email operations
    if (
      actionLower.includes('email') ||
      actionLower.includes('mail')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Get human-readable reason for operation risk
   */
  private getOperationRiskReason(action: string): string {
    const actionLower = action.toLowerCase();

    if (actionLower.includes('delete')) {
      return 'Delete operation - data will be removed';
    }
    if (actionLower.includes('update')) {
      return 'Update operation - existing data will be modified';
    }
    if (actionLower.includes('create')) {
      return 'Create operation - new data will be added';
    }
    if (actionLower.includes('send')) {
      return 'Send operation - message will be delivered';
    }

    return `${action} operation detected`;
  }

  /**
   * Get user-friendly confirmation message
   */
  getConfirmationMessage(command: VoiceCommand, assessment: CommandRiskAssessment): string {
    const { level, reasons } = assessment;

    let message = `⚠️ This command has ${this.getRiskLevelName(level)} risk level.\n\n`;
    message += `Command: "${command.originalText}"\n`;
    message += `Action: ${command.action} on ${command.service}\n\n`;
    message += `Reasons:\n${reasons.map(r => `• ${r}`).join('\n')}\n\n`;

    if (assessment.requiresManualApproval) {
      message += `🔴 This is a HIGH RISK operation. Type "APPROVED" to proceed.`;
    } else if (assessment.requiresConfirmation) {
      message += `Type "confirm" to proceed or "cancel" to abort.`;
    }

    return message;
  }

  /**
   * Get risk level name
   */
  private getRiskLevelName(level: RiskLevel): string {
    switch (level) {
      case RiskLevel.SAFE:
        return '🟢 SAFE';
      case RiskLevel.LOW:
        return '🟡 LOW';
      case RiskLevel.MEDIUM:
        return '🟠 MEDIUM';
      case RiskLevel.HIGH:
        return '🔴 HIGH';
      default:
        return 'UNKNOWN';
    }
  }
}
