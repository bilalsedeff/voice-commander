# LLM-Driven MCP Orchestration Architecture

## Executive Summary

Replace regex-based command mapping with intelligent LLM-driven orchestration where GPT-4.1-nano:
1. Understands user intent from natural language
2. Discovers available MCPs and their capabilities in real-time
3. Maps queries to appropriate MCP tools
4. Builds command execution chains
5. Executes with real-time progress streaming

## Current Architecture (What We're Replacing)

```
Voice Command
    ↓
CommandMapper (REGEX-BASED ❌)
    ├─ Pattern: /schedule.*meeting/i
    ├─ Pattern: /show.*calendar/i
    └─ Pattern: /delete.*event/i
    ↓
VoiceOrchestrator
    ↓
MCPConnectionManagerV2
    ↓
MCP Servers
```

**Problems**:
- ❌ Hardcoded regex patterns (inflexible)
- ❌ Cannot adapt to new MCP tools
- ❌ Limited to predefined command structures
- ❌ No intelligent tool selection
- ❌ Cannot handle ambiguous queries

## New Architecture (LLM-Driven)

```
Voice Command
    ↓
LLM-MCP Orchestrator (GPT-4.1-nano ✅)
    │
    ├─ Step 1: Analyze Intent
    │   └─ "schedule meeting tomorrow at 3pm with John"
    │       → Intent: calendar_event_creation
    │       → Entities: {time: "tomorrow 3pm", attendee: "John"}
    │
    ├─ Step 2: Get Healthy MCPs
    │   └─ Query: mcpConnectionManagerV2.getUserConnections(userId)
    │       → Result: [google, slack, github]
    │
    ├─ Step 3: Dynamic Tool Discovery
    │   ├─ For each connected MCP:
    │   │   └─ Query: instance.discoverTools()
    │   │       → google: [create_event, list_events, update_event, ...]
    │   │       → slack: [send_message, create_channel, ...]
    │   │       → github: [create_issue, list_repos, ...]
    │   │
    │   └─ Build tool registry with schemas
    │
    ├─ Step 4: LLM Tool Selection
    │   └─ Send to GPT-4.1-nano:
    │       Prompt: "User wants: 'schedule meeting tomorrow at 3pm with John'"
    │       Available tools: {google: [create_event, ...], slack: [...]}
    │
    │       LLM Response:
    │       {
    │         "selectedTools": [
    │           {
    │             "service": "google",
    │             "tool": "create_event",
    │             "params": {
    │               "summary": "Meeting with John",
    │               "startTime": "tomorrow at 3pm",
    │               "attendees": ["john@example.com"]
    │             }
    │           }
    │         ],
    │         "executionPlan": "Create calendar event for tomorrow at 3pm",
    │         "confidence": 0.95
    │       }
    │
    ├─ Step 5: Execute Command Chain
    │   └─ For each tool in selectedTools:
    │       ├─ Stream: "Creating calendar event..."
    │       ├─ Execute: mcpConnectionManagerV2.callTool(...)
    │       ├─ Stream: "✓ Event created successfully"
    │       └─ Handle errors gracefully
    │
    └─ Step 6: Return Results
        └─ {
            success: true,
            results: [...],
            executionTime: 1234,
            progressUpdates: [...]
          }
```

## Component Design

### 1. LLM-MCP Orchestrator (`llm-mcp-orchestrator.ts`)

**Responsibilities**:
- Query MCPs for available tools
- Send tool schemas to LLM
- Parse LLM responses (JSON structured output)
- Build execution plans
- Execute with real-time streaming
- Handle errors and retries

**Key Methods**:

