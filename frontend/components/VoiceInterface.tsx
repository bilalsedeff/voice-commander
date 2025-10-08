'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Loader2, Volume2, AlertCircle, CheckCircle, Radio } from 'lucide-react';
import { SpeechAPI } from '@/lib/speech-api';
import { voice } from '@/lib/api';
import { useVAD } from '@/hooks/useVAD';

interface VoiceInterfaceProps {
  onCommandExecuted?: (command: string, result: unknown) => void;
}

interface ProgressUpdate {
  step: string;
  message: string;
  timestamp: string;
  data?: unknown;
}

export default function VoiceInterface({ onCommandExecuted }: VoiceInterfaceProps) {
  const [speechAPI, setSpeechAPI] = useState<SpeechAPI | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [isSupported, setIsSupported] = useState(true);

  // Mode and Session Management
  const [mode, setMode] = useState<'continuous' | 'push_to_talk'>('push_to_talk'); // Default to PTT to avoid VAD errors
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [hasProcessedCommand, setHasProcessedCommand] = useState(false); // Track if at least one command processed
  const [isPausedByUser, setIsPausedByUser] = useState(false); // Track manual pause in continuous mode
  const sessionIdRef = useRef<string | null>(null); // Ref for cleanup

  // SSE Progress tracking
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  const [currentStep, setCurrentStep] = useState<string>('');

  // Conversation history
  const [conversationHistory, setConversationHistory] = useState<Array<{
    role: 'user' | 'assistant';
    message: string;
    timestamp: Date;
  }>>([]);

  // Voice wave visualization
  const [audioLevel, setAudioLevel] = useState(0);
  const audioLevelRef = useRef(0);

  useEffect(() => {
    // Check browser support
    if (!SpeechAPI.isSupported()) {
      setIsSupported(false);
      setError('Voice commands are not supported in this browser. Please use Chrome, Edge, or Safari.');
      return;
    }

    // Initialize Speech API
    try {
      const api = new SpeechAPI();
      setSpeechAPI(api);
    } catch (err) {
      console.error('Failed to initialize Speech API:', err);
      setError('Failed to initialize voice recognition. Please reload the page.');
    }
  }, []);

  // Simulate audio level animation while listening
  useEffect(() => {
    if (isListening) {
      const interval = setInterval(() => {
        audioLevelRef.current = Math.random();
        setAudioLevel(audioLevelRef.current);
      }, 100);
      return () => clearInterval(interval);
    } else {
      setAudioLevel(0);
    }
  }, [isListening]);

  // Session Management: Start session when mode changes to continuous
  useEffect(() => {
    const initSession = async () => {
      if (mode === 'continuous' && !sessionId) {
        try {
          const result = await voice.startSession('continuous');
          setSessionId(result.session.id);
          setIsSessionActive(true);
          sessionIdRef.current = result.session.id; // Keep ref updated
          console.log('✅ Session started:', result.session.id);
        } catch (error) {
          console.error('Failed to start session:', error);
        }
      }
    };

    initSession();
  }, [mode, sessionId]);

  // End session when switching from continuous to PTT
  useEffect(() => {
    if (mode === 'push_to_talk' && sessionId && isSessionActive) {
      console.log('🔚 Ending session - switched to PTT mode');
      voice.endSession(sessionId, 'completed').catch(console.error);
      setSessionId(null);
      setIsSessionActive(false);
      sessionIdRef.current = null;
    }
  }, [mode, sessionId, isSessionActive]);

  // Cleanup session on component unmount only
  useEffect(() => {
    return () => {
      if (sessionIdRef.current) {
        console.log('🔚 Ending session - component unmount');
        voice.endSession(sessionIdRef.current, 'completed').catch(console.error);
      }
    };
  }, []); // Empty deps - only runs on unmount

  // Process voice command (shared function for both PTT and VAD modes)
  const processVoiceCommand = useCallback(async (commandText: string) => {
    if (!speechAPI) return;

    setTranscript(commandText);
    setIsProcessing(true);
    setProgressUpdates([]);
    setCurrentStep('Starting...');

    try {
      let finalResult: unknown = null;
      let finalMessage = '';

      await voice.streamCommand(commandText, {
        onProgress: (update) => {
          console.log('📊 Progress:', update);
          setProgressUpdates(prev => [...prev, update]);
          setCurrentStep(update.message);
        },

        onResult: async (result) => {
          console.log('✅ Result:', result);
          finalResult = result;

          // Extract display message and prepare for natural TTS
          let displayMessage = '';
          let ttsMessage = '';

          if (result && typeof result === 'object') {
            const resultData = result as {
              success?: boolean;
              results?: Array<{ success: boolean; tool: string; service: string; data?: unknown; error?: string }>;
              message?: string;
              needsClarification?: boolean;
              clarificationQuestion?: string;
            };

            // Check if clarification is needed
            if (resultData.needsClarification && resultData.clarificationQuestion) {
              displayMessage = `❓ ${resultData.clarificationQuestion}`;
              ttsMessage = resultData.clarificationQuestion;
              finalMessage = ttsMessage;
              setResponse(displayMessage);
              setCurrentStep('Needs clarification');

              // Add to conversation history
              setConversationHistory(prev => [
                ...prev,
                { role: 'user', message: commandText, timestamp: new Date() },
                { role: 'assistant', message: displayMessage, timestamp: new Date() }
              ]);
              return; // Exit early - don't process as normal result
            }

            // If results array exists (from LLM orchestrator)
            if (resultData.results && Array.isArray(resultData.results) && resultData.results.length > 0) {
              const firstResult = resultData.results[0];

              // Check if conversational (no tools executed)
              const isConversational = firstResult.service === 'conversational';

              if (isConversational) {
                // Conversational response - backend already generated it
                const conversationalData = firstResult.data as { query: string; response: string; type: string };
                ttsMessage = conversationalData.response;
                displayMessage = `💬 ${conversationalData.response}`;
              } else {
                // Tool execution - generate natural TTS response
                try {
                  console.log('🤖 Generating natural TTS response...');
                  ttsMessage = await voice.generateNaturalResponse(
                    commandText,
                    resultData.results,
                    { keepShort: false, askFollowUp: true }
                  );
                  console.log('✅ Natural TTS response:', ttsMessage);
                } catch (error) {
                  console.warn('Failed to generate natural response, using fallback', error);
                  // Fallback to template-based response
                  if (firstResult.success && firstResult.data && 'count' in (firstResult.data as Record<string, unknown>)) {
                    const count = (firstResult.data as { count: number }).count;
                    ttsMessage = count > 0
                      ? `Found ${count} upcoming event${count > 1 ? 's' : ''}`
                      : 'No upcoming meetings found';
                  } else {
                    ttsMessage = firstResult.success ? 'Done' : 'Command failed';
                  }
                }

                // Display message (shorter for UI)
                if (firstResult.success && firstResult.data && 'count' in (firstResult.data as Record<string, unknown>)) {
                  const count = (firstResult.data as { count: number }).count;
                  displayMessage = count > 0
                    ? `📅 Found ${count} upcoming event${count > 1 ? 's' : ''}`
                    : '📅 No upcoming meetings found';
                } else {
                  displayMessage = firstResult.success ? '✅ Command executed successfully' : `❌ ${firstResult.tool} failed`;
                }
              }
            } else if (resultData.message) {
              displayMessage = resultData.message;
              ttsMessage = resultData.message;
            } else {
              displayMessage = resultData.success ? '✅ Command executed successfully' : '❌ Command failed';
              ttsMessage = resultData.success ? 'Done' : 'Command failed';
            }
          }

          finalMessage = ttsMessage || displayMessage; // TTS uses natural message
          setResponse(displayMessage); // UI shows concise message
          setCurrentStep('Completed');

          // Add to conversation history
          setConversationHistory(prev => [
            ...prev,
            { role: 'user', message: commandText, timestamp: new Date() },
            { role: 'assistant', message: displayMessage, timestamp: new Date() }
          ]);
        },

        onError: (errorData) => {
          console.error('❌ Error:', errorData);
          const errorMsg = errorData.message || 'Something went wrong';
          setError(errorMsg);
          setResponse(errorMsg);
          setCurrentStep('Error');

          // Try to speak error (optional)
          if (speechAPI) {
            setIsSpeaking(true);
            speechAPI.speak(`Error: ${errorMsg}`, {
              lang: 'en-US',
              onEnd: () => {
                setIsSpeaking(false);
                // Resume listening after error in continuous mode
                if (mode === 'continuous' && !isPausedByUser) {
                  console.log('🎤 Resuming continuous listening after SSE error TTS...');
                  setTimeout(() => {
                    if (!isProcessing && !isPausedByUser) {
                      startListening();
                    }
                  }, 500);
                }
              },
              onError: () => {
                setIsSpeaking(false);
                // Resume listening even if error TTS fails
                if (mode === 'continuous' && !isPausedByUser) {
                  console.log('🎤 Resuming continuous listening after SSE error TTS failure...');
                  setTimeout(() => {
                    if (!isProcessing && !isPausedByUser) {
                      startListening();
                    }
                  }, 500);
                }
              },
            }).catch(() => setIsSpeaking(false)); // Silently fail
          }
        },

        onDone: async () => {
          console.log('🏁 Stream completed');
          setIsProcessing(false);
          setCurrentStep('');
          setHasProcessedCommand(true); // Mark that we've processed at least one command

          // Call parent callback if provided
          if (finalResult) {
            onCommandExecuted?.(commandText, finalResult);
          }

          // Speak response
          if (finalMessage && !error && speechAPI) {
            try {
              await new Promise(resolve => setTimeout(resolve, 300));
              setIsSpeaking(true);
              console.log('🔊 Speaking:', finalMessage.substring(0, 100) + '...');

              // Calculate timeout based on message length (20 chars per second average)
              const estimatedDuration = Math.max(10000, (finalMessage.length / 20) * 1000);
              const ttsTimeout = setTimeout(() => {
                setIsSpeaking(false);
                console.warn('TTS timeout - skipping audio playback after', estimatedDuration, 'ms');
              }, estimatedDuration);

              await speechAPI.speak(finalMessage, {
                lang: 'en-US',
                onEnd: () => {
                  clearTimeout(ttsTimeout);
                  setIsSpeaking(false);
                  console.log('✅ TTS finished successfully');

                  // Resume listening in continuous mode
                  if (mode === 'continuous' && !isPausedByUser) {
                    console.log('🎤 Resuming continuous listening after TTS...');
                    setTimeout(() => {
                      if (!isProcessing && !isPausedByUser) {
                        startListening();
                      }
                    }, 500);
                  }
                },
                onError: (err) => {
                  clearTimeout(ttsTimeout);
                  setIsSpeaking(false);
                  console.debug('TTS unavailable:', err);

                  // Resume listening even on TTS error
                  if (mode === 'continuous' && !isPausedByUser) {
                    console.log('🎤 Resuming continuous listening after TTS error...');
                    setTimeout(() => {
                      if (!isProcessing && !isPausedByUser) {
                        startListening();
                      }
                    }, 500);
                  }
                },
              }).catch(err => {
                clearTimeout(ttsTimeout);
                setIsSpeaking(false);
                console.debug('TTS skipped:', err.message);

                // Resume listening even if TTS fails
                if (mode === 'continuous' && !isPausedByUser) {
                  console.log('🎤 Resuming continuous listening after TTS skip...');
                  setTimeout(() => {
                    if (!isProcessing && !isPausedByUser) {
                      startListening();
                    }
                  }, 500);
                }
              });
            } catch (ttsError) {
              setIsSpeaking(false);
              console.debug('TTS unavailable, displaying text only');
            }
          }
        }
      }, sessionId || undefined);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Something went wrong';
      setError(errorMsg);
      setResponse(errorMsg);
      setIsProcessing(false);
      setCurrentStep('');

      // Speak error
      if (speechAPI) {
        setIsSpeaking(true);
        await speechAPI.speak(`Error: ${errorMsg}`, {
          lang: 'en-US',
          onEnd: () => {
            setIsSpeaking(false);
            // Resume listening after error in continuous mode
            if (mode === 'continuous' && !isPausedByUser) {
              console.log('🎤 Resuming continuous listening after error TTS...');
              setTimeout(() => {
                if (!isProcessing && !isPausedByUser) {
                  startListening();
                }
              }, 500);
            }
          },
          onError: () => {
            setIsSpeaking(false);
            // Resume listening even if error TTS fails
            if (mode === 'continuous' && !isPausedByUser) {
              console.log('🎤 Resuming continuous listening after error TTS failure...');
              setTimeout(() => {
                if (!isProcessing && !isPausedByUser) {
                  startListening();
                }
              }, 500);
            }
          },
        }).catch(console.error);
      }
    }
  }, [speechAPI, sessionId, error, onCommandExecuted]);

  /**
   * VAD (Voice Activity Detection) - Optional Enhancement
   *
   * Status: OPTIONAL - Basic voice recognition already works via Web Speech API
   *
   * Purpose: VAD would provide more precise voice activity detection than Web Speech API,
   * enabling better "hands-free" continuous listening with automatic start/stop.
   *
   * Implementation Path (for future enhancement):
   * 1. Backend: Create POST /api/voice/transcribe endpoint
   * 2. Backend: Integrate Whisper (npm i @whisper/node or use OpenAI Whisper API)
   * 3. Frontend: Enable VAD below and implement onSpeechEnd handler
   * 4. Frontend: Add voice.transcribeAudio() function in lib/api.ts
   *
   * Benefits:
   * - More accurate speech boundary detection
   * - Better noise filtering than browser STT
   * - Offline capability (if using local Whisper)
   * - Lower latency for continuous mode
   *
   * Note: Current Web Speech API implementation is production-ready and works well.
   * This VAD integration is a future enhancement, not a requirement.
   */
  const { isListening: vadIsListening, isSpeaking: vadIsSpeaking } = useVAD({
    enabled: false, // Disabled - using Web Speech API (production-ready)
    onSpeechEnd: async (audioBlob) => {
      console.log('🎤 VAD: Speech detected, converting to text...');
      // Implementation when backend Whisper endpoint is ready:
      // const formData = new FormData();
      // formData.append('audio', audioBlob);
      // const transcript = await voice.transcribeAudio(formData);
      // if (transcript) {
      //   await processVoiceCommand(transcript);
      // }
    },
    onVADError: (error) => {
      console.error('VAD Error:', error);
      setError(error.message);
    },
  });

  // Extracted: Start listening
  const startListening = useCallback(() => {
    if (!speechAPI || isListening || isProcessing) return;

    console.log('🎤 Starting voice recognition...');
    setTranscript('');
    setInterimTranscript('');
    setResponse('');
    setError('');
    setProgressUpdates([]);
    setCurrentStep('');

    speechAPI.startListening({
      onTranscript: async (finalTranscript) => {
        console.log('📝 Final transcript:', finalTranscript);
        setTranscript(finalTranscript);
        setInterimTranscript('');
        setIsListening(false);

        // Stop speech recognition before processing
        speechAPI.stopListening();

        // Wait for audio subsystem to release
        await new Promise(resolve => setTimeout(resolve, 300));

        // Process command
        await processVoiceCommand(finalTranscript);
      },

      onInterim: (interim) => {
        setInterimTranscript(interim);
      },

      onError: (errorMsg) => {
        console.error('🎤 Speech error:', errorMsg);
        setError(errorMsg);
        setIsListening(false);
        setInterimTranscript('');
      },
    });

    setIsListening(true);
  }, [speechAPI, isListening, isProcessing, processVoiceCommand]);

  // Extracted: Stop listening
  const stopListening = useCallback(() => {
    if (!speechAPI || !isListening) return;

    console.log('🎤 Stopping voice recognition...');
    speechAPI.stopListening();
    setIsListening(false);
    setInterimTranscript('');
  }, [speechAPI, isListening]);

  // Continuous mode: Auto-restart after command completion (only after first command, not if paused by user)
  useEffect(() => {
    if (mode === 'continuous' && !isListening && !isProcessing && !isSpeaking && speechAPI && hasProcessedCommand && !isPausedByUser) {
      console.log('🔄 Continuous mode: Auto-restarting listener...');
      const timer = setTimeout(() => {
        // Double-check conditions before restarting (TTS might still be playing)
        if (mode === 'continuous' && !isListening && !isProcessing && !isSpeaking && !isPausedByUser) {
          console.log('✅ Conditions met, restarting listener now');
          startListening();
        } else {
          console.log('⏸️ Conditions changed, not restarting', { isListening, isProcessing, isSpeaking, isPausedByUser });
        }
      }, 2000); // 2 second delay to ensure TTS completes

      return () => clearTimeout(timer);
    }
  }, [mode, isListening, isProcessing, isSpeaking, speechAPI, hasProcessedCommand, isPausedByUser, startListening]);

  const handleMicClick = useCallback(() => {
    if (!speechAPI) {
      setError('Speech API not initialized');
      return;
    }

    if (mode === 'push_to_talk') {
      // Manual toggle for push-to-talk
      if (isListening) {
        stopListening();
      } else {
        startListening();
      }
    } else {
      // Continuous mode: Manual clicks can pause/resume
      if (isListening) {
        console.log('🔇 User paused continuous mode');
        setIsPausedByUser(true); // Prevent auto-restart
        stopListening();
      } else {
        console.log('▶️ User resumed continuous mode');
        setIsPausedByUser(false); // Allow auto-restart
        startListening();
      }
    }
  }, [speechAPI, mode, isListening, startListening, stopListening]);

  // Determine button state and style
  const getButtonStyle = () => {
    if (isProcessing) {
      return 'bg-yellow-500 cursor-not-allowed';
    }
    if (isListening) {
      return 'bg-red-500 hover:bg-red-600 mic-active';
    }
    return 'bg-indigo-600 hover:bg-indigo-700 hover:scale-110';
  };

  const getButtonText = () => {
    if (isProcessing) return 'Processing...';
    if (isListening) return 'Listening... Click to stop';
    if (isSpeaking) return 'Speaking...';
    return 'Click to start voice command';
  };

  if (!isSupported) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-center gap-3 text-red-700">
            <AlertCircle className="w-6 h-6" />
            <div>
              <h3 className="font-bold mb-1">Browser Not Supported</h3>
              <p className="text-sm">
                Please use Google Chrome, Microsoft Edge, or Safari for voice commands.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      {/* Mode Toggle */}
      <div className="flex justify-center mb-6">
        <div className="inline-flex rounded-lg border border-gray-300 bg-white p-1">
          <button
            onClick={() => setMode('continuous')}
            className={`
              px-4 py-2 rounded-md text-sm font-medium transition-colors
              ${mode === 'continuous'
                ? 'bg-indigo-600 text-white'
                : 'text-gray-700 hover:bg-gray-100'
              }
            `}
          >
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4" />
              Continuous
            </div>
          </button>
          <button
            onClick={() => setMode('push_to_talk')}
            className={`
              px-4 py-2 rounded-md text-sm font-medium transition-colors
              ${mode === 'push_to_talk'
                ? 'bg-indigo-600 text-white'
                : 'text-gray-700 hover:bg-gray-100'
              }
            `}
          >
            <div className="flex items-center gap-2">
              <Mic className="w-4 h-4" />
              Push to Talk
            </div>
          </button>
        </div>
      </div>

      {/* Microphone Button */}
      <div className="text-center mb-8">
        <button
          onClick={handleMicClick}
          disabled={isProcessing || isSpeaking}
          className={`
            relative w-32 h-32 rounded-full transition-all duration-300 shadow-xl
            ${getButtonStyle()}
            ${(isProcessing || isSpeaking) ? 'opacity-75' : ''}
            focus:outline-none focus:ring-4 focus:ring-indigo-300
          `}
          aria-label={isListening ? 'Stop listening' : 'Start listening'}
        >
          {isProcessing ? (
            <Loader2 className="w-12 h-12 text-white mx-auto animate-spin" />
          ) : isSpeaking ? (
            <Volume2 className="w-12 h-12 text-white mx-auto animate-pulse" />
          ) : isListening ? (
            <MicOff className="w-12 h-12 text-white mx-auto" />
          ) : (
            <Mic className="w-12 h-12 text-white mx-auto" />
          )}
        </button>

        <p className="mt-4 text-gray-600 font-medium">
          {getButtonText()}
        </p>
      </div>

      {/* Voice Wave Visualization */}
      {isListening && (
        <div className="flex justify-center items-center gap-1 mb-8 h-20">
          {[...Array(20)].map((_, i) => (
            <div
              key={i}
              className="w-1 bg-indigo-500 rounded-full transition-all duration-100"
              style={{
                height: `${20 + Math.random() * audioLevel * 60}px`,
              }}
            />
          ))}
        </div>
      )}

      {/* Interim Transcript (Live - Only while listening) */}
      {interimTranscript && isListening && (
        <div className="bg-gray-50 p-2 rounded-lg mb-2 border border-gray-200 animate-pulse">
          <p className="text-gray-500 text-sm italic">
            {interimTranscript}
          </p>
        </div>
      )}

      {/* Single-line Processing Status - Only show while processing */}
      {isProcessing && currentStep && (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 p-3 rounded-lg shadow-sm mb-4 border border-indigo-200 animate-pulse">
          <div className="flex items-center gap-2">
            <span className="text-indigo-600 font-bold animate-bounce">*</span>
            <p className="text-sm font-medium text-indigo-900">{currentStep}</p>
          </div>
        </div>
      )}

      {/* Conversation History - Compact Chat Style */}
      {conversationHistory.length > 0 && (
        <div className="bg-white rounded-xl shadow-md border border-gray-200 mb-4 max-h-64 overflow-y-auto">
          <div className="p-3 space-y-2">
            {conversationHistory.map((msg, idx) => (
              <div
                key={idx}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-100 text-gray-900'
                  }`}
                >
                  <p>{msg.message}</p>
                  <p className={`text-xs mt-1 ${msg.role === 'user' ? 'text-indigo-200' : 'text-gray-500'}`}>
                    {msg.timestamp.toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Current Error Display (if any) */}
      {error && (
        <div className="bg-red-50 p-3 rounded-lg shadow-sm mb-4 border border-red-200">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-900">{error}</p>
          </div>
        </div>
      )}

      {/* Example Commands */}
      <div className="mt-12 bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <h3 className="text-lg font-semibold mb-4 text-gray-900">Try saying:</h3>
        <ul className="space-y-3">
          {exampleCommands.map((cmd, idx) => (
            <li key={idx} className="flex items-start gap-3 text-gray-700 hover:bg-gray-50 p-2 rounded-lg transition-colors">
              <span className="w-2 h-2 bg-indigo-600 rounded-full mt-2 flex-shrink-0"></span>
              <span className="font-medium">&quot;{cmd}&quot;</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Quick Tips */}
      <div className="mt-6 bg-blue-50 p-4 rounded-lg border border-blue-200">
        <h4 className="font-semibold text-blue-900 mb-2 text-sm">💡 Tips for best results:</h4>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• Speak clearly and at a normal pace</li>
          <li>• Use natural language - no need for specific commands</li>
          <li>• Wait for the response before giving the next command</li>
          <li>• Make sure your microphone is allowed in browser settings</li>
        </ul>
      </div>
    </div>
  );
}

// Example commands - will be loaded dynamically from backend
const exampleCommands = [
  "Schedule a meeting tomorrow at 3 PM",
  "Show my calendar for next week",
  "Create an event titled Team Standup on Monday at 10am",
  "List my upcoming meetings",
  "Schedule a meeting with john@example.com tomorrow at 2pm about Project Review",
];
