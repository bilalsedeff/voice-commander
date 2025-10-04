/**
 * Audio Conversion Utilities
 *
 * Converts Float32Array audio data from VAD to WAV format for backend processing
 */

/**
 * Convert Float32Array to WAV Blob
 * @param audioData - Float32Array from VAD
 * @param sampleRate - Audio sample rate (default: 16000 for VAD)
 * @returns WAV Blob ready for upload
 */
export function float32ToWav(audioData: Float32Array, sampleRate: number = 16000): Blob {
  const numChannels = 1; // Mono
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = audioData.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // Write WAV header
  // "RIFF" chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true); // File size - 8
  writeString(view, 8, 'WAVE');

  // "fmt " sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // BitsPerSample

  // "data" sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true); // Subchunk2Size

  // Write PCM samples
  const offset = 44;
  for (let i = 0; i < audioData.length; i++) {
    const sample = Math.max(-1, Math.min(1, audioData[i])); // Clamp to [-1, 1]
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF; // Convert to 16-bit
    view.setInt16(offset + i * 2, int16, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Helper function to write string to DataView
 */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Concatenate multiple Float32Arrays into one
 * Useful for accumulating audio chunks from VAD
 */
export function concatenateFloat32Arrays(arrays: Float32Array[]): Float32Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;

  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }

  return result;
}

/**
 * Calculate RMS (Root Mean Square) of audio signal
 * Useful for detecting speech energy level
 */
export function calculateRMS(audioData: Float32Array): number {
  const sumOfSquares = audioData.reduce((sum, sample) => sum + sample * sample, 0);
  return Math.sqrt(sumOfSquares / audioData.length);
}

/**
 * Apply simple noise gate to audio data
 * Removes samples below threshold to reduce background noise
 */
export function applyNoiseGate(
  audioData: Float32Array,
  threshold: number = 0.01
): Float32Array {
  return audioData.map(sample =>
    Math.abs(sample) < threshold ? 0 : sample
  );
}
