import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function clearMCPErrors() {
  try {
    const result = await prisma.serviceConnection.updateMany({
      where: {
        provider: 'google'
      },
      data: {
        mcpError: null
      }
    });

    console.log(`✅ Cleared MCP errors for ${result.count} Google Calendar connections`);
  } catch (error) {
    console.error('❌ Failed to clear MCP errors:', error);
  } finally {
    await prisma.$disconnect();
  }
}

clearMCPErrors();
