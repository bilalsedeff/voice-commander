# SSE Streaming Architecture Design

## Executive Summary

Implement Server-Sent Events (SSE) for real-time progress updates during voice command execution, providing users with immediate feedback at each stage of the LLM-MCP orchestration pipeline.

---

## Why SSE Instead of WebSocket?

| Feature | SSE | WebSocket |
|---------|-----|-----------|
| **Complexity** | Simple HTTP | Complex protocol |
| **Direction** | Server → Client only | Bidirectional |
| **Use Case** | Progress updates | Interactive chat |
| **Auto-Reconnect** | Built-in | Manual implementation |
| **Browser Support** | EventSource API | WebSocket API |
| **Our Need** | ✅ One-way updates | ❌ Don't need bidirectional |

**Decision**: SSE is perfect for our use case (progress streaming).

---

## API Design

### **Endpoint 1: Streaming Execution**

```http
POST /api/voice/llm/stream
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "query": "schedule meeting tomorrow at 3pm and send slack message"
}
```

**Response Headers**:
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**Response Body** (SSE format):
```
event: progress
data: {"type":"analyzing","message":"Analyzing your request...","timestamp":1696089600000}

event: progress
data: {"type":"discovering","message":"Found 2 services with 10 commands","timestamp":1696089600100}

event: progress
data: {"type":"selecting","message":"Selecting best commands...","timestamp":1696089600200}

event: progress
data: {"type":"executing","message":"Executing: create_event (1/2)","timestamp":1696089600300,"data":{"service":"google_calendar","tool":"create_event"}}

event: progress
data: {"type":"completed","message":"✓ create_event completed successfully","timestamp":1696089600750,"data":{"eventId":"abc123"}}

event: progress
data: {"type":"executing","message":"Executing: send_message (2/2)","timestamp":1696089600800,"data":{"service":"slack","tool":"send_message"}}

event: progress
data: {"type":"completed","message":"✓ send_message completed successfully","timestamp":1696089601150,"data":{"messageId":"xyz789"}}

event: done
data: {"success":true,"totalExecutionTime":1200,"results":[...]}

```

**Error Response**:
```
event: error
data: {"error":"MCP_NOT_CONNECTED","message":"Google Calendar is not connected","timestamp":1696089600500}

event: done
data: {"success":false,"error":"MCP_NOT_CONNECTED"}

```

---

### **Endpoint 2: Non-Streaming (Existing)**

```http
POST /api/voice/llm
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "query": "schedule meeting tomorrow at 3pm"
}
```

**Response**: Regular JSON (no streaming)

**Use Case**: When client doesn't support SSE or prefers single response.

---

## SSE Message Protocol

### **Message Types**

#### **1. Progress Updates**
```typescript
{
  type: 'analyzing' | 'discovering' | 'selecting' | 'executing' | 'completed',
  message: string,
  timestamp: number,
  data?: any
}
```

**Examples**:
```json
{"type":"analyzing","message":"Analyzing your request...","timestamp":123}
{"type":"discovering","message":"Found 2 services with 10 commands","timestamp":456}
{"type":"executing","message":"Executing: create_event (1/2)","timestamp":789,"data":{"service":"google_calendar"}}
```

#### **2. Error Events**
```typescript
{
  type: 'error',
  error: string,
  message: string,
  timestamp: number
}
```

**Example**:
```json
{"type":"error","error":"MCP_NOT_CONNECTED","message":"Slack is not connected","timestamp":999}
```

#### **3. Completion Event**
```typescript
{
  success: boolean,
  totalExecutionTime: number,
  results: ExecutionResult[],
  error?: string
}
```

**Example**:
```json
{
  "success": true,
  "totalExecutionTime": 1200,
  "results": [
    {"success":true,"service":"google_calendar","tool":"create_event","data":{...},"executionTime":450},
    {"success":true,"service":"slack","tool":"send_message","data":{...},"executionTime":350}
  ]
}
```

---

## Implementation Architecture

### **Server-Side Flow**

