/**
 * Web Speech API Wrapper
 * Provides FREE client-side Speech-to-Text and Text-to-Speech
 * No API costs - runs entirely in the browser
 */

// TypeScript interfaces for Web Speech API
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
}

interface SpeechRecognitionConstructor {
  new(): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export class SpeechAPI {
  private recognition: SpeechRecognition;
  private synthesis: SpeechSynthesis;
  private onTranscriptCallback?: (transcript: string) => void;
  private onInterimCallback?: (transcript: string) => void;
  private onErrorCallback?: (error: string) => void;
  private isListening: boolean = false;
  private finalizeTimer?: NodeJS.Timeout; // Timer for delayed finalization
  private lastInterimTranscript: string = ''; // Store last interim result

  constructor() {
    // Initialize Speech Recognition (STT)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      throw new Error('Speech Recognition not supported in this browser. Please use Chrome, Edge, or Safari.');
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true; // Keep listening (don't auto-stop)
    this.recognition.interimResults = true; // Get partial results
    this.recognition.lang = 'en-US'; // Default language
    this.recognition.maxAlternatives = 1; // Only best result

    // Initialize Speech Synthesis (TTS)
    this.synthesis = window.speechSynthesis;

    this.setupRecognitionHandlers();
  }

  private setupRecognitionHandlers() {
    this.recognition.onstart = () => {
      console.log('🎤 Speech recognition started');
      this.isListening = true;
    };

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      const results = event.results;
      const lastResult = results[results.length - 1];

      // Interim result (partial transcription)
      if (!lastResult.isFinal) {
        const interimTranscript = lastResult[0].transcript;
        this.lastInterimTranscript = interimTranscript;
        this.onInterimCallback?.(interimTranscript);

        // Clear previous timer and start new one
        // Wait 2 seconds after last speech before finalizing
        if (this.finalizeTimer) {
          clearTimeout(this.finalizeTimer);
        }

        this.finalizeTimer = setTimeout(() => {
          // No new speech for 2 seconds - finalize current interim transcript
          if (this.lastInterimTranscript && this.isListening) {
            console.log(`⏱️ Auto-finalizing after 2s pause: "${this.lastInterimTranscript}"`);
            this.onTranscriptCallback?.(this.lastInterimTranscript);
            this.lastInterimTranscript = '';
            this.recognition.stop(); // Stop recognition to trigger onend
          }
        }, 2000); // 2 second delay
      } else {
        // Final result from browser
        if (this.finalizeTimer) {
          clearTimeout(this.finalizeTimer);
        }
        const transcript = lastResult[0].transcript;
        const confidence = lastResult[0].confidence;
        console.log(`📝 Final transcript: "${transcript}" (confidence: ${confidence.toFixed(2)})`);
        this.lastInterimTranscript = '';
        this.onTranscriptCallback?.(transcript);
      }
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.isListening = false;

      // Ignore "no-speech" errors - this is normal when user doesn't speak
      if (event.error === 'no-speech') {
        console.debug('No speech detected - ignoring error');
        return;
      }

      console.error('❌ Speech recognition error:', event.error);

      let errorMessage = 'Speech recognition error';
      switch (event.error) {
        case 'audio-capture':
          errorMessage = 'Microphone not found or permission denied.';
          break;
        case 'not-allowed':
          errorMessage = 'Microphone access denied. Please allow microphone access.';
          break;
        case 'network':
          errorMessage = 'Network error. Please check your connection.';
          break;
        default:
          errorMessage = `Speech recognition error: ${event.error}`;
      }

      this.onErrorCallback?.(errorMessage);
    };

    this.recognition.onend = () => {
      console.log('🛑 Speech recognition ended');
      this.isListening = false;
    };
  }

  /**
   * Start listening for voice input
   */
  startListening(options: {
    onTranscript: (transcript: string) => void;
    onInterim?: (transcript: string) => void;
    onError?: (error: string) => void;
    language?: string;
  }) {
    this.onTranscriptCallback = options.onTranscript;
    this.onInterimCallback = options.onInterim;
    this.onErrorCallback = options.onError;

    if (options.language) {
      this.recognition.lang = options.language;
    }

    try {
      this.recognition.start();
      console.log('🎤 Starting to listen...');
    } catch (error) {
      console.error('Failed to start recognition:', error);
      options.onError?.('Failed to start listening. Microphone may be in use.');
    }
  }

