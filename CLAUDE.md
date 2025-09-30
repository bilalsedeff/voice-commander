# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**Voice MCP Gateway** - A real-time voice-enabled MCP aggregator that orchestrates multiple MCP servers through natural speech commands, enabling voice-controlled workflows across development tools, productivity apps, and enterprise systems.

**Technology Stack**: Node.js + TypeScript, WebSocket/SSE, Redis, PostgreSQL, Docker
**Architecture**: Microservices (Voice Gateway + MCP Aggregator + Web Dashboard)
**Deployment**: Docker Compose with Claude Desktop integration

## Essential Commands

### Development

- Start development: `npm run dev`
- Build project: `npm run build`
- Run tests: `npm test`
- Run linting: `npm run lint`
- Type checking: `npm run type-check`

### Voice Integration

- Start voice gateway: `npm run voice:dev`
- Test voice pipeline: `npm run voice:test`
- Run with Desktop Commander: `npm run mcp:desktop-commander`

### Database & Services

- Start Redis: `docker-compose up redis -d`
- Start PostgreSQL: `docker-compose up postgres -d`
- Run migrations: `npm run db:migrate`
- Seed test data: `npm run db:seed`

### Deployment

- Build Docker images: `docker-compose build`
- Deploy development: `docker-compose up -d`
- Deploy production: `npm run deploy:prod`

## Implementation Philosophy

### Core Principles

- **Working Code First**: Always implement complete, functional solutions - no stubs, TODOs, or placeholders
- **Voice-Optimized**: Every feature must consider real-time voice interaction patterns (<500ms response)
- **MCP-Native**: Follow MCP protocol specifications exactly - compatibility is non-negotiable
- **Security-First**: Implement OAuth 2.1, input validation, and audit logging from day one
- **Performance-Critical**: Target <200ms voice processing latency for production readiness

### Implementation Standards

- Complete error handling with user-friendly voice feedback
- Comprehensive input validation for all voice commands
- Real-time status updates for long-running operations
- Circuit breaker patterns for external MCP connections
- Graceful degradation when upstream services fail

## File Structure & Architecture

```plaintext
voice-mcp/
├── src/
│   ├── gateway/          # Voice MCP Gateway server
│   ├── voice/           # Voice processing pipeline
│   ├── aggregator/      # MCP connection management
│   ├── auth/            # Authentication & authorization
│   ├── dashboard/       # Web management interface
│   └── utils/           # Shared utilities
├── tests/
│   ├── unit/           # Component unit tests
│   ├── integration/    # MCP integration tests
│   └── voice/          # Voice pipeline tests
├── config/             # Configuration files
├── docs/               # Documentation
└── docker/             # Docker configurations
```

**SAFE TO MODIFY**:

- `/src/` - All application source code
- `/tests/` - Test files and test data
- `/config/` - Configuration files
- `/docs/` - Documentation

**NEVER MODIFY**:

- `/node_modules/` - Dependencies
- `/.git/` - Version control
- `/dist/` or `/build/` - Build outputs
- `/.env` files - Environment variables (reference only)

## Code Style & Architecture Standards

### Naming Conventions

- **Variables/Functions**: camelCase (`voiceProcessor`, `handleCommand`)
- **Classes**: PascalCase (`VoiceGateway`, `MCPAggregator`)
- **Constants**: SCREAMING_SNAKE_CASE (`MAX_VOICE_LATENCY`)
- **Files**: kebab-case (`voice-processor.ts`, `mcp-client.ts`)
- **Directories**: lowercase (`voice`, `aggregator`, `auth`)

### TypeScript Standards

```typescript
// Always use explicit return types for public functions
export async function processVoiceCommand(
  audio: Buffer,
  sessionId: string
): Promise<VoiceCommandResult> {
  // Implementation
}

// Use strict type definitions for MCP protocol
interface MCPToolCall {
  method: string;
  params: Record<string, unknown>;
  id: string | number;
}

// Prefer interfaces over types for extensibility
interface VoiceSession {
  id: string;
  userId: string;
  startTime: Date;
  mcpConnections: MCPConnection[];
}
```

### Architecture Patterns

- **Event-Driven**: Use EventEmitter for voice pipeline components
- **Repository Pattern**: Abstract MCP connections behind consistent interfaces
- **Command Pattern**: Map voice commands to MCP tool calls
- **Circuit Breaker**: Protect against upstream MCP failures
- **Observer Pattern**: Real-time status updates to dashboard

## Voice-Specific Requirements

### Latency Targets

- **Voice Recognition**: <300ms (STT processing)
- **Command Execution**: <200ms (MCP tool call)
- **Voice Response**: <400ms (TTS generation)
- **End-to-End**: <1000ms (complete voice interaction)

### Error Handling Patterns

