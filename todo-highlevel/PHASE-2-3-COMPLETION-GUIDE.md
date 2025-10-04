# Phase 2 & 3 Completion Guide

## ✅ What's Done (Phase 2 - 60% Complete)

### Backend
- ✅ Database: `conversation_turns` table created
- ✅ Service: `ConversationSessionManager` with full CRUD
- ✅ API Endpoints:
  - `POST /api/voice/session/start` - Start session
  - `POST /api/voice/session/:id/end` - End session
  - `GET /api/voice/session/active` - Get active session
  - `GET /api/voice/session/:id` - Get session with turns
- ✅ Natural TTS response generation (working!)

---

## 🚧 Remaining Steps

### **Step 1: Integrate Context into LLM Orchestrator** (15 min)

**File:** `backend/src/services/llm-mcp-orchestrator.ts`

**Modify `processQuery()` method to accept sessionId:**

```typescript
async processQuery(
  userId: string,
  query: string,
  options?: {
    streaming?: boolean;
    onProgress?: (update: ProgressUpdate) => void;
    sessionId?: string; // ADD THIS
  }
): Promise<OrchestrationResult> {
  //... existing code ...

  // ADD: Get conversation context if sessionId provided
  let conversationContext = '';
  if (options?.sessionId) {
    conversationContext = await conversationSessionManager.getContext(options.sessionId);
  }

  // MODIFY: Pass context to selectTools
  const executionPlan = await this.selectTools(query, toolRegistry, conversationContext);

  //... rest of method
}
```

**Modify `selectTools()` to use context:**

```typescript
private async selectTools(
  query: string,
  toolRegistry: ToolRegistry,
  conversationContext?: string // ADD THIS
): Promise<ExecutionPlan> {
  const systemPrompt = this.buildSystemPrompt(toolRegistry, conversationContext);
  // ... rest
}
```

**Update `buildSystemPrompt()` to include context:**

```typescript
private buildSystemPrompt(
  toolRegistry: ToolRegistry,
  conversationContext?: string
): string {
  const toolsJSON = JSON.stringify(toolRegistry, null, 2);

  let prompt = `You are an intelligent MCP tool orchestrator...`;

  // ADD: Include conversation context
  if (conversationContext) {
    prompt += `\n\nPrevious conversation:\n${conversationContext}\n\n`;
    prompt += `Use this context to understand follow-up questions like "yes", "no", "tell me more", etc.\n`;
  }

  prompt += `\nAvailable MCP Tools:\n${toolsJSON}...`;

  return prompt;
}
```

### **Step 2: Update SSE Streaming Endpoint** (10 min)

**File:** `backend/src/routes/voice.ts`

**Modify `/llm/stream` endpoint:**

```typescript
router.post('/llm/stream', authenticateToken, async (req: Request, res: Response) => {
  const { query, sessionId } = req.body; // ADD sessionId
  const userId = req.user!.userId;

  // ... SSE setup ...

  try {
    // Process with session context
    const result = await llmMCPOrchestrator.processQuery(userId, query, {
      streaming: true,
      sessionId, // PASS sessionId
      onProgress: (update) => {
        if (!connectionClosed) {
          sendSSE('progress', {...});
        }
      }
    });

    // ADD: Save conversation turn if sessionId provided
    if (sessionId && result.success) {
      const assistantResponse = await naturalResponseGenerator.generateTTSResponse(
        query,
        result.results || [],
        { conversationContext: await conversationSessionManager.getContext(sessionId) }
      );

      await conversationSessionManager.addTurn(sessionId, {
        userQuery: query,
        assistantResponse,
        toolResults: result.results,
        ttsSpoken: true
      });
    }

    // Send done event...
  }
});
```

---

## 🎤 **Phase 3: VAD & Continuous Microphone** (1.5 hours)

### **Step 3: Install VAD Library** (5 min)

```bash
cd frontend
npm install @ricky0123/vad-web
```

### **Step 4: Create VAD Hook** (30 min)

**File:** `frontend/hooks/useVAD.ts`

```typescript
import { useState, useEffect, useRef } from 'react';
import { MicVAD } from '@ricky0123/vad-web';

export function useVAD(options: {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onVADMisfire?: () => void;
  enabled?: boolean;
}) {
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const vadRef = useRef<MicVAD | null>(null);

  useEffect(() => {
    if (!options.enabled) return;

    let mounted = true;

    (async () => {
      try {
        const vad = await MicVAD.new({
          onSpeechStart: () => {
            console.log('🎤 Speech detected');
            setIsListening(true);
            options.onSpeechStart?.();
          },
          onSpeechEnd: (audio: Float32Array) => {
            console.log('🔇 Speech ended');
            setIsListening(false);
            options.onSpeechEnd?.(audio);
          },
          onVADMisfire: () => {
            console.log('⚠️ VAD misfire');
            options.onVADMisfire?.();
          },
          positiveSpeechThreshold: 0.6,
          negativeSpeechThreshold: 0.5,
          minSpeechFrames: 3,
          redemptionFrames: 8
        });

        if (mounted) {
          vadRef.current = vad;
          vad.start();
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Failed to initialize VAD:', error);
        setIsLoading(false);
      }
    })();

    return () => {
      mounted = false;
      vadRef.current?.pause();
    };
  }, [options.enabled]);

  const pause = () => vadRef.current?.pause();
  const start = () => vadRef.current?.start();

  return { isListening, isLoading, pause, start };
}
```

### **Step 5: Update VoiceInterface Component** (30 min)