```typescript
export class LLMMCPOrchestrator {
  async processQuery(
    userId: string,
    query: string,
    options?: {
      streaming?: boolean;
      onProgress?: (update: ProgressUpdate) => void;
    }
  ): Promise<OrchestrationResult>

  private async discoverAvailableTools(
    userId: string
  ): Promise<ToolRegistry>

  private async selectTools(
    query: string,
    toolRegistry: ToolRegistry
  ): Promise<ExecutionPlan>

  private async executeCommandChain(
    plan: ExecutionPlan,
    onProgress?: (update: ProgressUpdate) => void
  ): Promise<ExecutionResult[]>

  private async handleError(
    error: Error,
    context: ExecutionContext
  ): Promise<ErrorResolution>
}
```

### 2. Tool Discovery Protocol

Each MCP instance exposes:

```typescript
interface MCPTool {
  name: string;
  description: string;
  parameters: {
    name: string;
    type: string;
    required: boolean;
    description: string;
  }[];
  examples?: string[];
}

// Example: Google Calendar MCP
{
  name: "create_event",
  description: "Create a new calendar event with attendees and reminders",
  parameters: [
    { name: "summary", type: "string", required: true, description: "Event title" },
    { name: "startTime", type: "string", required: true, description: "Start time (ISO or natural)" },
    { name: "endTime", type: "string", required: false, description: "End time" },
    { name: "attendees", type: "string[]", required: false, description: "Email addresses" }
  ],
  examples: [
    "Create event: Meeting with John tomorrow at 3pm",
    "Schedule: Team standup every Monday 10am"
  ]
}
```

### 3. LLM Prompt Engineering

**System Prompt**:
```
You are an intelligent MCP tool orchestrator. Your job is to:
1. Understand user intent from natural language queries
2. Select the most appropriate MCP tools to fulfill the request
3. Extract parameters from the query
4. Build a sequential execution plan
5. Output structured JSON

Available MCP Tools:
{tool_registry_json}

Rules:
- Only use tools that are explicitly available
- Prefer single tools over chains when possible
- Extract all parameters from user query
- Use natural language time expressions (e.g., "tomorrow 3pm")
- If uncertain, ask for clarification
- Return confidence score (0-1)

Output Format (JSON):
{
  "selectedTools": [...],
  "executionPlan": "human-readable description",
  "confidence": 0.95,
  "needsClarification": false,
  "clarificationQuestion": null
}
```

**User Prompt**:
```
User Query: "{user_query}"

Context:
- Connected Services: {connected_services}
- Previous Commands: {conversation_history}
- User Timezone: {timezone}

Analyze this query and select appropriate tools to execute.
```

### 4. Real-Time Progress Streaming

**Server-Sent Events (SSE)** for progress updates:

```typescript
interface ProgressUpdate {
  type: 'analyzing' | 'discovering' | 'executing' | 'completed' | 'error';
  message: string;
  timestamp: number;
  data?: any;
}

// Example Flow:
1. { type: 'analyzing', message: 'Analyzing your request...' }
2. { type: 'discovering', message: 'Found Google Calendar and Slack' }
3. { type: 'discovering', message: 'Discovered 15 available commands' }
4. { type: 'executing', message: 'Creating calendar event...', data: {tool: 'create_event'} }
5. { type: 'completed', message: '✓ Event created successfully', data: {eventId: '123'} }
```

**WebSocket Alternative**:
- Bidirectional communication
- Support for multi-turn conversations
- Real-time clarification requests

### 5. Error Handling & Recovery

**Strategy**:
1. **MCP Connection Errors**: Auto-retry with backoff
2. **Tool Execution Errors**: LLM decides fallback
3. **Ambiguous Queries**: Request clarification
4. **Missing Parameters**: Extract from conversation history

```typescript
interface ErrorResolution {
  strategy: 'retry' | 'fallback' | 'clarify' | 'abort';
  retryCount?: number;
  fallbackPlan?: ExecutionPlan;
  clarificationQuestion?: string;
  reasoning: string;
}

// Example: Parameter missing
{
  strategy: 'clarify',
  clarificationQuestion: "What time should I schedule the meeting?",
  reasoning: "User didn't specify meeting time"
}
```

## Data Flow

