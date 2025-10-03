# 🎙️ Conversational Voice Architecture - Real-time Session-based AI Assistant

**Vision**: Transform one-shot voice commands into continuous, context-aware conversations with short-term memory, VAD, and natural follow-up questions.

---

## 🎯 **Goal**

Create a **ChatGPT-like voice experience** where:
- Microphone stays open (VAD detects when user stops speaking)
- AI remembers conversation context (short-term memory)
- Natural follow-up questions ("Would you like to reschedule?", "Anything else I can help with?")
- Real-time streaming responses
- Session-based conversations (not one-shot)

---

## 📊 **Current vs Desired Architecture**

### **Current (One-shot)**
```
User clicks mic → Speaks → Stops → Processing → Response → TTS → DONE
                                                                    ↓
                                                              (Session ends)
```

**Problems:**
- ❌ No conversation context
- ❌ Microphone closes after each turn
- ❌ No follow-up questions
- ❌ Robotic template responses
- ❌ User must click mic for each command

---

### **Desired (Conversational)**
```
[Session Start]
    ↓
User speaks → VAD detects silence → STT
    ↓
LLM (with context from last 3-5 turns)
    ↓
Selects tools + Generates natural response
    ↓
Execute tools → Stream results
    ↓
LLM creates conversational TTS ("I found 1 event called 'deneme mcp'
                                  tomorrow at midnight. Would you like details?")
    ↓
TTS plays → Microphone AUTO-REOPENS → VAD listens
    ↓
User: "Yes, tell me more"
    ↓
LLM (remembers context) → Provides details
    ↓
Loop continues until user says "exit" or timeout
```

**Benefits:**
- ✅ Natural conversation flow
- ✅ Context awareness
- ✅ Hands-free (no clicking)
- ✅ Intelligent follow-ups
- ✅ Human-like interaction

---

## 🏗️ **3-Phase Implementation Plan**

### **Phase 1: Natural TTS Responses** (Today - 1 hour)
**Goal**: Replace template responses with LLM-generated natural language

**Changes:**
1. Add `/api/voice/generate-response` endpoint
2. LLM creates spoken response from tool results
3. Frontend calls this before TTS

**Example:**
```typescript
// Before:
TTS: "📅 Found 1 upcoming event"

// After (LLM-generated):
TTS: "I found one event called 'deneme mcp' scheduled for tomorrow at midnight.
      Would you like to hear more details or make any changes?"
```

**Files to modify:**
- `backend/src/routes/voice.ts` - New endpoint
- `frontend/components/VoiceInterface.tsx` - Call before TTS
- `backend/src/services/llm-service.ts` - New prompt template

**Effort**: 1 hour
**Impact**: Immediate UX improvement

---

### **Phase 2: Session Context & Memory** (Next session - 2-3 hours)
**Goal**: Add conversation memory and follow-up awareness

**Database Schema:**
```sql
CREATE TABLE voice_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  started_at TIMESTAMP DEFAULT NOW(),
  last_interaction TIMESTAMP,
  status VARCHAR(20), -- 'active', 'completed', 'timeout'
  turns JSONB -- Array of conversation turns
);

CREATE TABLE conversation_turns (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES voice_sessions(id),
  turn_number INTEGER,
  user_query TEXT,
  tool_results JSONB,
  assistant_response TEXT,
  timestamp TIMESTAMP DEFAULT NOW()
);
```

**Backend Changes:**
1. Create `ConversationManager` service
2. Store last 3-5 turns in session
3. Pass context to LLM in system prompt
4. Detect follow-up intent ("yes", "no", "tell me more")

**Frontend Changes:**
1. Session ID tracking
2. Display conversation history
3. Visual indicator for "listening mode"

**Example:**
```
Turn 1:
User: "List my meetings"
AI: "I found 1 event tomorrow. Want details?"

Turn 2 (with context):
User: "Yes"
AI: (remembers previous context) "The event is 'deneme mcp' at midnight..."
```

**Effort**: 2-3 hours
**Impact**: Major UX leap - feels like ChatGPT

---

### **Phase 3: VAD & Continuous Microphone** (Future - 4-5 hours)
**Goal**: Hands-free operation with automatic speech detection

**Technology Options:**

#### **Option A: Browser-based VAD** ⭐ Recommended
- **Library**: `@ricky0123/vad-web` (WebAssembly VAD)
- **Pros**: No server needed, low latency, privacy-friendly
- **Cons**: Runs on client (battery usage)

