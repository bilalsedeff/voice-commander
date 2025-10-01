/**
 * MCP Server Seed Data
 * Populates initial MCP servers for MVP
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding MCP servers...');

  // Google Calendar MCP (OAuth-based, stdio transport)
  const googleCalendarMCP = await prisma.mCPServer.upsert({
    where: { name: '@takumi0706/google-calendar-mcp' },
    update: {},
    create: {
      name: '@takumi0706/google-calendar-mcp',
      displayName: 'Google Calendar',
      description: 'Manage Google Calendar events with voice commands. Create, list, update, and delete calendar events.',
      category: 'productivity',
      iconUrl: 'https://www.google.com/calendar/about/images/calendar-icon.png',

      authType: 'oauth',
      provider: 'google',

      transport: 'stdio',
      npmPackage: '@takumi0706/google-calendar-mcp',
      command: 'npx',
      args: ['-y', '@takumi0706/google-calendar-mcp'],

      oauthScopes: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly'
      ],

      tools: [
        {
          name: 'create_event',
          description: 'Create a new calendar event',
          inputSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'Event title' },
              startTime: { type: 'string', description: 'Start time (ISO or natural language)' },
              endTime: { type: 'string', description: 'End time (optional)' },
              description: { type: 'string', description: 'Event description (optional)' },
              attendees: { type: 'string', description: 'Comma-separated emails (optional)' }
            },
            required: ['summary', 'startTime']
          }
        },
        {
          name: 'list_events',
          description: 'List upcoming calendar events',
          inputSchema: {
            type: 'object',
            properties: {
              maxResults: { type: 'number', description: 'Max events to return (default: 10)' },
              timeMin: { type: 'string', description: 'Start date (default: now)' },
              timeMax: { type: 'string', description: 'End date (optional)' }
            }
          }
        },
        {
          name: 'update_event',
          description: 'Update an existing calendar event',
          inputSchema: {
            type: 'object',
            properties: {
              eventId: { type: 'string', description: 'Event ID' },
              summary: { type: 'string', description: 'New title (optional)' },
              startTime: { type: 'string', description: 'New start time (optional)' },
              endTime: { type: 'string', description: 'New end time (optional)' }
            },
            required: ['eventId']
          }
        },
        {
          name: 'delete_event',
          description: 'Delete a calendar event',
          inputSchema: {
            type: 'object',
            properties: {
              eventId: { type: 'string', description: 'Event ID to delete' }
            },
            required: ['eventId']
          }
        }
      ],

      version: '1.0.0',
      author: '@takumi0706',
      repository: 'https://github.com/takumi0706/google-calendar-mcp',
      documentation: 'https://github.com/takumi0706/google-calendar-mcp#readme',

      installCount: 0,
      isActive: true
    }
  });

  console.log('✅ Google Calendar MCP seeded:', googleCalendarMCP.id);

  // Context7 MCP (Free, hosted, no auth needed)
  const context7MCP = await prisma.mCPServer.upsert({
    where: { name: '@upstash/context7' },
    update: {},
    create: {
      name: '@upstash/context7',
      displayName: 'Context7',
      description: 'Get up-to-date documentation and code examples for popular libraries and frameworks.',
      category: 'development',
      iconUrl: 'https://upstash.com/favicon.ico',

      authType: 'none',
      provider: null,

      transport: 'http-sse',
      npmPackage: '@upstash/context7',
      command: 'npx',
      args: ['-y', '@upstash/context7'],
      hostedUrl: 'https://mcp.context7.com/mcp',

      tools: [
        {
          name: 'get_docs',
          description: 'Get documentation for a library/framework',
          inputSchema: {
            type: 'object',
            properties: {
              library: { type: 'string', description: 'Library name (e.g., "react", "nextjs")' },
              topic: { type: 'string', description: 'Specific topic (optional)' }
            },
            required: ['library']
          }
        }
      ],

      version: '1.0.0',
      author: '@upstash',
      repository: 'https://github.com/upstash/context7',
      documentation: 'https://github.com/upstash/context7#readme',

      installCount: 0,
      isActive: true
    }
  });

  console.log('✅ Context7 MCP seeded:', context7MCP.id);

  console.log('🎉 MCP seed completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
