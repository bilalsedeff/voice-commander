/**
 * useVAD Hook
 *
 * Voice Activity Detection (VAD) hook for continuous listening mode
 * Uses @ricky0123/vad-web for browser-based speech detection
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { MicVAD } from '@ricky0123/vad-web';
import { float32ToWav, concatenateFloat32Arrays } from '../utils/audio';

interface UseVADOptions {
  enabled: boolean; // Enable/disable VAD
  onSpeechStart?: () => void; // Callback when speech starts
  onSpeechEnd?: (audioBlob: Blob) => void; // Callback when speech ends with audio data
  onVADError?: (error: Error) => void; // Callback on VAD error
  minSpeechDuration?: number; // Minimum speech duration in ms (default: 500ms)
  positiveSpeechThreshold?: number; // VAD sensitivity (0-1, default: 0.8)
  negativeSpeechThreshold?: number; // End-of-speech sensitivity (0-1, default: 0.5)
  preSpeechPadMs?: number; // Milliseconds to include before speech (default: 300ms)
  redemptionMs?: number; // Milliseconds of silence grace period before ending (default: 300ms)
}

interface UseVADReturn {
  isListening: boolean; // Is VAD currently active
  isSpeaking: boolean; // Is speech currently detected
  start: () => Promise<void>; // Start VAD
  stop: () => void; // Stop VAD
  error: Error | null; // VAD error if any
}

/**
 * Custom hook for Voice Activity Detection
 *
 * Example usage:
 * ```tsx
 * const { isListening, isSpeaking, start, stop } = useVAD({
 *   enabled: mode === 'continuous',
 *   onSpeechEnd: async (audioBlob) => {
 *     // Process audio blob
 *     await processVoiceCommand(audioBlob);
 *   }
 * });
 * ```
 */
export function useVAD({
  enabled,
  onSpeechStart,
  onSpeechEnd,
  onVADError,
  minSpeechDuration = 500,
  positiveSpeechThreshold = 0.8,
  negativeSpeechThreshold = 0.5,
  preSpeechPadMs = 300,
  redemptionMs = 300
}: UseVADOptions): UseVADReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const audioChunksRef = useRef<Float32Array[]>([]);
  const speechStartTimeRef = useRef<number>(0);
  const vadInstanceRef = useRef<MicVAD | null>(null);

  // Start VAD
  const start = useCallback(async () => {
    try {
      console.log('🎤 VAD: Starting...');
      setError(null);

      // Create VAD instance with configuration
      const vad = await MicVAD.new({
        // Use v5 model (NOT legacy) - fixes silero_vad_legacy.onnx error
        model: "v5",

        // Use CDN for model and worklet files (fixes 404 errors)
        baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.28/dist/",
        onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/",

        positiveSpeechThreshold,
        negativeSpeechThreshold,
        preSpeechPadMs,
        redemptionMs,
        minSpeechMs: minSpeechDuration,

        // Callbacks
        onSpeechStart: () => {
          console.log('🎤 VAD: Speech started');
          setIsSpeaking(true);
          audioChunksRef.current = [];
          speechStartTimeRef.current = Date.now();
          onSpeechStart?.();
        },

        onSpeechEnd: (audio: Float32Array) => {
          const speechDuration = Date.now() - speechStartTimeRef.current;
          console.log('🎤 VAD: Speech ended', { duration: speechDuration });

          // Add final chunk
          audioChunksRef.current.push(audio);

          // Check minimum duration
          if (speechDuration < minSpeechDuration) {
            console.warn(`⚠️ VAD: Speech too short (${speechDuration}ms), ignoring`);
            audioChunksRef.current = [];
            setIsSpeaking(false);
            return;
          }

          // Concatenate all audio chunks
          const fullAudio = concatenateFloat32Arrays(audioChunksRef.current);

          // Convert to WAV
          const wavBlob = float32ToWav(fullAudio, 16000);

          console.log('🎤 VAD: Audio converted to WAV', {
            samples: fullAudio.length,
            blobSize: wavBlob.size,
            duration: speechDuration
          });

          setIsSpeaking(false);
          audioChunksRef.current = [];

          // Callback with WAV blob
          onSpeechEnd?.(wavBlob);
        },

        onVADMisfire: () => {
          console.warn('⚠️ VAD: Misfire detected (false positive)');
          audioChunksRef.current = [];
          setIsSpeaking(false);
        },
      });

      // Start VAD
      vad.start();
      vadInstanceRef.current = vad;
      setIsListening(true);

      console.log('✅ VAD: Started successfully');
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to start VAD');
      console.error('❌ VAD: Start failed', error);
      setError(error);
      onVADError?.(error);
    }
  }, [
    positiveSpeechThreshold,
    negativeSpeechThreshold,
    preSpeechPadMs,
    redemptionMs,
    minSpeechDuration,
    onSpeechStart,
    onSpeechEnd,
    onVADError
  ]);

  // Stop VAD
  const stop = useCallback(() => {
    console.log('🎤 VAD: Stopping...');

    if (vadInstanceRef.current) {
      vadInstanceRef.current.pause();
      vadInstanceRef.current = null;
    }

    setIsListening(false);
    setIsSpeaking(false);
    audioChunksRef.current = [];

    console.log('✅ VAD: Stopped');
  }, []);

  // Auto start/stop based on enabled prop
  useEffect(() => {
    if (enabled && !isListening) {
      start();
    } else if (!enabled && isListening) {
      stop();
    }
  }, [enabled, isListening, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isListening) {
        stop();
      }
    };
  }, [isListening, stop]);

  return {
    isListening,
    isSpeaking,
    start,
    stop,
    error
  };
}