```typescript
// Voice commands must have audio feedback for errors
export async function handleVoiceError(
  error: Error,
  session: VoiceSession
): Promise<void> {
  await session.speak(`Sorry, ${error.message}. Please try again.`);
  await session.logError(error);
}

// Always provide confirmation for high-risk operations
export async function confirmDestructiveCommand(
  command: VoiceCommand,
  session: VoiceSession
): Promise<boolean> {
  await session.speak(`This will ${command.description}. Say "confirm" to proceed.`);
  const response = await session.waitForConfirmation(10000); // 10s timeout
  return response.confirmed;
}
```

## MCP Integration Standards

### Connection Management

```typescript
// All MCP clients must implement circuit breaker pattern
export class MCPClient {
  private circuitBreaker: CircuitBreaker;

  async callTool(name: string, params: unknown): Promise<unknown> {
    return this.circuitBreaker.execute(async () => {
      return await this.rawCall(name, params);
    });
  }
}

// Dynamic MCP server discovery and health checking
export async function healthCheckMCPServers(): Promise<MCPServerStatus[]> {
  // Must check all registered MCP servers every 30 seconds
}
```

### Tool Mapping

```typescript
// Voice commands map to universal tool abstractions
export const VOICE_COMMAND_MAPPINGS = {
  "read file {filename}": {
    mcpTool: "read_file",
    params: ["filename"],
    riskLevel: "low"
  },
  "kill process {name}": {
    mcpTool: "kill_process",
    params: ["name"],
    riskLevel: "high",
    requiresConfirmation: true
  }
} as const;
```

## Security & Authentication

### OAuth 2.1 Implementation

- Use PKCE for all OAuth flows
- Implement refresh token rotation
- Store tokens in secure HTTP-only cookies
- Validate all JWTs with proper key rotation

### Voice Security

- Validate voice commands against user permissions
- Log all voice interactions with audit trails
- Implement voice activity detection to prevent accidental triggers
- Rate limit voice commands (max 10/minute per user)

### Input Validation

```typescript
// All voice parameters must be validated
export function validateVoiceCommand(
  command: string,
  params: Record<string, unknown>
): ValidationResult {
  // Validate against command schema
  // Sanitize file paths and system commands
  // Check user permissions for requested operation
}
```

## Testing Requirements

### Voice Pipeline Testing

```typescript
// Test with real audio data, not mocked responses
describe("Voice Recognition", () => {
  it("should recognize technical commands accurately", async () => {
    const audioBuffer = await loadTestAudio("read-package-json.wav");
    const result = await voiceProcessor.processAudio(audioBuffer);

    expect(result.command).toBe("read file package.json");
    expect(result.confidence).toBeGreaterThan(0.95);
  });
});
```

### MCP Integration Testing

- Test with real MCP servers, not mocks
- Verify error handling for connection failures
- Test command mapping for all supported voice commands
- Validate latency requirements under load

### Performance Testing

- Load test with 50+ concurrent voice sessions
- Measure end-to-end latency percentiles (P50, P95, P99)
- Test memory usage during extended voice sessions
- Verify graceful degradation patterns

## Development Workflow

### Version Control

- Commit frequently with descriptive messages
- Use conventional commits: `feat:`, `fix:`, `refactor:`
- Create feature branches for all new functionality
- Require pull request reviews for main branch

### Pre-commit Requirements

1. All tests pass (`npm test`)
2. Linting passes (`npm run lint`)
3. Type checking passes (`npm run type-check`)
4. Voice pipeline tests pass (`npm run voice:test`)
5. Security scan passes (`npm run security:scan`)

### Documentation Standards

- Update API documentation for all public interfaces
- Document voice command mappings in `/docs/voice-commands.md`
- Maintain MCP server compatibility matrix
- Include performance benchmarks in release notes

## Quality Assurance Metrics

### Success Indicators

- ✅ Voice commands execute in <1000ms end-to-end
- ✅ >95% voice recognition accuracy for technical terms
- ✅ Zero placeholder implementations or TODOs
- ✅ All MCP servers maintain >99% uptime
- ✅ Security tests pass with zero critical vulnerabilities

### Failure Recognition

- ❌ Voice latency exceeding 1500ms
- ❌ MCP connection failures without graceful fallback
- ❌ Missing error handling for voice command edge cases
- ❌ Security vulnerabilities in authentication flows
- ❌ Performance degradation under concurrent load

## 🔴 ABSOLUTE REQUIREMENTS & PROHIBITIONS

### NEVER Do These (Zero Tolerance)

