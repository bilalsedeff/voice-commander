import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkOAuthTokens() {
  try {
    console.log('\n📊 OAuth Token Status:\n');

    const oauthTokens = await prisma.oAuthToken.findMany({
      where: { provider: 'google' }
    });

    console.log(`✅ Found ${oauthTokens.length} OAuth tokens for Google`);

    if (oauthTokens.length > 0) {
      oauthTokens.forEach(token => {
        console.log(`  - User: ${token.userId}`);
        console.log(`    Provider: ${token.provider}`);
        console.log(`    Has Access Token: ${!!token.accessToken}`);
        console.log(`    Has Refresh Token: ${!!token.refreshToken}`);
        console.log(`    Expires: ${token.expiresAt || 'N/A'}`);
      });
    }

    console.log('\n📊 MCP Servers:\n');
    const mcpServers = await prisma.mCPServer.findMany({
      where: { provider: 'google' }
    });

    console.log(`Found ${mcpServers.length} Google MCP servers`);
    mcpServers.forEach(server => {
      console.log(`  - ${server.name} (${server.provider})`);
      console.log(`    Auth Type: ${server.authType}`);
      console.log(`    ID: ${server.id}`);
    });

    console.log('\n📊 Service Connections:\n');
    const connections = await prisma.serviceConnection.findMany({
      where: { provider: 'google' }
    });

    console.log(`Found ${connections.length} Google service connections`);
    connections.forEach(conn => {
      console.log(`  - User: ${conn.userId}`);
      console.log(`    OAuth Connected: ${conn.connected}`);
      console.log(`    MCP Connected: ${conn.mcpConnected}`);
      console.log(`    MCP Status: ${conn.mcpStatus}`);
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkOAuthTokens();