```typescript
import { MicVAD } from "@ricky0123/vad-web";

const vad = await MicVAD.new({
  onSpeechStart: () => {
    console.log("User started speaking");
    startRecording();
  },
  onSpeechEnd: (audio) => {
    console.log("User stopped speaking");
    sendToSTT(audio);
  },
  onVADMisfire: () => {
    console.log("False positive - ignore");
  }
});

vad.start();
```

#### **Option B: Server-side VAD**
- **Library**: `webrtcvad` (Python) or `node-vad` (Node.js)
- **Pros**: Offloads client processing
- **Cons**: Higher latency, network overhead

**Implementation:**
1. Microphone permission persists across turns
2. VAD runs continuously
3. Speech detected → Auto-process
4. Response played → Auto-reopen mic
5. Timeout after 60s of silence → End session

**Frontend Changes:**
```typescript
const [isSessionActive, setIsSessionActive] = useState(false);
const [vadStatus, setVADStatus] = useState<'idle' | 'listening' | 'speaking'>('idle');

// Start continuous session
const startVoiceSession = async () => {
  setIsSessionActive(true);

  const vad = await MicVAD.new({
    onSpeechStart: () => setVADStatus('speaking'),
    onSpeechEnd: async (audio) => {
      setVADStatus('idle');
      const transcript = await processAudio(audio);
      await handleCommand(transcript);
      // Mic automatically reopens!
    }
  });

  vad.start();
};
```

**Effort**: 4-5 hours
**Impact**: ChatGPT Voice Mode experience

---

## 🧩 **Technical Components**

### **1. Session Manager Service**
```typescript
class ConversationSessionManager {
  private sessions = new Map<string, VoiceSession>();

  createSession(userId: string): VoiceSession {
    const session = {
      id: uuidv4(),
      userId,
      turns: [],
      startedAt: Date.now(),
      status: 'active'
    };
    this.sessions.set(session.id, session);
    return session;
  }

  addTurn(sessionId: string, turn: ConversationTurn) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    session.turns.push(turn);

    // Keep only last 5 turns for context
    if (session.turns.length > 5) {
      session.turns = session.turns.slice(-5);
    }
  }

  getContext(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return '';

    return session.turns
      .map(t => `User: ${t.query}\nAssistant: ${t.response}`)
      .join('\n\n');
  }
}
```

### **2. Natural Response Generator**
```typescript
class NaturalResponseGenerator {
  async generateTTSResponse(
    originalQuery: string,
    toolResults: ToolResult[],
    conversationContext?: string
  ): Promise<string> {
    const prompt = `
You are a helpful voice assistant. Generate a natural, conversational spoken response.

${conversationContext ? `Conversation so far:\n${conversationContext}\n\n` : ''}

User asked: "${originalQuery}"

Tool execution results:
${JSON.stringify(toolResults, null, 2)}

