/**
 * SSE (Server-Sent Events) Client for Voice Command Streaming
 *
 * Connects to backend SSE endpoint to receive real-time progress updates
 * during LLM-MCP orchestration.
 */

export interface ProgressUpdate {
  step: string;
  message: string;
  timestamp: string;
  data?: unknown;
}

export interface SSEEventData {
  type: 'progress' | 'result' | 'error' | 'done';
  data: unknown;
}

export interface SSECallbacks {
  onProgress?: (update: ProgressUpdate) => void;
  onResult?: (result: unknown) => void;
  onError?: (error: { message: string; code?: string }) => void;
  onDone?: () => void;
  onConnectionError?: (error: Error) => void;
}

export class SSEClient {
  private eventSource: EventSource | null = null;
  private callbacks: SSECallbacks = {};

  /**
   * Start streaming voice command execution
   */
  async streamVoiceCommand(
    command: string,
    token: string,
    callbacks: SSECallbacks
  ): Promise<void> {
    this.callbacks = callbacks;

    // Close existing connection if any
    this.close();

    const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    const url = `${API_BASE_URL}/api/voice/llm/stream`;

    try {
      // Create EventSource with POST data via fetch first
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ command }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Request failed' }));
        throw new Error(errorData.message || `HTTP ${response.status}`);
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('Response body is not readable');
      }

      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          this.callbacks.onDone?.();
          break;
        }

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            eventData = line.slice(5).trim();
          } else if (line === '' && eventType && eventData) {
            // Complete event - process it
            this.handleEvent(eventType, eventData);
            eventType = '';
            eventData = '';
          }
        }
      }
    } catch (error) {
      console.error('SSE streaming error:', error);
      const errorObj = error instanceof Error ? error : new Error('Unknown SSE error');
      this.callbacks.onConnectionError?.(errorObj);
      this.callbacks.onError?.({
        message: errorObj.message,
        code: 'SSE_ERROR'
      });
    } finally {
      this.close();
    }
  }

  /**
   * Handle incoming SSE event
   */
  private handleEvent(eventType: string, eventData: string): void {
    try {
      const data = JSON.parse(eventData);

      switch (eventType) {
        case 'progress':
          this.callbacks.onProgress?.(data as ProgressUpdate);
          break;

        case 'result':
          this.callbacks.onResult?.(data);
          break;

        case 'error':
          this.callbacks.onError?.(data as { message: string; code?: string });
          break;

        case 'done':
          this.callbacks.onDone?.();
          break;

        default:
          console.warn('Unknown SSE event type:', eventType);
      }
    } catch (error) {
      console.error('Failed to parse SSE event data:', eventData, error);
    }
  }

  /**
   * Close SSE connection
   */
  close(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }
}

/**
 * Singleton SSE client instance
 */
export const sseClient = new SSEClient();
