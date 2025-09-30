/**
 * Core Type Definitions for Voice MCP Gateway
 *
 * Defines strict TypeScript interfaces for all MCP protocol interactions,
 * voice processing components, and security validation.
 *
 * Dependencies:
 * - @modelcontextprotocol/sdk: https://github.com/modelcontextprotocol/typescript-sdk
 *
 * Input: Various domain objects (voice commands, MCP messages, audio data)
 * Output: Strictly typed interfaces with no 'any' types
 *
 * Example:
 * const command: VoiceCommand = { text: "read file package.json", confidence: 0.95 };
 * const mcpCall: MCPToolCall = { method: "read_file", params: { filename: "package.json" } };
 */

// === MCP Protocol Types ===

export interface MCPToolCall {
  method: string;
  params: Record<string, unknown>;
  id: string | number;
}

export interface MCPToolResult {
  content: unknown;
  isText: boolean;
  mimeType?: string;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport: MCPTransportType;
  timeout?: number;
}

export type MCPTransportType = "stdio" | "sse" | "websocket";

export interface MCPServerStatus {
  id: string;
  status: "connected" | "disconnected" | "error" | "connecting";
  lastHealthCheck: Date;
  errorCount: number;
  latency: number;
}

// === Voice Processing Types ===

export interface VoiceCommand {
  text: string;
  confidence: number;
  timestamp: Date;
  sessionId: string;
  riskLevel: RiskLevel;
  mcpTool?: string;
  params?: Record<string, unknown>;
}

export interface VoiceCommandResult {
  transcript: string;
  command: VoiceCommand;
  mcpCall: MCPToolCall;
  result: MCPToolResult;
  audioResponse: Buffer;
  latency: number;
  success: boolean;
}

export interface VoiceSession {
  id: string;
  userId: string;
  startTime: Date;
  lastActivity: Date;
  mcpConnections: string[];
  isActive: boolean;
}

export interface AudioStreamConfig {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  bufferSize: number;
}

// === Security Types ===

export type RiskLevel = "low" | "medium" | "high";

export interface SecurityError extends Error {
  code: string;
  riskLevel: RiskLevel;
  userId?: string;
  timestamp: Date;
}

export interface UserPermissions {
  userId: string;
  mcpTools: string[];
  riskLevels: RiskLevel[];
  isAdmin: boolean;
  lastUpdated: Date;
}

export interface AuthenticationResult {
  accessToken: string;
  refreshToken: string;
  user: UserInfo;
  expiresIn: number;
}

export interface UserInfo {
  id: string;
  email: string;
  permissions: UserPermissions;
  lastLogin: Date;
}

// === Performance Monitoring Types ===

export interface PerformanceMetrics {
  operation: string;
  duration: number;
  timestamp: Date;
  success: boolean;
  errorMessage?: string;
}

export interface VoiceLatencyMetrics {
  sttLatency: number;
  mcpLatency: number;
  ttsLatency: number;
  totalLatency: number;
  timestamp: Date;
}

export interface ValidationResult {
  isValid: boolean;
  metrics: {
    totalTests: number;
    passed: number;
    failed: number;
    averageLatency: number;
    maxLatency: number;
    errors: string[];
  };
  timestamp: string;
}

// === Configuration Types ===

export interface VoiceConfig {
  sttEngine: "whisper" | "assemblyai";
  ttsEngine: "openai" | "elevenlabs";
  vadThreshold: number;
  minSpeechDuration: number;
  maxLatency: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
  monitoringPeriod: number;
}

// === Error Types ===

export class VoiceProcessingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = "VoiceProcessingError";
  }
}