Generate a SHORT (1-2 sentences), natural spoken response that:
1. Summarizes what was done
2. Highlights key information
3. Asks a relevant follow-up question if appropriate
4. Uses conversational language (like you're talking to a friend)

IMPORTANT:
- Keep it under 30 words
- Don't use emojis
- Sound natural and human-like
- Ask follow-up questions to keep conversation going

Response:`;

    const response = await llmService.execute({
      systemPrompt: "You are a conversational voice assistant. Be concise and natural.",
      userPrompt: prompt,
      taskType: LLMTaskType.FAST
    });

    return response.content.trim();
  }
}
```

### **3. Frontend VAD Integration**
```typescript
// VoiceInterface.tsx
const [sessionId, setSessionId] = useState<string | null>(null);
const [vadInstance, setVADInstance] = useState<MicVAD | null>(null);

const startConversationSession = async () => {
  // Create backend session
  const session = await fetch('/api/voice/session/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }).then(r => r.json());

  setSessionId(session.sessionId);

  // Initialize VAD
  const vad = await MicVAD.new({
    onSpeechStart: () => {
      setIsListening(true);
      setInterimTranscript('Listening...');
    },

    onSpeechEnd: async (audioData: Float32Array) => {
      setIsListening(false);
      setIsProcessing(true);

      // Convert to WAV and send to backend
      const audioBlob = float32ToWav(audioData);

      // Process with session context
      await voice.streamCommandWithContext(audioBlob, session.sessionId, {
        onProgress: (update) => setProgressUpdates(prev => [...prev, update]),
        onResult: async (result) => {
          // Get natural TTS response
          const ttsText = await voice.generateNaturalResponse(
            session.sessionId,
            result
          );

          setResponse(ttsText);

          // Speak and auto-reopen mic
          await speechAPI.speak(ttsText);
          setIsProcessing(false);
          // VAD automatically listening again!
        }
      });
    },

    onVADMisfire: () => {
      console.log('VAD misfire - ignoring');
    }
  });

  vad.start();
  setVADInstance(vad);
};

const endConversationSession = () => {
  vadInstance?.pause();
  fetch(`/api/voice/session/${sessionId}/end`, { method: 'POST' });
  setSessionId(null);
  setVADInstance(null);
};
```

---

## 🔧 **Backend API Endpoints**

### **POST /api/voice/session/start**
Create new conversation session
```json
Response: {
  "sessionId": "uuid",
  "status": "active",
  "expiresAt": "timestamp"
}
```

### **POST /api/voice/session/:id/turn**
Add turn with context
```json
Request: {
  "query": "List my meetings",
  "audioData": "base64..."
}

Response: SSE stream with progress + natural response
```

### **POST /api/voice/generate-response**
Generate natural TTS response
```json
Request: {
  "sessionId": "uuid",
  "originalQuery": "List my meetings",
  "toolResults": [...]
}

Response: {
  "spokenResponse": "I found one event tomorrow at midnight. Want to hear details?"
}
```

### **POST /api/voice/session/:id/end**
End conversation session

---

## 📋 **Implementation Checklist**

### Phase 1: Natural TTS (Today)
- [ ] Create `NaturalResponseGenerator` service
- [ ] Add `/api/voice/generate-response` endpoint
- [ ] Modify frontend to call before TTS
- [ ] Test with different tool results
- [ ] Fine-tune LLM prompts for concise responses

### Phase 2: Session & Memory (Next)
- [ ] Add `voice_sessions` table
- [ ] Create `ConversationSessionManager`
- [ ] Implement context passing to LLM
- [ ] Add follow-up intent detection
- [ ] Frontend session tracking
- [ ] Conversation history display

### Phase 3: VAD Integration (Future)
- [ ] Research VAD libraries (`@ricky0123/vad-web`)
- [ ] Implement continuous microphone
- [ ] Add VAD event handlers
- [ ] Auto-reopen mic after TTS
- [ ] Session timeout handling
- [ ] Battery/performance optimization

---

## 🎨 **UX Mockup**

```
┌─────────────────────────────────────┐
│  🎤 Voice Session (Active)          │
│  ───────────────────────────────    │
│                                     │
│  [●] Listening...                   │
│                                     │
│  Conversation:                      │
│  ─────────────────────────────      │
│                                     │
│  You: List my meetings              │
│  AI: I found 1 event tomorrow at    │
│      midnight called "deneme mcp".  │
│      Want to hear details?          │
│                                     │
│  You: Yes                           │
│  AI: It's scheduled from midnight   │
│      to 12:30 AM. Would you like    │
│      to reschedule it?              │
│                                     │
│  [End Session]                      │
└─────────────────────────────────────┘
```

---

## ⚡ **Performance Targets**

- **VAD Latency**: <100ms to detect speech end
- **STT Latency**: <500ms (OpenAI Whisper)
- **LLM Response**: <1s (GPT-4.1-nano)
- **TTS Latency**: <500ms
- **Total Turn Time**: <3s (user stops talking → AI starts speaking)
- **Session Timeout**: 60s of silence → auto-end

---

## 🔐 **Security Considerations**

1. **Session Limits**: Max 10 active sessions per user
2. **Turn Limits**: Max 50 turns per session (prevent abuse)
3. **Audio Size**: Max 10MB per audio chunk
4. **Rate Limiting**: Max 1 turn per 2 seconds
5. **Session Expiry**: Auto-expire after 15 minutes
6. **Context Sanitization**: Sanitize conversation history before LLM

---

## 📊 **Success Metrics**

- ✅ Average turns per session: >3 (multi-turn conversations)
- ✅ User satisfaction: "Feels natural" rating >4/5
- ✅ Follow-up question accuracy: >80%
- ✅ VAD false positive rate: <5%
- ✅ Session completion rate: >70%

---

## 🚀 **Next Steps**

1. **Today**: Implement Phase 1 (Natural TTS responses)
2. **This week**: Design Phase 2 database schema
3. **Next week**: Implement session management
4. **Month 2**: VAD integration and continuous microphone

---

**Status**: 📝 Design Complete - Ready for Phase 1 Implementation
**Estimated Total Effort**: 8-10 hours across 3 phases
**Expected Impact**: Transform from "voice commands" to "voice conversations"