```typescript
// routes/voice.ts

router.post('/llm/stream', authenticateToken, async (req, res) => {
  // 1. Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { query } = req.body;
  const userId = req.user!.userId;

  // 2. Helper to send SSE message
  const sendSSE = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // 3. Process query with streaming callback
    await llmMCPOrchestrator.processQuery(userId, query, {
      streaming: true,
      onProgress: (update) => {
        sendSSE('progress', update);
      }
    });

    // 4. Send completion event
    sendSSE('done', result);

  } catch (error) {
    // 5. Send error event
    sendSSE('error', {
      type: 'error',
      error: 'ORCHESTRATION_ERROR',
      message: error.message,
      timestamp: Date.now()
    });
    sendSSE('done', { success: false, error: error.message });
  } finally {
    // 6. Close connection
    res.end();
  }
});
```

### **Client-Side (Frontend)**

```typescript
// Frontend: Using EventSource API

const eventSource = new EventSource('/api/voice/llm/stream', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});

// Listen for progress updates
eventSource.addEventListener('progress', (event) => {
  const update = JSON.parse(event.data);

  switch (update.type) {
    case 'analyzing':
      setStatus('Analyzing your request...');
      break;
    case 'executing':
      setStatus(`Executing: ${update.data.tool}...`);
      break;
    case 'completed':
      addResult(update.data);
      break;
  }
});

// Listen for completion
eventSource.addEventListener('done', (event) => {
  const result = JSON.parse(event.data);
  setFinalResult(result);
  eventSource.close();
});

// Listen for errors
eventSource.addEventListener('error', (event) => {
  const error = JSON.parse(event.data);
  showError(error.message);
});

// Cleanup on unmount
return () => eventSource.close();
```

---

## Connection Lifecycle

### **1. Connection Establishment**

```
Client                          Server
  |                               |
  |--- POST /api/voice/llm/stream ---|
  |    Auth: Bearer token         |
  |    Body: { query: "..." }     |
  |                               |
  |<-- 200 OK ----------------------|
  |    Content-Type: text/event-stream
  |    Connection: keep-alive     |
  |                               |
```

### **2. Streaming Phase**

```
Client                          Server
  |                               |
  |<-- event: progress ------------|
  |    data: {"type":"analyzing"} |
  |                               |
  |<-- event: progress ------------|
  |    data: {"type":"executing"} |
  |                               |
  |<-- event: progress ------------|
  |    data: {"type":"completed"} |
  |                               |
```

### **3. Connection Termination**

```
Client                          Server
  |                               |
  |<-- event: done ----------------|
  |    data: {success:true,...}   |
  |                               |
  |<-- Connection: close ----------|
  |                               |
  [EventSource.close()]          [res.end()]
```

---

## Error Handling

### **Scenario 1: Client Disconnect**

```typescript
// Server detects client disconnect
req.on('close', () => {
  logger.info('Client disconnected, cleaning up SSE connection');
  // Cancel ongoing MCP operations
  orchestrator.cancelExecution(userId, executionId);
});
```

### **Scenario 2: Server Error**

```typescript
try {
  await orchestrator.processQuery(...);
} catch (error) {
  // Send error event
  sendSSE('error', {
    type: 'error',
    error: 'ORCHESTRATION_ERROR',
    message: error.message
  });

  // Send done with failure
  sendSSE('done', { success: false });

  // Close connection
  res.end();
}
```

### **Scenario 3: Network Timeout**

```typescript
// Set timeout for SSE connection
const timeout = setTimeout(() => {
  sendSSE('error', {
    type: 'error',
    error: 'TIMEOUT',
    message: 'Request timed out after 30 seconds'
  });
  res.end();
}, 30000); // 30 second timeout

// Clear on completion
clearTimeout(timeout);
```

---

## Performance Considerations

### **1. Connection Pooling**

- **Problem**: Too many open SSE connections
- **Solution**: Limit concurrent SSE streams per user
```typescript
const activeStreams = new Map<string, number>();

if ((activeStreams.get(userId) || 0) >= 5) {
  res.status(429).json({ error: 'TOO_MANY_CONCURRENT_STREAMS' });
  return;
}
```

### **2. Memory Management**

- **Problem**: Long-running SSE connections consume memory
- **Solution**: Set max execution time
```typescript
const MAX_EXECUTION_TIME = 60000; // 60 seconds
setTimeout(() => {
  sendSSE('error', { error: 'TIMEOUT', message: 'Max execution time exceeded' });
  res.end();
}, MAX_EXECUTION_TIME);
```

