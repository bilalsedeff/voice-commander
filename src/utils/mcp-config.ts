/**
 * MCP Server Configuration Factory
 *
 * Creates standardized MCP server configurations for different server types
 * with proper validation, security defaults, and environment variable support.
 *
 * Dependencies:
 * - @modelcontextprotocol/sdk: https://github.com/modelcontextprotocol/typescript-sdk
 *
 * Input: Server type and optional configuration overrides
 * Output: Validated MCPServerConfig objects
 *
 * Example:
 * const config = createDesktopCommanderConfig();
 * const client = new MCPClient(config);
 */

import { MCPServerConfig, ValidationError } from "./types";

/**
 * Create Desktop Commander MCP server configuration
 */
export function createDesktopCommanderConfig(
  overrides: Partial<MCPServerConfig> = {}
): MCPServerConfig {
  const config: MCPServerConfig = {
    id: "desktop-commander",
    name: "Desktop Commander MCP",
    command: process.env.DESKTOP_COMMANDER_COMMAND || "npx",
    args: process.env.DESKTOP_COMMANDER_ARGS?.split(",") || ["-y", "@wonderwhy-er/desktop-commander"],
    transport: "stdio",
    timeout: parseInt(process.env.MCP_TIMEOUT || "5000"),
    env: {
      NODE_ENV: process.env.NODE_ENV || "development",
      LOG_LEVEL: process.env.LOG_LEVEL || "info"
    },
    ...overrides
  };

  validateMCPConfig(config);
  return config;
}

/**
 * Create custom MCP server configuration
 */
export function createCustomMCPConfig(
  id: string,
  name: string,
  command: string,
  args: string[] = [],
  overrides: Partial<MCPServerConfig> = {}
): MCPServerConfig {
  const config: MCPServerConfig = {
    id,
    name,
    command,
    args,
    transport: "stdio",
    timeout: 5000,
    ...overrides
  };

  validateMCPConfig(config);
  return config;
}

/**
 * Validate MCP server configuration
 */
function validateMCPConfig(config: MCPServerConfig): void {
  if (!config.id?.trim()) {
    throw new ValidationError("MCP server ID is required", "id", config.id);
  }

  if (!config.name?.trim()) {
    throw new ValidationError("MCP server name is required", "name", config.name);
  }

  if (!config.command?.trim()) {
    throw new ValidationError("MCP server command is required", "command", config.command);
  }

  if (!Array.isArray(config.args)) {
    throw new ValidationError("MCP server args must be an array", "args", config.args);
  }

  if (!["stdio", "sse", "websocket"].includes(config.transport)) {
    throw new ValidationError(
      "MCP transport must be 'stdio', 'sse', or 'websocket'",
      "transport",
      config.transport
    );
  }

  if (config.timeout && (config.timeout < 1000 || config.timeout > 60000)) {
    throw new ValidationError(
      "MCP timeout must be between 1000 and 60000 milliseconds",
      "timeout",
      config.timeout
    );
  }
}