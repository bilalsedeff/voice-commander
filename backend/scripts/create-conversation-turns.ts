/**
 * Create conversation_turns table
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function createConversationTurnsTable() {
  try {
    // Check if table exists
    const tableExists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'conversation_turns'
      );
    `);

    if (tableExists[0]?.exists) {
      console.log('✅ conversation_turns table already exists');
      return;
    }

    // Create table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "conversation_turns" (
        "id" TEXT PRIMARY KEY,
        "sessionId" TEXT NOT NULL,
        "turnNumber" INTEGER NOT NULL,
        "userQuery" TEXT NOT NULL,
        "userIntent" TEXT,
        "assistantResponse" TEXT NOT NULL,
        "toolResults" JSONB,
        "ttsSpoken" BOOLEAN NOT NULL DEFAULT false,
        "durationMs" INTEGER,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "conversation_turns_sessionId_fkey" FOREIGN KEY ("sessionId")
          REFERENCES "voice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
    `);

    // Create indexes
    await prisma.$executeRawUnsafe(`
      CREATE INDEX "conversation_turns_sessionId_idx" ON "conversation_turns"("sessionId");
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX "conversation_turns_sessionId_turnNumber_idx" ON "conversation_turns"("sessionId", "turnNumber");
    `);

    console.log('✅ conversation_turns table created successfully');

    // Also add missing columns to voice_sessions
    const alterVoiceSessionsSQL = `
      ALTER TABLE "voice_sessions"
      ADD COLUMN IF NOT EXISTS "mode" TEXT DEFAULT 'continuous',
      ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS "totalTurns" INTEGER DEFAULT 0;
    `;

    await prisma.$executeRawUnsafe(alterVoiceSessionsSQL);
    console.log('✅ voice_sessions table updated with new columns');

    // Create index on status
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "voice_sessions_status_idx" ON "voice_sessions"("status");
    `);

  } catch (error) {
    console.error('❌ Error creating conversation_turns table:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

createConversationTurnsTable();