export class MCPConnectionError extends Error {
  constructor(
    message: string,
    public readonly serverId: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = "MCPConnectionError";
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value: unknown
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

// === Desktop Commander Specific Types ===

export interface DesktopCommanderTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
}

export const DESKTOP_COMMANDER_TOOLS: Record<string, DesktopCommanderTool> = {
  // File Operations (Low Risk)
  read_file: {
    name: "read_file",
    description: "Read contents of a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        length: { type: "number" }
      },
      required: ["path"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },
  write_file: {
    name: "write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        append: { type: "boolean" }
      },
      required: ["path", "content"]
    },
    riskLevel: "medium",
    requiresConfirmation: true
  },
  list_directory: {
    name: "list_directory",
    description: "List contents of a directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        pattern: { type: "string" }
      },
      required: ["path"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },
  create_directory: {
    name: "create_directory",
    description: "Create a new directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" }
      },
      required: ["path"]
    },
    riskLevel: "medium",
    requiresConfirmation: true
  },
  move_file: {
    name: "move_file",
    description: "Move or rename a file or directory",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
        overwrite: { type: "boolean" }
      },
      required: ["source", "destination"]
    },
    riskLevel: "medium",
    requiresConfirmation: true
  },
  delete_file: {
    name: "delete_file",
    description: "Delete a file or directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        force: { type: "boolean" },
        recursive: { type: "boolean" }
      },
      required: ["path"]
    },
    riskLevel: "high",
    requiresConfirmation: true
  },

  // Search Operations (Low-Medium Risk)
  search_files: {
    name: "search_files",
    description: "Search for files and content using ripgrep",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        filePattern: { type: "string" },
        caseSensitive: { type: "boolean" }
      },
      required: ["pattern"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },
  start_search: {
    name: "start_search",
    description: "Start an interactive search session",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        directory: { type: "string" },
        maxResults: { type: "number" }
      },
      required: ["pattern"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },
  get_more_search_results: {
    name: "get_more_search_results",
    description: "Get additional search results from active search",
    inputSchema: {
      type: "object",
      properties: {
        searchId: { type: "string" },
        limit: { type: "number" }
      },
      required: ["searchId"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },
  stop_search: {
    name: "stop_search",
    description: "Stop an active search session",
    inputSchema: {
      type: "object",
      properties: {
        searchId: { type: "string" }
      },
      required: ["searchId"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },

  // Process Management (Medium-High Risk)
  start_process: {
    name: "start_process",
    description: "Start a new background process",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" }
      },
      required: ["command"]
    },
    riskLevel: "medium",
    requiresConfirmation: true
  },
  execute_command: {
    name: "execute_command",
    description: "Execute a command with confirmation",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean" },
        timeout: { type: "number" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" }
      },
      required: ["command"]
    },
    riskLevel: "medium",
    requiresConfirmation: true
  },
  read_process_output: {
    name: "read_process_output",
    description: "Read output from a running process",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        lines: { type: "number" }
      },
      required: ["session_id"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },
  kill_process: {
    name: "kill_process",
    description: "Kill a running process",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number" },
        processId: { type: "string" },
        signal: { type: "string" }
      },
      required: []
    },
    riskLevel: "high",
    requiresConfirmation: true
  },
  force_terminate: {
    name: "force_terminate",
    description: "Forcefully terminate a process",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" }
      },
      required: ["session_id"]
    },
    riskLevel: "high",
    requiresConfirmation: true
  },
  list_processes: {
    name: "list_processes",
    description: "Lists all running processes with detailed information",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    riskLevel: "low",
    requiresConfirmation: false
  },

  // Code Editing (Medium Risk)
  edit_block: {
    name: "edit_block",
    description: "Edit a specific block of text in a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        expected_replacements: { type: "number" }
      },
      required: ["path", "oldText", "newText"]
    },
    riskLevel: "medium",
    requiresConfirmation: true
  },

  // Configuration Management (Medium-High Risk)
  get_config: {
    name: "get_config",
    description: "Get current Desktop Commander configuration",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" }
      },
      required: []
    },
    riskLevel: "low",
    requiresConfirmation: false
  },
  set_config_value: {
    name: "set_config_value",
    description: "Set a configuration value",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" }
      },
      required: ["key", "value"]
    },
    riskLevel: "high",
    requiresConfirmation: true
  },

  // System Information (Low Risk)
  get_usage_stats: {
    name: "get_usage_stats",
    description: "Get system usage statistics",
    inputSchema: {
      type: "object",
      properties: {
        detailed: { type: "boolean" }
      },
      required: []
    },
    riskLevel: "low",
    requiresConfirmation: false
  },

  // Additional Desktop Commander Tools
  search_code: {
    name: "search_code",
    description: "Search for text patterns in file contents using ripgrep",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        file_path: { type: "string" },
        case_insensitive: { type: "boolean" },
        whole_word: { type: "boolean" }
      },
      required: ["pattern", "file_path"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },

  get_file_info: {
    name: "get_file_info",
    description: "Get detailed metadata about a file or directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },

  read_multiple_files: {
    name: "read_multiple_files",
    description: "Read contents from multiple files simultaneously",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } }
      },
      required: ["paths"]
    },
    riskLevel: "low",
    requiresConfirmation: false
  },

  list_sessions: {
    name: "list_sessions",
    description: "List all active terminal sessions",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    riskLevel: "low",
    requiresConfirmation: false
  },

  interact_with_process: {
    name: "interact_with_process",
    description: "Send a command to a running process and get response",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        command: { type: "string" }
      },
      required: ["session_id", "command"]
    },
    riskLevel: "medium",
    requiresConfirmation: true
  },

  give_feedback_to_desktop_commander: {
    name: "give_feedback_to_desktop_commander",
    description: "Open feedback form to provide feedback to Desktop Commander team",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    riskLevel: "low",
    requiresConfirmation: false
  },

  // Help and Information Commands
  get_help: {
    name: "get_help",
    description: "Get help information and show available voice commands",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    riskLevel: "low",
    requiresConfirmation: false
  }
};