- ❌ **NO Mocking Core Functionality**: Never mock MCP connections, voice processing, or business logic in tests
- ❌ **NO Placeholder Code**: Never use TODO, FIXME, or "will implement later" comments
- ❌ **NO "any" Types**: Always use specific TypeScript types - `any` is forbidden
- ❌ **NO Conditional Imports**: Never use try/catch for required package imports
- ❌ **NO Social Validation**: Never use "Great idea!", "You're right!" or similar phrases
- ❌ **NO Partial Implementations**: Every function must be complete and working
- ❌ **NO Magic Numbers**: Always use named constants for timeouts, limits, etc.
- ❌ **NO Silent Failures**: Every error must be logged and handled appropriately
- ❌ **NO Credentials in Code**: Never hardcode API keys, tokens, or passwords

### ALWAYS Do These (Mandatory)

- ✅ **Real Data Testing**: Test with actual audio files, real MCP servers, genuine data
- ✅ **Complete Error Handling**: Every async operation needs try/catch with specific error types
- ✅ **Type Safety**: Use strict TypeScript - enable `noImplicitAny`, `strictNullChecks`
- ✅ **Input Validation**: Validate all parameters before processing
- ✅ **Performance Logging**: Log execution times for voice commands and MCP calls
- ✅ **Circuit Breakers**: Implement for all external dependencies
- ✅ **Audit Trails**: Log all voice commands and MCP operations
- ✅ **Resource Cleanup**: Close connections, clear timeouts, release memory

## MCP Server Development Standards

### Module Requirements (Strict Compliance)

- **Maximum 500 lines per file** - Split larger files immediately
- **Documentation header mandatory** for every file:

  ```typescript
  /**
   * Voice Command Processor
   *
   * Processes natural language voice commands and maps them to MCP tool calls.
   * Uses OpenAI Whisper for STT and validates commands against security policies.
   *
   * Dependencies:
   * - @modelcontextprotocol/sdk: https://github.com/modelcontextprotocol/typescript-sdk
   * - whisper-node: https://github.com/ariym/whisper-node
   *
   * Input: Buffer (audio data), string (session ID)
   * Output: VoiceCommandResult with mapped MCP tool call
   *
   * Example:
   * const result = await processVoiceCommand(audioBuffer, "session-123");
   * // result.mcpCall = { tool: "read_file", params: { filename: "package.json" } }
   */
  ```

### Validation Function Requirements

Every module MUST have a validation function that:

```typescript
if (__filename === process.argv[1]) {
  // Validation function that tests with REAL data
  async function validateModule() {
    const failures: string[] = [];
    let totalTests = 0;

    // Test 1: Basic functionality
    totalTests++;
    try {
      const result = await processVoiceCommand(realAudioBuffer, "test-session");
      if (!result.mcpCall || !result.confidence) {
        failures.push("Basic test: Missing required result properties");
      }
    } catch (error) {
      failures.push(`Basic test: ${error.message}`);
    }

    // Test 2: Error handling
    totalTests++;
    try {
      await processVoiceCommand(null as any, "test");
      failures.push("Error test: Should throw for null input");
    } catch (error) {
      // Expected - test passes
    }

    // Report results
    if (failures.length > 0) {
      console.error(`❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
      failures.forEach(f => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log(`✅ VALIDATION PASSED - All ${totalTests} tests successful`);
      process.exit(0);
    }
  }

  validateModule().catch(console.error);
}
```

### Type System Enforcement

```typescript
// FORBIDDEN - Never use 'any'
function badFunction(data: any): any { }

// REQUIRED - Always use specific types
interface VoiceCommandParams {
  filename?: string;
  processName?: string;
  directory?: string;
}

function goodFunction(
  command: string,
  params: VoiceCommandParams
): Promise<MCPToolResult> {
  // Implementation
}

// REQUIRED - Use union types instead of any
type MCPServerTransport = "stdio" | "sse" | "websocket";
type RiskLevel = "low" | "medium" | "high";
```

### Error Handling Patterns (Mandatory)

```typescript
// REQUIRED - Specific error types with context
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

// REQUIRED - Comprehensive async error handling
export async function processVoiceCommand(
  audio: Buffer,
  sessionId: string
): Promise<VoiceCommandResult> {
  try {
    validateInput(audio, sessionId);

    const transcript = await transcribeAudio(audio);
    const command = await parseCommand(transcript);
    const result = await executeMCPCommand(command);

    return result;
  } catch (error) {
    logger.error("Voice command processing failed", {
      sessionId,
      error: error.message,
      stack: error.stack
    });

    if (error instanceof ValidationError) {
      throw new VoiceProcessingError(
        "Invalid voice command parameters",
        "VALIDATION_ERROR",
        error
      );
    }

    throw new VoiceProcessingError(
      "Voice processing failed",
      "PROCESSING_ERROR",
      error
    );
  }
}
```

### MCP Client Implementation Rules

```typescript
// REQUIRED - Circuit breaker for all MCP connections
export class MCPConnection {
  private circuitBreaker = new CircuitBreaker(this.rawCall.bind(this), {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000
  });

