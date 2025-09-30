/**
 * Development Server - Simple Voice MCP Gateway Startup
 * Starts the voice server with minimal configuration for testing
 */

import 'dotenv/config';
import VoiceMCPGateway from './gateway/voice-server';

async function startDevServer() {
  console.log('🚀 Starting Voice MCP Gateway Development Server...');
  console.log('================================================');

  try {
    // Check environment
    if (!process.env.OPENAI_API_KEY) {
      console.warn('⚠️  OPENAI_API_KEY not found - STT/TTS will not work');
    } else {
      console.log('✅ OpenAI API key found');
    }

    // Create and start the gateway
    const gateway = new VoiceMCPGateway();
    await gateway.start();

    console.log('');
    console.log('🎉 Voice MCP Gateway is running!');
    console.log('📱 WebSocket Server: ws://localhost:8711');
    console.log('🌐 HTTP Server: http://localhost:8710');
    console.log('🎤 Open src/dashboard/index.html to test voice interface');
    console.log('');
    console.log('Press Ctrl+C to stop the server');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n⏹️  Shutting down Voice MCP Gateway...');
      try {
        await gateway.stop();
        console.log('✅ Server stopped gracefully');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startDevServer();