  /**
   * Stop listening
   */
  stopListening() {
    if (this.isListening) {
      // Clear any pending finalize timer
      if (this.finalizeTimer) {
        clearTimeout(this.finalizeTimer);
        this.finalizeTimer = undefined;
      }
      this.lastInterimTranscript = '';
      this.recognition.stop();
    }
  }

  /**
   * Abort listening immediately
   */
  abortListening() {
    if (this.isListening) {
      this.recognition.abort();
    }
  }

  /**
   * Speak text using browser TTS (FREE)
   */
  speak(
    text: string,
    options?: {
      lang?: string; // Language code (e.g., 'en-US', 'tr-TR')
      rate?: number; // 0.1 to 10 (default: 1)
      pitch?: number; // 0 to 2 (default: 1)
      volume?: number; // 0 to 1 (default: 1)
      voice?: SpeechSynthesisVoice;
      onEnd?: () => void;
      onError?: (error: string) => void;
    }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Cancel any ongoing speech
      this.synthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = options?.rate || 1.0;
      utterance.pitch = options?.pitch || 1.0;
      utterance.volume = options?.volume || 1.0;
      utterance.lang = options?.lang || 'en-US'; // Set language

      // Use specified voice or find a good default for the language
      if (options?.voice) {
        utterance.voice = options.voice;
      } else {
        const voices = this.synthesis.getVoices();
        const targetLang = options?.lang || 'en-US';

        const preferredVoice =
          voices.find((v) => v.lang === targetLang && (v.name.includes('Google') || v.name.includes('Natural'))) ||
          voices.find((v) => v.lang === targetLang) ||
          voices.find((v) => v.lang.startsWith(targetLang.split('-')[0])) ||
          voices[0];

        if (preferredVoice) {
          utterance.voice = preferredVoice;
        }
      }

      utterance.onend = () => {
        console.log('🔊 Finished speaking');
        options?.onEnd?.();
        resolve();
      };

      utterance.onerror = (event) => {
        // TTS errors are non-critical (expected after voice input due to browser audio conflicts)
        if (event.error === 'interrupted' || event.error === 'canceled') {
          console.debug('TTS skipped (expected):', event.error);
          resolve(); // Resolve instead of reject
        } else {
          console.warn('TTS error:', event.error);
          const errorMsg = `Speech synthesis error: ${event.error}`;
          options?.onError?.(errorMsg);
          reject(new Error(errorMsg));
        }
      };

      this.synthesis.speak(utterance);
      console.log('🔊 Speaking:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
    });
  }

  /**
   * Stop speaking immediately
   */
  stopSpeaking() {
    this.synthesis.cancel();
  }

  /**
   * Check if currently listening
   */
  getIsListening(): boolean {
    return this.isListening;
  }

  /**
   * Check if Speech Recognition is supported
   */
  static isSupported(): boolean {
    return (
      'SpeechRecognition' in window ||
      'webkitSpeechRecognition' in window
    );
  }

  /**
   * Check if Speech Synthesis is supported
   */
  static isSynthesisSupported(): boolean {
    return 'speechSynthesis' in window;
  }

  /**
   * Get available voices for TTS
   */
  getAvailableVoices(): SpeechSynthesisVoice[] {
    return this.synthesis.getVoices();
  }

  /**
   * Get recommended voice for given language
   */
  getRecommendedVoice(lang: string = 'en-US'): SpeechSynthesisVoice | undefined {
    const voices = this.getAvailableVoices();
    return (
      voices.find((v) => v.lang === lang && (v.name.includes('Google') || v.name.includes('Natural'))) ||
      voices.find((v) => v.lang === lang) ||
      voices.find((v) => v.lang.startsWith(lang.split('-')[0]))
    );
  }

  /**
   * Set language for speech recognition
   */
  setLanguage(lang: string) {
    this.recognition.lang = lang;
  }
}
