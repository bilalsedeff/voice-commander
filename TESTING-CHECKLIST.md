# Manual Testing Checklist: OAuth + MCP Flow

## Prerequisites

- ✅ Backend server running on port 3001
- ✅ Frontend server running on port 3000
- ✅ PostgreSQL database connected
- ⚠️ OAuth credentials configured in `.env` (Google, Slack, GitHub, Notion)
- ⚠️ MCP server endpoints configured (or mock endpoints ready)

## Test Flow

### 1. User Authentication

- [ ] **Register new user**
  - POST `http://localhost:3001/api/auth/register`
  - Payload: `{ "email": "test@example.com", "password": "Test123!" }`
  - Expected: `200 OK` with `{ "user": {...}, "accessToken": "...", "refreshToken": "..." }`

- [ ] **Login user**
  - POST `http://localhost:3001/api/auth/login`
  - Payload: `{ "email": "test@example.com", "password": "Test123!" }`
  - Expected: `200 OK` with tokens

### 2. OAuth Connection Flow

#### Google Calendar

- [ ] **Initiate OAuth**
  - GET `http://localhost:3001/api/oauth/google`
  - Expected: Redirect to Google OAuth consent screen

- [ ] **OAuth Callback**
  - After authorization, should redirect to `http://localhost:3000/dashboard?success=true&provider=google`
  - Backend should:
    - Store encrypted OAuth tokens in database
    - Mark `serviceConnection.connected = true`
    - Automatically initialize MCP connection

- [ ] **Verify OAuth Status**
  - GET `http://localhost:3001/api/oauth/connections` (with auth token)
  - Expected:

    ```json
    {
      "connections": [{
        "provider": "google",
        "connected": true,
        "mcpConnected": true,
        "mcpStatus": "connected",
        "mcpToolsCount": > 0
      }]
    }
    ```

#### Slack, GitHub, Notion (Optional)

- [ ] Repeat OAuth flow for additional services
- [ ] Verify each service shows `connected: true` and `mcpConnected: true`

### 3. MCP Connection Verification

- [ ] **Check MCP Status**
  - Verify database `serviceConnection` table shows:
    - `mcpConnected = true`
    - `mcpStatus = 'connected'`
    - `mcpToolsCount > 0`
    - `mcpLastHealthCheck` is recent
    - `mcpSessionId` is populated (for HTTP+SSE transport)

- [ ] **Health Check Monitoring**
  - Wait 30 seconds (health check interval)
  - Verify `mcpLastHealthCheck` is updated
  - Check logs for `"MCP health check passed"` messages

- [ ] **Service Capabilities**
  - GET `http://localhost:3001/api/voice/capabilities` (with auth token)
  - Expected: List of connected services with available tools

    ```json
    {
      "success": true,
      "connectedServices": ["google_calendar"],
      "capabilities": {
        "google_calendar": {
          "tools": [...],
          "description": "Google Calendar integration for scheduling and events"
        }
      }
    }
    ```

### 4. Voice Command Execution

- [ ] **Execute Simple Command**
  - POST `http://localhost:3001/api/voice/command`
  - Headers: `Authorization: Bearer <token>`
  - Payload: `{ "voiceText": "show my calendar" }`
  - Expected: `200 OK` with command execution result

- [ ] **Execute Chained Command**
  - POST `http://localhost:3001/api/voice/command`
  - Payload: `{ "voiceText": "schedule a meeting tomorrow at 3pm and then show my calendar" }`
  - Expected: Sequential execution of both commands with results

- [ ] **Risk Assessment**
  - POST `http://localhost:3001/api/voice/command`
  - Payload: `{ "voiceText": "delete my calendar" }` (high risk)
  - Expected: `CONFIRMATION_REQUIRED` response with confirmationId

### 5. Error Scenarios

- [ ] **MCP Connection Failure**
  - Manually stop MCP server (if testing with real endpoint)
  - Execute voice command
  - Expected: Graceful error with `"MCP not connected for ${provider}"`
  - Verify auto-reconnection after 1 second (exponential backoff)