  async callTool(name: string, params: unknown): Promise<unknown> {
    // REQUIRED - Input validation
    if (!name?.trim()) {
      throw new ValidationError("Tool name is required");
    }

    // REQUIRED - Performance monitoring
    const startTime = Date.now();

    try {
      const result = await this.circuitBreaker.fire(name, params);

      // REQUIRED - Success logging
      logger.info("MCP tool call successful", {
        tool: name,
        duration: Date.now() - startTime,
        serverId: this.serverId
      });

      return result;
    } catch (error) {
      // REQUIRED - Failure logging with context
      logger.error("MCP tool call failed", {
        tool: name,
        duration: Date.now() - startTime,
        serverId: this.serverId,
        error: error.message
      });

      throw error;
    }
  }

  // REQUIRED - Health checking
  async healthCheck(): Promise<boolean> {
    try {
      await this.callTool("ping", {});
      return true;
    } catch {
      return false;
    }
  }
}
```

### Testing Standards (Non-Negotiable)

```typescript
// REQUIRED - Test with real MCP servers
describe("MCP Integration", () => {
  let mcpConnection: MCPConnection;

  beforeEach(async () => {
    // Use real Desktop Commander MCP for testing
    mcpConnection = await MCPConnection.connect({
      command: "npx",
      args: ["@wonderwhy-er/desktop-commander"],
      transport: "stdio"
    });
  });

  // REQUIRED - Test actual functionality, not mocks
  it("should read real files through Desktop Commander", async () => {
    const result = await mcpConnection.callTool("read_file", {
      path: "package.json"
    });

    expect(result).toBeDefined();
    expect(typeof result.content).toBe("string");
    expect(result.content.includes("name")).toBe(true);
  });

  // REQUIRED - Test error scenarios
  it("should handle file not found errors", async () => {
    await expect(
      mcpConnection.callTool("read_file", { path: "nonexistent.txt" })
    ).rejects.toThrow();
  });
});
```

### Performance Requirements (Enforced)

```typescript
// REQUIRED - Performance monitoring decorators
function performanceMonitor(target: any, propertyName: string, descriptor: PropertyDescriptor) {
  const method = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    const start = Date.now();
    try {
      const result = await method.apply(this, args);
      const duration = Date.now() - start;

      // REQUIRED - Log performance metrics
      logger.info(`${propertyName} completed`, { duration });

      // REQUIRED - Enforce latency requirements
      if (propertyName.includes("voice") && duration > 1000) {
        logger.warn(`Voice operation exceeded 1000ms: ${duration}ms`);
      }

      return result;
    } catch (error) {
      logger.error(`${propertyName} failed after ${Date.now() - start}ms`);
      throw error;
    }
  };
}

// Usage
export class VoiceProcessor {
  @performanceMonitor
  async processVoiceCommand(audio: Buffer): Promise<VoiceCommandResult> {
    // Implementation
  }
}
```

### Security Enforcement (Zero Tolerance)

```typescript
// REQUIRED - Input sanitization for all voice commands
export function sanitizeVoiceInput(input: string): string {
  // Remove potential injection attempts
  return input
    .replace(/[;&|`$(){}[\]<>]/g, "") // Remove shell metacharacters
    .replace(/\.\./g, "")             // Remove directory traversal
    .trim()
    .slice(0, 1000);                  // Limit length
}

// REQUIRED - Permission validation
export async function validateVoicePermission(
  userId: string,
  command: VoiceCommand
): Promise<void> {
  const userPermissions = await getUserPermissions(userId);

  if (!userPermissions.includes(command.mcpTool)) {
    throw new SecurityError(
      `User ${userId} not authorized for tool ${command.mcpTool}`
    );
  }

  if (command.riskLevel === "high" && !userPermissions.includes("admin")) {
    throw new SecurityError(
      `High-risk command ${command.mcpTool} requires admin privileges`
    );
  }
}
```

## 🔴 COMPLIANCE VERIFICATION

Before completing ANY task, verify ALL of these requirements:

1. ✅ **Zero "any" types** - Check with `npm run type-check`
2. ✅ **No mocking** - Only integration tests with real services
3. ✅ **Complete error handling** - Every async call wrapped in try/catch
4. ✅ **Input validation** - All parameters validated before use
5. ✅ **Performance logging** - All operations timed and logged
6. ✅ **Real data testing** - Validation functions use actual data
7. ✅ **Security checks** - All voice inputs sanitized and authorized
8. ✅ **Resource cleanup** - All connections closed, timeouts cleared
9. ✅ **Circuit breakers** - All external calls protected
10. ✅ **Audit trails** - All operations logged with context

### **FAILURE TO COMPLY WITH ANY REQUIREMENT RESULTS IN IMMEDIATE REJECTION**

This configuration enforces production-ready voice-enabled MCP development with zero tolerance for shortcuts or incomplete implementations.
