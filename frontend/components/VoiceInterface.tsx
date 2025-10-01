'use client';

import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2, Volume2, AlertCircle } from 'lucide-react';
import { SpeechAPI } from '@/lib/speech-api';
import { voice } from '@/lib/api';

interface VoiceInterfaceProps {
  onCommandExecuted?: (command: string, result: any) => void;
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
      // Start listening
      setTranscript('');
      setInterimTranscript('');
      setResponse('');
      setError('');

      speechAPI.startListening({
        onTranscript: async (finalTranscript) => {
          console.log('📝 Final transcript:', finalTranscript);
          setTranscript(finalTranscript);
          setInterimTranscript('');
          setIsListening(false);
          setIsProcessing(true);

          // Execute command via backend
          try {
            const apiResult = await voice.processCommand(finalTranscript);

            setResponse(apiResult.message);
            onCommandExecuted?.(finalTranscript, apiResult);

            // Speak response in English
            setIsSpeaking(true);
            await speechAPI.speak(apiResult.message, {
              lang: 'en-US', // Force English
              onEnd: () => setIsSpeaking(false),
              onError: () => setIsSpeaking(false),
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Something went wrong';
            setError(errorMsg);
            setResponse(errorMsg);

            // Speak error in English
            setIsSpeaking(true);
            await speechAPI.speak(`Error: ${errorMsg}`, {
              lang: 'en-US', // Force English
              onEnd: () => setIsSpeaking(false),
              onError: () => setIsSpeaking(false),
            });
          } finally {
            setIsProcessing(false);
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