- [ ] **Session Expiration**
  - Simulate session expiration (mock 404 error from MCP server)
  - Expected: Automatic disconnect and reconnect
  - Check logs for `"MCP session expired, reinitializing"`

- [ ] **OAuth Disconnection**
  - POST `http://localhost:3001/api/oauth/disconnect/google` (with auth token)
  - Expected:
    - `serviceConnection.connected = false`
    - `serviceConnection.mcpConnected = false`
    - MCP connection terminated

### 6. Database Verification

Check `serviceConnection` table for correct state after each test:

```sql
SELECT
  userId,
  provider,
  connected,
  mcpConnected,
  mcpStatus,
  mcpToolsCount,
  mcpError,
  mcpSessionId,
  mcpLastHealthCheck
FROM "ServiceConnection"
WHERE userId = '<test-user-id>';
```

Expected fields:

- `connected`: true after OAuth
- `mcpConnected`: true after auto-connect
- `mcpStatus`: 'connected', 'connecting', 'error', or 'disconnected'
- `mcpToolsCount`: Number of available tools (> 0 when connected)
- `mcpError`: null when healthy
- `mcpSessionId`: Populated for HTTP+SSE connections
- `mcpLastHealthCheck`: Updated every 30 seconds

### 7. Logs to Monitor

Check backend logs for these key events:

**OAuth Flow:**

```plaintext
info: Handling OAuth callback { provider: 'google' }
info: OAuth tokens received and stored { userId: '...', provider: 'google' }
info: Auto-connecting MCP after OAuth success { userId: '...', provider: 'google' }
```

**MCP Connection:**

```plaintext
info: Initializing MCP connection { userId: '...', provider: 'google' }
info: MCP tools discovered { userId: '...', provider: 'google', toolsCount: 5, transport: 'http-sse' }
info: MCP connection established { userId: '...', provider: 'google', transport: 'http-sse', toolsCount: 5 }
```

**Voice Command:**

```plaintext
info: Processing voice command { userId: '...', voiceText: 'show my calendar' }
info: Mapping voice command { voiceText: 'show my calendar', connectedServices: ['google_calendar'] }
info: Command mapped successfully { service: 'google_calendar', action: 'list_events', riskLevel: 'SAFE' }
info: Command executed successfully { userId: '...', provider: 'google', service: 'google_calendar', action: 'list_events' }
```

**Health Checks:**

```plaintext
info: MCP health check passed { userId: '...', provider: 'google', transport: 'http-sse' }
```

## Success Criteria

✅ **Complete Success** if all of these are true:

1. OAuth authorization completes successfully
2. MCP connection automatically initializes after OAuth
3. `serviceConnection` database shows correct status
4. Voice commands execute successfully
5. Health checks run every 30 seconds
6. Automatic reconnection works after failures
7. Multi-service chains execute in order
8. Risk assessment triggers confirmations correctly

## Notes

- **Mock Testing**: If real OAuth/MCP endpoints are not available, create mock servers that return expected responses
- **Frontend Testing**: Use frontend dashboard at `http://localhost:3000/dashboard` for visual testing
- **API Testing**: Use Postman, Insomnia, or curl for direct API testing
- **Database**: Use Prisma Studio (`npx prisma studio`) to inspect database state

## Current Implementation Status

✅ Implemented:

- OAuth authorization flow (Google, Slack, GitHub, Notion)
- Auto-connect MCP after OAuth
- MCP Connection Manager V2 with HTTP+SSE support
- Health monitoring with 30s interval
- Automatic reconnection with exponential backoff
- Session expiration detection and reinitialization
- Voice orchestrator with multi-service support
- Command mapper with chain detection
- Risk assessment system

✅ Tests Passing: 57/57

- 15 LLM Clarifier tests
- 14 Conversation Manager tests
- 16 MCP HTTP Client tests
- 12 MCP Connection Manager V2 tests

⚠️ Requires Manual Validation:

- Real OAuth credentials and authorization flow
- Real MCP server endpoints (or mocks)
- End-to-end voice command execution
- Frontend dashboard integration