### **3. Bandwidth Optimization**

- **Problem**: Too many progress updates
- **Solution**: Throttle updates (max 10/second)
```typescript
let lastUpdate = 0;
const MIN_UPDATE_INTERVAL = 100; // 100ms

const throttledProgress = (update) => {
  const now = Date.now();
  if (now - lastUpdate >= MIN_UPDATE_INTERVAL) {
    sendSSE('progress', update);
    lastUpdate = now;
  }
};
```

---

## Testing Strategy

### **Unit Tests**

```typescript
describe('SSE Streaming', () => {
  it('should send progress updates in correct format', async () => {
    const updates = [];

    await processWithSSE(userId, query, (update) => {
      updates.push(update);
    });

    expect(updates[0].type).toBe('analyzing');
    expect(updates[updates.length - 1].type).toBe('completed');
  });

  it('should handle client disconnect gracefully', async () => {
    // Simulate disconnect mid-execution
    const mockReq = createMockRequest();
    mockReq.emit('close');

    // Verify cleanup
    expect(orchestrator.activeExecutions.size).toBe(0);
  });
});
```

### **Integration Tests**

```typescript
describe('SSE Integration', () => {
  it('should stream complete execution flow', (done) => {
    const eventSource = new EventSource('/api/voice/llm/stream');
    const events = [];

    eventSource.addEventListener('progress', (e) => {
      events.push(JSON.parse(e.data));
    });

    eventSource.addEventListener('done', (e) => {
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('analyzing');
      done();
    });
  });
});
```

---

## Production Deployment

### **Nginx Configuration**

```nginx
location /api/voice/llm/stream {
    proxy_pass http://backend:3001;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header X-Accel-Buffering no;
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;
}
```

### **Load Balancer Settings**

```yaml
# For AWS ALB or similar
connection_timeout: 300s  # Allow long SSE connections
idle_timeout: 120s
```

---

## Security Considerations

### **1. Authentication**

```typescript
// Verify JWT on every SSE connection
const token = req.headers.authorization?.split(' ')[1];
if (!token) {
  res.status(401).json({ error: 'UNAUTHORIZED' });
  return;
}

const user = verifyToken(token);
```

### **2. Rate Limiting**

```typescript
// Max 10 SSE requests per minute per user
const rateLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  standardHeaders: true
});

router.post('/llm/stream', rateLimiter, ...);
```

### **3. Input Validation**

```typescript
// Validate query length
if (!query || query.length > 500) {
  res.status(400).json({ error: 'INVALID_QUERY' });
  return;
}
```

---

## Monitoring & Observability

### **Metrics to Track**

```typescript
// Prometheus metrics
const sseConnectionsGauge = new Gauge({
  name: 'sse_active_connections',
  help: 'Number of active SSE connections'
});

const sseExecutionDuration = new Histogram({
  name: 'sse_execution_duration_seconds',
  help: 'SSE execution time',
  buckets: [0.1, 0.5, 1, 2, 5]
});

const sseErrorsCounter = new Counter({
  name: 'sse_errors_total',
  help: 'Total SSE errors'
});
```

### **Logging**

```typescript
logger.info('SSE connection opened', { userId, query });
logger.info('SSE progress update sent', { userId, type: update.type });
logger.info('SSE connection closed', { userId, duration, success });
```

---

## Success Criteria

✅ **SSE endpoint functional** - Accepts queries and streams updates
✅ **Real-time progress** - Updates sent <100ms after each step
✅ **Error handling** - Graceful degradation on failures
✅ **Connection cleanup** - No memory leaks from abandoned connections
✅ **Client compatibility** - Works with EventSource API
✅ **Performance** - <5% overhead vs non-streaming
✅ **Tests passing** - Unit + integration tests for SSE

---

## Implementation Checklist

- [ ] Create SSE endpoint in `routes/voice.ts`
- [ ] Modify `llmMCPOrchestrator.processQuery()` for streaming
- [ ] Add connection lifecycle management
- [ ] Implement error handling
- [ ] Add rate limiting
- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Test with frontend EventSource
- [ ] Load test (100+ concurrent streams)
- [ ] Documentation

---

**Status**: ✅ Design Complete → Ready for Implementation
