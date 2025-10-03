'use client';

import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2, Volume2, AlertCircle, CheckCircle } from 'lucide-react';
import { SpeechAPI } from '@/lib/speech-api';
import { voice } from '@/lib/api';

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

  // SSE Progress tracking
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  const [currentStep, setCurrentStep] = useState<string>('');

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

  const handleMicClick = () => {
    if (!speechAPI) {
      setError('Speech API not initialized');
      return;
    }

    if (isListening) {
      // Stop listening
      speechAPI.stopListening();
      setIsListening(false);
      setInterimTranscript('');
    } else {
      // Start listening - clear previous session data
      setTranscript('');
      setInterimTranscript('');
      setResponse('');
      setError('');
      setProgressUpdates([]); // Clear previous progress history
      setCurrentStep('');

      speechAPI.startListening({
        onTranscript: async (finalTranscript) => {
          console.log('📝 Final transcript:', finalTranscript);
          setTranscript(finalTranscript);
          setInterimTranscript('');
          setIsListening(false);

          // 🔧 FIX: Explicitly stop speech recognition before processing
          speechAPI.stopListening();

          // Wait for audio subsystem to fully release
          await new Promise(resolve => setTimeout(resolve, 300));

          setIsProcessing(true);
          setProgressUpdates([]); // Clear previous progress
          setCurrentStep('Starting...');

          // Execute command via SSE streaming backend
          try {
            let finalResult: unknown = null;
            let finalMessage = '';

            await voice.streamCommand(finalTranscript, {
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
                  };

                  // If results array exists (from LLM orchestrator)
                  if (resultData.results && Array.isArray(resultData.results) && resultData.results.length > 0) {
                    // Generate natural TTS response via LLM
                    try {
                      console.log('🤖 Generating natural TTS response...');
                      ttsMessage = await voice.generateNaturalResponse(
                        finalTranscript,
                        resultData.results,
                        { keepShort: false, askFollowUp: true }
                      );
                      console.log('✅ Natural TTS response:', ttsMessage);
                    } catch (error) {
                      console.warn('Failed to generate natural response, using fallback', error);
                      // Fallback to template-based response
                      const firstResult = resultData.results[0];
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
                    const firstResult = resultData.results[0];
                    if (firstResult.success && firstResult.data && 'count' in (firstResult.data as Record<string, unknown>)) {
                      const count = (firstResult.data as { count: number }).count;
                      displayMessage = count > 0
                        ? `📅 Found ${count} upcoming event${count > 1 ? 's' : ''}`
                        : '📅 No upcoming meetings found';
                    } else {
                      displayMessage = firstResult.success ? '✅ Command executed successfully' : `❌ ${firstResult.tool} failed`;
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
                    onEnd: () => setIsSpeaking(false),
                    onError: () => setIsSpeaking(false),
                  }).catch(() => setIsSpeaking(false)); // Silently fail
                }
              },

              onDone: async () => {
                console.log('🏁 Stream completed');
                setIsProcessing(false);
                setCurrentStep('');

                // Call parent callback if provided
                if (finalResult) {
                  onCommandExecuted?.(finalTranscript, finalResult);
                }

                // Speak response in English (optional - may fail due to browser audio conflicts)
                console.log('🔊 TTS Check:', { finalMessage, error, hasSpeechAPI: !!speechAPI }); // DEBUG
                if (finalMessage && !error && speechAPI) {
                  try {
                    console.log('🎤 Speaking TTS:', finalMessage); // DEBUG
                    // Wait for audio subsystem to fully release (300ms minimum)
                    await new Promise(resolve => setTimeout(resolve, 300));

                    setIsSpeaking(true);

                    // Use timeout to prevent hanging
                    const ttsTimeout = setTimeout(() => {
                      setIsSpeaking(false);
                      console.warn('TTS timeout - skipping audio playback');
                    }, 5000);

                    await speechAPI.speak(finalMessage, {
                      lang: 'en-US',
                      onEnd: () => {
                        clearTimeout(ttsTimeout);
                        setIsSpeaking(false);
                      },
                      onError: (err) => {
                        clearTimeout(ttsTimeout);
                        setIsSpeaking(false);
                        // Silently fail - TTS is non-critical
                        console.debug('TTS unavailable (expected after voice input):', err);
                      },
                    }).catch(err => {
                      clearTimeout(ttsTimeout);
                      setIsSpeaking(false);
                      // Don't log as error - this is expected behavior
                      console.debug('TTS skipped:', err.message);
                    });
                  } catch (ttsError) {
                    setIsSpeaking(false);
                    // TTS failure is not critical - user already sees text response
                    console.debug('TTS unavailable, displaying text only');
                  }
                }
              }
            });

          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Something went wrong';
            setError(errorMsg);
            setResponse(errorMsg);
            setIsProcessing(false);
            setCurrentStep('');

            // Speak error in English
            setIsSpeaking(true);
            await speechAPI.speak(`Error: ${errorMsg}`, {
              lang: 'en-US',
              onEnd: () => setIsSpeaking(false),
              onError: () => setIsSpeaking(false),
            }).catch(console.error);
          }
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
    }
  };

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

      {/* Interim Transcript (Live) */}
      {interimTranscript && (
        <div className="bg-gray-50 p-4 rounded-lg mb-4 border border-gray-200">
          <p className="text-gray-500 text-sm italic">
            {interimTranscript}
          </p>
        </div>
      )}

      {/* Final Transcript Display */}
      {transcript && (
        <div className="bg-white p-6 rounded-xl shadow-md mb-4 border border-gray-200">
          <div className="flex items-start gap-3">
            <Mic className="w-5 h-5 text-indigo-600 mt-1 flex-shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-gray-500 mb-2">You said:</h3>
              <p className="text-lg text-gray-900 font-medium">{transcript}</p>
            </div>
          </div>
        </div>
      )}

      {/* Real-time Progress Display - Show if processing OR has progress history */}
      {(isProcessing || progressUpdates.length > 0) && (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 p-6 rounded-xl shadow-md mb-4 border border-indigo-200">
          <div className="flex items-center gap-3 mb-4">
            {isProcessing ? (
              <>
                <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                <h3 className="text-sm font-semibold text-indigo-900">Processing...</h3>
              </>
            ) : (
              <>
                <CheckCircle className="w-5 h-5 text-green-600" />
                <h3 className="text-sm font-semibold text-green-900">Execution Flow:</h3>
              </>
            )}
          </div>
          <div className="space-y-3">
            {progressUpdates.map((update, idx) => (
              <div
                key={idx}
                className={`flex items-start gap-3 transition-opacity ${
                  idx === progressUpdates.length - 1 ? 'opacity-100' : 'opacity-60'
                }`}
              >
                <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${
                  idx === progressUpdates.length - 1 ? 'bg-indigo-600 animate-pulse' : 'bg-gray-400'
                }`}></div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{update.step}</p>
                  <p className="text-sm text-gray-600">{update.message}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(update.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Response Display */}
      {response && !error && (
        <div className="bg-indigo-50 p-6 rounded-xl shadow-md border border-indigo-200">
          <div className="flex items-start gap-3">
            <Volume2 className="w-5 h-5 text-indigo-600 mt-1 flex-shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-indigo-600 mb-2">Response:</h3>
              <p className="text-lg text-gray-900">{response}</p>
            </div>
          </div>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 p-6 rounded-xl shadow-md border border-red-200">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 mt-1 flex-shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-600 mb-2">Error:</h3>
              <p className="text-gray-900">{error}</p>
            </div>
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
