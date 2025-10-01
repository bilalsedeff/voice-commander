/**
 * Web Speech API Wrapper
 * Provides FREE client-side Speech-to-Text and Text-to-Speech
 * No API costs - runs entirely in the browser
 */

export class SpeechAPI {
  private recognition: any;
  private synthesis: SpeechSynthesis;
  private onTranscriptCallback?: (transcript: string) => void;
  private onInterimCallback?: (transcript: string) => void;
  private onErrorCallback?: (error: string) => void;
  private isListening: boolean = false;

  constructor() {
    // Initialize Speech Recognition (STT)
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      throw new Error('Speech Recognition not supported in this browser. Please use Chrome, Edge, or Safari.');
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false; // Stop after one utterance
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

    this.recognition.onresult = (event: any) => {
      const results = event.results;
      const lastResult = results[results.length - 1];

      // Interim result (partial transcription)
      if (!lastResult.isFinal) {
        const interimTranscript = lastResult[0].transcript;
        this.onInterimCallback?.(interimTranscript);
      } else {
        // Final result
        const transcript = lastResult[0].transcript;
        const confidence = lastResult[0].confidence;
        console.log(`📝 Final transcript: "${transcript}" (confidence: ${confidence.toFixed(2)})`);
        this.onTranscriptCallback?.(transcript);
      }
    };

    this.recognition.onerror = (event: any) => {
      console.error('❌ Speech recognition error:', event.error);
      this.isListening = false;

      let errorMessage = 'Speech recognition error';
      switch (event.error) {
        case 'no-speech':
          errorMessage = 'No speech detected. Please try again.';
          break;
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
        console.error('❌ Speech synthesis error:', event);
        const errorMsg = `Speech synthesis error: ${event.error}`;
        options?.onError?.(errorMsg);
        reject(new Error(errorMsg));
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
