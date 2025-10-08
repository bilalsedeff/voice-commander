/**
 * MCP Protocol Types
 * Based on Model Context Protocol specification
 */

// JSON Schema property type (supports arrays)
export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: {
    type: string;
    description?: string;
  };
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface MCPToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface MCPServer {
  id: string;
  name: string;
  description: string;
  tools: MCPTool[];
  isConnected: boolean;
}

/**
 * Risk levels for command execution
 * Level 0: Safe (read-only) - Auto execute
 * Level 1: Low risk (create) - Execute with logging
 * Level 2: Medium risk (modify/delete) - Require confirmation
 * Level 3: High risk (bulk/destructive) - Require manual approval
 */
export enum RiskLevel {
  SAFE = 0,
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3
}

export interface CommandRiskAssessment {
  level: RiskLevel;
  reasons: string[];
  requiresConfirmation: boolean;
  requiresManualApproval: boolean;
}

export interface VoiceCommand {
  originalText: string;
  intent: string;
  service: string;
  action: string;
  params: Record<string, unknown>;
  riskAssessment: CommandRiskAssessment;
}

export interface CommandExecutionResult {
  success: boolean;
  service: string;
  action: string;
  data?: unknown;
  error?: string;
  executionTime: number;
}

export interface ChainedCommandResult {
  totalCommands: number;
  successCount: number;
  failedCount: number;
  results: CommandExecutionResult[];
  totalExecutionTime: number;
}