### Request Flow
```
1. User: "Schedule meeting with John tomorrow"
2. API: POST /api/voice/command
3. LLM-MCP Orchestrator:
   ├─ Get connected MCPs
   ├─ Query tools from each MCP
   ├─ Send to GPT-4.1-nano
   ├─ Parse LLM response
   ├─ Execute tool chain
   └─ Stream progress
4. Response: SSE stream → WebSocket → HTTP response
```

### Tool Discovery Caching
```
Cache Strategy:
- TTL: 5 minutes
- Invalidate on: MCP disconnect/reconnect
- Key: `tools:${userId}:${provider}`
- Storage: Redis or in-memory Map

Benefits:
- Reduce MCP queries
- Faster response times
- Lower latency for repeated queries
```

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Intent Analysis | <200ms | GPT-4.1-nano latency |
| Tool Discovery | <100ms | With caching |
| Tool Execution | <500ms | Per MCP call |
| Total E2E | <1000ms | For simple queries |
| Streaming First Byte | <300ms | Progress feedback |

## Security Considerations

1. **Tool Validation**: Verify tools exist before execution
2. **Parameter Sanitization**: Validate all LLM-extracted params
3. **Rate Limiting**: Max 10 queries/min per user
4. **Audit Logging**: Log all LLM decisions and tool executions
5. **PII Protection**: Sanitize sensitive data in logs

## Migration Strategy

### Phase 1: Parallel Implementation
- Keep existing CommandMapper
- Implement LLM-MCP Orchestrator
- A/B test both approaches
- Measure accuracy and latency

### Phase 2: Gradual Rollout
- Route 10% traffic to LLM orchestrator
- Monitor errors and performance
- Increase to 50%, then 100%
- Keep regex as fallback

### Phase 3: Deprecation
- Remove CommandMapper
- Clean up unused code
- Update documentation
- Train team on new system

## Testing Strategy

### Unit Tests
- LLM response parsing
- Tool selection logic
- Error handling
- Progress streaming

### Integration Tests
- Real MCP connections
- LLM API calls
- End-to-end flows
- Error scenarios

### Load Tests
- 100 concurrent users
- Measure latency P50, P95, P99
- Test MCP connection pooling
- Verify streaming performance

## Monitoring & Observability

**Key Metrics**:
- LLM intent accuracy (manual review)
- Tool selection correctness
- Execution success rate
- Average latency per component
- Cost per query (LLM usage)

**Dashboards**:
1. Real-time query processing
2. MCP health status
3. LLM usage and costs
4. Error rates by type
5. User satisfaction (feedback)

## Cost Analysis

**Per 1000 Queries**:
- GPT-4.1-nano: ~$0.10 (assuming 2K tokens avg)
- MCP API calls: ~$0.00 (self-hosted)
- Infrastructure: ~$0.05
- **Total**: ~$0.15/1000 queries

**Optimization**:
- Cache tool discovery (5min TTL)
- Batch similar queries
- Use FAST tier (GPT-4.1-nano) for simple queries
- Fallback to BALANCED/SMART only when needed

## Success Criteria

✅ **Complete Success** if:
1. ≥95% queries map to correct tools
2. Average latency <1000ms
3. Error rate <5%
4. User satisfaction >4.5/5
5. No regex patterns remaining
6. Supports all MCP tools dynamically
7. Real-time progress streaming works
8. Cost <$0.20/1000 queries

## Implementation Timeline

**Week 1**: Core orchestrator + tool discovery
**Week 2**: LLM integration + prompt engineering
**Week 3**: Progress streaming + error handling
**Week 4**: Testing + documentation
**Week 5**: A/B testing + rollout

## Next Steps

1. ✅ Review and approve architecture
2. Create `llm-mcp-orchestrator.ts`
3. Implement tool discovery
4. Integrate with LLM service
5. Add progress streaming
6. Write comprehensive tests
7. Deploy and monitor

---

**Status**: 🎯 Ready for implementation
**Reviewed by**: Senior Architecture Team
**Approved**: Pending stakeholder review