// === Voice Command Mappings ===

export interface VoiceCommandMapping {
  pattern: string;
  tool: string;
  params: string[];
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
}

export const VOICE_COMMAND_MAPPINGS: Record<string, VoiceCommandMapping> = {
  // File Operations
  "read file {filename}": {
    pattern: "read file {filename}",
    tool: "read_file",
    params: ["filename"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "read {filename}": {
    pattern: "read {filename}",
    tool: "read_file",
    params: ["filename"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "show me {filename}": {
    pattern: "show me {filename}",
    tool: "read_file",
    params: ["filename"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "write to file {filename} content {content}": {
    pattern: "write to file {filename} content {content}",
    tool: "write_file",
    params: ["filename", "content"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "create file {filename} with {content}": {
    pattern: "create file {filename} with {content}",
    tool: "write_file",
    params: ["filename", "content"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "save {content} to {filename}": {
    pattern: "save {content} to {filename}",
    tool: "write_file",
    params: ["content", "filename"],
    riskLevel: "medium",
    requiresConfirmation: true
  },

  // Directory Operations
  "list files in {directory}": {
    pattern: "list files in {directory}",
    tool: "list_directory",
    params: ["directory"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "list directory {directory}": {
    pattern: "list directory {directory}",
    tool: "list_directory",
    params: ["directory"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "list recursive directory {directory}": {
    pattern: "list recursive directory {directory}",
    tool: "list_directory",
    params: ["directory"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "show directory {directory}": {
    pattern: "show directory {directory}",
    tool: "list_directory",
    params: ["directory"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "create directory {dirname}": {
    pattern: "create directory {dirname}",
    tool: "create_directory",
    params: ["dirname"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "make directory {dirname}": {
    pattern: "make directory {dirname}",
    tool: "create_directory",
    params: ["dirname"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "mkdir {dirname}": {
    pattern: "mkdir {dirname}",
    tool: "create_directory",
    params: ["dirname"],
    riskLevel: "medium",
    requiresConfirmation: true
  },

  // File Management
  "move {source} to {destination}": {
    pattern: "move {source} to {destination}",
    tool: "move_file",
    params: ["source", "destination"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "rename {source} to {destination}": {
    pattern: "rename {source} to {destination}",
    tool: "move_file",
    params: ["source", "destination"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "delete file {filename}": {
    pattern: "delete file {filename}",
    tool: "delete_file",
    params: ["filename"],
    riskLevel: "high",
    requiresConfirmation: true
  },
  "rm file {filename}": {
    pattern: "rm file {filename}",
    tool: "delete_file",
    params: ["filename"],
    riskLevel: "high",
    requiresConfirmation: true
  },
  "remove file {filename}": {
    pattern: "remove file {filename}",
    tool: "delete_file",
    params: ["filename"],
    riskLevel: "high",
    requiresConfirmation: true
  },

  // Search Operations
  "search for {pattern}": {
    pattern: "search for {pattern}",
    tool: "search_files",
    params: ["pattern"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "find {pattern}": {
    pattern: "find {pattern}",
    tool: "search_files",
    params: ["pattern"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "search {pattern} in {directory}": {
    pattern: "search {pattern} in {directory}",
    tool: "start_search",
    params: ["pattern", "directory"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "search {pattern} in {path}": {
    pattern: "search {pattern} in {path}",
    tool: "search_files",
    params: ["pattern", "path"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "search {pattern} case sensitive": {
    pattern: "search {pattern} case sensitive",
    tool: "search_files",
    params: ["pattern"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "start interactive search for {pattern}": {
    pattern: "start interactive search for {pattern}",
    tool: "start_search",
    params: ["pattern"],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "stop search": {
    pattern: "stop search",
    tool: "stop_search",
    params: [],
    riskLevel: "low",
    requiresConfirmation: false
  },

  // Process Management
  "run command {command}": {
    pattern: "run command {command}",
    tool: "start_process",
    params: ["command"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "execute {command}": {
    pattern: "execute {command}",
    tool: "start_process",
    params: ["command"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "execute {command} in background": {
    pattern: "execute {command} in background",
    tool: "start_process",
    params: ["command"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "run {command} with timeout {timeout}": {
    pattern: "run {command} with timeout {timeout}",
    tool: "start_process",
    params: ["command", "timeout"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "start process {command}": {
    pattern: "start process {command}",
    tool: "start_process",
    params: ["command"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "kill process {pid}": {
    pattern: "kill process {pid}",
    tool: "kill_process",
    params: ["pid"],
    riskLevel: "high",
    requiresConfirmation: true
  },
  "terminate process {pid}": {
    pattern: "terminate process {pid}",
    tool: "kill_process",
    params: ["pid"],
    riskLevel: "high",
    requiresConfirmation: true
  },
  "terminate force {process}": {
    pattern: "terminate force {process}",
    tool: "force_terminate",
    params: ["process"],
    riskLevel: "high",
    requiresConfirmation: true
  },
  "force kill {pid}": {
    pattern: "force kill {pid}",
    tool: "force_terminate",
    params: ["pid"],
    riskLevel: "high",
    requiresConfirmation: true
  },
  "read output from {processId}": {
    pattern: "read output from {processId}",
    tool: "read_process_output",
    params: ["processId"],
    riskLevel: "low",
    requiresConfirmation: false
  },

  // Code Editing
  "edit {filename} replace {oldText} with {newText}": {
    pattern: "edit {filename} replace {oldText} with {newText}",
    tool: "edit_block",
    params: ["filename", "oldText", "newText"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "edit block in {filename} replace {oldText} with {newText}": {
    pattern: "edit block in {filename} replace {oldText} with {newText}",
    tool: "edit_block",
    params: ["filename", "oldText", "newText"],
    riskLevel: "medium",
    requiresConfirmation: true
  },
  "replace {oldText} with {newText} in {filename}": {
    pattern: "replace {oldText} with {newText} in {filename}",
    tool: "edit_block",
    params: ["oldText", "newText", "filename"],
    riskLevel: "medium",
    requiresConfirmation: true
  },

  // Configuration
  "get configuration": {
    pattern: "get configuration",
    tool: "get_config",
    params: [],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "show config": {
    pattern: "show config",
    tool: "get_config",
    params: [],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "set config {key} to {value}": {
    pattern: "set config {key} to {value}",
    tool: "set_config_value",
    params: ["key", "value"],
    riskLevel: "high",
    requiresConfirmation: true
  },

  // System Information
  "get usage stats": {
    pattern: "get usage stats",
    tool: "get_usage_stats",
    params: [],
    riskLevel: "low",
    requiresConfirmation: false
  },
  "show system stats": {
    pattern: "show system stats",
    tool: "get_usage_stats",
    params: [],
    riskLevel: "low",
    requiresConfirmation: false
  }
};