**File:** `frontend/components/VoiceInterface.tsx`

```typescript
import { useVAD } from '@/hooks/useVAD';

export function VoiceInterface() {
  const [mode, setMode] = useState<'continuous' | 'push_to_talk'>('continuous');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<any[]>([]);

  // Initialize session on component mount
  useEffect(() => {
    startSession();
  }, []);

  const startSession = async () => {
    const response = await fetch('/api/voice/session/start', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ mode })
    });

    const data = await response.json();
    setSessionId(data.session.id);
    setConversationHistory(data.session.turns || []);
  };

  const endSession = async () => {
    if (!sessionId) return;

    await fetch(`/api/voice/session/${sessionId}/end`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    setSessionId(null);
    setConversationHistory([]);
  };

  // VAD for continuous mode
  const { isListening, isLoading } = useVAD({
    enabled: mode === 'continuous' && !!sessionId,
    onSpeechStart: () => {
      setIsListening(true);
    },
    onSpeechEnd: async (audioFloat32) => {
      setIsListening(false);
      setIsProcessing(true);

      // Convert Float32Array to WAV
      const audioBlob = float32ToWav(audioFloat32, 16000);

      // Send to STT (using existing speech API or direct Whisper API)
      const transcript = await speechAPI.transcribeAudio(audioBlob);

      // Process command with session context
      await voice.streamCommand(transcript, {
        sessionId, // IMPORTANT: Pass sessionId for context
        onProgress: (update) => {
          setProgressUpdates(prev => [...prev, update]);
        },
        onResult: async (result) => {
          // Generate natural TTS with context
          const ttsResponse = await voice.generateNaturalResponse(
            transcript,
            result.results,
            { conversationContext: /* get from session */ }
          );

          // Add to conversation history
          setConversationHistory(prev => [...prev, {
            userQuery: transcript,
            assistantResponse: ttsResponse
          }]);

          // Speak response
          await speechAPI.speak(ttsResponse);

          setIsProcessing(false);
          // VAD automatically listening again!
        }
      });
    }
  });

  // Mode toggle UI
  return (
    <div>
      {/* Mode Toggle */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setMode('continuous')}
          className={`px-4 py-2 rounded ${mode === 'continuous' ? 'bg-indigo-600 text-white' : 'bg-gray-200'}`}
        >
          🎙️ Continuous
        </button>
        <button
          onClick={() => setMode('push_to_talk')}
          className={`px-4 py-2 rounded ${mode === 'push_to_talk' ? 'bg-indigo-600 text-white' : 'bg-gray-200'}`}
        >
          🔘 Push to Talk
        </button>
      </div>

      {/* VAD Status */}
      {mode === 'continuous' && (
        <div className={`p-4 rounded ${isListening ? 'bg-green-100' : 'bg-gray-100'}`}>
          {isLoading ? '⏳ Loading VAD...' : isListening ? '🎤 Listening...' : '👂 Ready to listen'}
        </div>
      )}

      {/* Conversation History */}
      <div className="mt-4 space-y-2">
        {conversationHistory.map((turn, idx) => (
          <div key={idx} className="border rounded p-3">
            <div className="text-sm text-gray-600">You: {turn.userQuery}</div>
            <div className="text-sm text-indigo-600">AI: {turn.assistantResponse}</div>
          </div>
        ))}
      </div>

      {/* Existing mic button for push-to-talk mode */}
      {mode === 'push_to_talk' && (
        <button onClick={handleMicClick}>
          {/* ... existing button */}
        </button>
      )}

      {/* End Session Button */}
      <button onClick={endSession} className="mt-4 px-4 py-2 bg-red-500 text-white rounded">
        End Conversation
      </button>
    </div>
  );
}
```

### **Step 6: Float32 to WAV Conversion** (10 min)

**File:** `frontend/utils/audio.ts`

```typescript
export function float32ToWav(float32Array: Float32Array, sampleRate: number = 16000): Blob {
  const buffer = new ArrayBuffer(44 + float32Array.length * 2);
  const view = new DataView(buffer);

  // WAV header
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + float32Array.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Format chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, float32Array.length * 2, true);

  // Convert float32 to int16
  let offset = 44;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([view], { type: 'audio/wav' });
}
```

---

## 🎯 **Testing Steps**

### Test Phase 2 (Session & Context)
1. Start session: `POST /api/voice/session/start`
2. First command: "List my meetings"
3. Second command: "Yes, tell me about the first one" (uses context!)
4. Check: AI should understand "first one" refers to previous response

### Test Phase 3 (VAD)
1. Toggle to "Continuous" mode
2. Start speaking naturally
3. VAD detects speech automatically
4. AI responds and microphone re-opens
5. Continue conversation without clicking

---

## 📊 Success Metrics

- ✅ Multi-turn conversations work (context remembered)
- ✅ "Yes", "No", "Tell me more" understood correctly
- ✅ VAD detects speech within 100ms
- ✅ Microphone auto-reopens after AI response
- ✅ Conversation history displayed
- ✅ Mode toggle works (continuous ↔ push-to-talk)

---

## 🔧 Quick Implementation Commands

```bash
# Terminal 1: Backend (already running)
cd backend && npm run dev

# Terminal 2: Frontend
cd frontend && npm install @ricky0123/vad-web
npm run dev

# Terminal 3: Test session API
curl -X POST http://localhost:3001/api/voice/session/start \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "continuous"}'
```

---

**Status**: Phase 2 (60% complete) → Finish integration → Phase 3 (1.5 hours) → DONE! 🚀
