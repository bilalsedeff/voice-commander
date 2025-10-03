/**
 * Google Calendar MCP Client
 *
 * Implements MCP protocol for Google Calendar operations
 * Supports tool discovery and dynamic command execution
 */

import { google, calendar_v3 } from 'googleapis';
import * as chrono from 'chrono-node';
import { PrismaClient } from '@prisma/client';
import { decryptToken } from '../utils/encryption';
import logger from '../utils/logger';
import { MCPTool, MCPToolCallResult, RiskLevel } from './types';

// Type aliases for clarity
type Calendar = calendar_v3.Calendar;
type CalendarEvent = calendar_v3.Schema$Event;
type GoogleOAuthCredentials = {
  access_token: string;
  refresh_token?: string | null;
};

const prisma = new PrismaClient();

export class GoogleCalendarMCP {
  private tools: MCPTool[] = [
    {
      name: 'create_event',
      description: 'Create a new calendar event',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Event title/summary'
          },
          startTime: {
            type: 'string',
            description: 'Event start time (natural language or ISO format)'
          },
          endTime: {
            type: 'string',
            description: 'Event end time (optional, defaults to 1 hour after start)'
          },
          description: {
            type: 'string',
            description: 'Event description (optional)'
          },
          attendees: {
            type: 'string',
            description: 'Comma-separated list of attendee emails (optional)'
          },
          location: {
            type: 'string',
            description: 'Event location (optional)'
          }
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
          maxResults: {
            type: 'string',
            description: 'Maximum number of events to return (default: 10)'
          },
          timeMin: {
            type: 'string',
            description: 'Start date/time for event search (default: now)'
          },
          timeMax: {
            type: 'string',
            description: 'End date/time for event search (optional)'
          }
        },
        required: []
      }
    },
    {
      name: 'update_event',
      description: 'Update an existing calendar event',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: {
            type: 'string',
            description: 'Event ID to update'
          },
          summary: {
            type: 'string',
            description: 'New event title (optional)'
          },
          startTime: {
            type: 'string',
            description: 'New start time (optional)'
          },
          endTime: {
            type: 'string',
            description: 'New end time (optional)'
          }
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
          eventId: {
            type: 'string',
            description: 'Event ID to delete'
          }
        },
        required: ['eventId']
      }
    }
  ];

  /**
   * Tool discovery - returns available tools
   */
  async discoverTools(): Promise<MCPTool[]> {
    logger.info('Google Calendar MCP: Tool discovery requested');
    return this.tools;
  }

  /**
   * Get tool definition by name
   */
  getTool(name: string): MCPTool | undefined {
    return this.tools.find(t => t.name === name);
  }

  /**
   * Execute a tool call
   */
  async executeTool(
    userId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    logger.info('Executing Google Calendar tool', { toolName, userId });

    try {
      // Get user's OAuth tokens
      const tokens = await this.getTokens(userId);
      const calendar = await this.getCalendarClient(tokens);

      switch (toolName) {
        case 'create_event':
          return await this.createEvent(calendar, args);

        case 'list_events':
          return await this.listEvents(calendar, args);

        case 'update_event':
          return await this.updateEvent(calendar, args);

        case 'delete_event':
          return await this.deleteEvent(calendar, args);

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error) {
      logger.error('Google Calendar tool execution failed', {
        toolName,
        error: (error as Error).message
      });

      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Get risk level for a tool
   */
  getToolRiskLevel(toolName: string): RiskLevel {
    const riskMap: Record<string, RiskLevel> = {
      'list_events': RiskLevel.SAFE,      // Read-only
      'create_event': RiskLevel.LOW,      // Create
      'update_event': RiskLevel.MEDIUM,   // Modify
      'delete_event': RiskLevel.MEDIUM    // Delete
    };

    return riskMap[toolName] ?? RiskLevel.MEDIUM;
  }

  /**
   * Create a calendar event
   */
  private async createEvent(
    calendar: Calendar,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    const { summary, startTime, endTime, description, attendees, location } = args;

    // Parse dates using chrono-node
    const startDate = this.parseDateTime(startTime as string);
    const endDate = endTime
      ? this.parseDateTime(endTime as string)
      : new Date(startDate.getTime() + 3600000); // Default 1 hour

    // Parse attendees
    const attendeeList = attendees
      ? (attendees as string).split(',').map(email => ({
          email: email.trim()
        }))
      : [];

    const event = {
      summary: summary as string,
      description: description as string | undefined,
      location: location as string | undefined,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'UTC'
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'UTC'
      },
      attendees: attendeeList.length > 0 ? attendeeList : undefined
    };

    const result = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event
    });

    logger.info('Calendar event created successfully', {
      eventId: result.data.id,
      summary: result.data.summary
    });

    return {
      success: true,
      data: {
        eventId: result.data.id,
        summary: result.data.summary,
        start: result.data.start?.dateTime,
        end: result.data.end?.dateTime,
        link: result.data.htmlLink,
        attendees: result.data.attendees?.length || 0
      }
    };
  }

  /**
   * List calendar events
   */
  private async listEvents(
    calendar: Calendar,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    const maxResults = args.maxResults ? parseInt(args.maxResults as string) : 10;
    const timeMin = args.timeMin
      ? this.parseDateTime(args.timeMin as string).toISOString()
      : new Date().toISOString();

    const timeMax = args.timeMax
      ? this.parseDateTime(args.timeMax as string).toISOString()
      : undefined;

    const result = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = result.data.items?.map((event: CalendarEvent) => ({
      id: event.id,
      summary: event.summary,
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      location: event.location,
      attendees: event.attendees?.length || 0,
      link: event.htmlLink
    })) || [];

    logger.info('Listed calendar events', { count: events.length });

    return {
      success: true,
      data: {
        events,
        count: events.length
      }
    };
  }

  /**
   * Update calendar event
   */
  private async updateEvent(
    calendar: Calendar,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    const { eventId, summary, startTime, endTime } = args;

    // Get existing event
    const existingEvent = await calendar.events.get({
      calendarId: 'primary',
      eventId: eventId as string
    });

    const updatedEvent: CalendarEvent = {
      ...existingEvent.data
    };

    if (summary) updatedEvent.summary = summary as string;
    if (startTime) {
      const startDate = this.parseDateTime(startTime as string);
      updatedEvent.start = {
        dateTime: startDate.toISOString(),
        timeZone: 'UTC'
      };
    }
    if (endTime) {
      const endDate = this.parseDateTime(endTime as string);
      updatedEvent.end = {
        dateTime: endDate.toISOString(),
        timeZone: 'UTC'
      };
    }

    const result = await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId as string,
      requestBody: updatedEvent
    });

    logger.info('Calendar event updated', { eventId });

    return {
      success: true,
      data: {
        eventId: result.data.id,
        summary: result.data.summary,
        updated: true
      }
    };
  }

  /**
   * Delete calendar event
   */
  private async deleteEvent(
    calendar: Calendar,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    const { eventId } = args;

    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId as string
    });

    logger.info('Calendar event deleted', { eventId });

    return {
      success: true,
      data: {
        eventId,
        deleted: true
      }
    };
  }

  /**
   * Get user's OAuth tokens from database
   */
  private async getTokens(userId: string): Promise<GoogleOAuthCredentials> {
    const oauthToken = await prisma.oAuthToken.findFirst({
      where: {
        userId,
        provider: 'google'
      }
    });

    if (!oauthToken) {
      throw new Error('Google Calendar not connected. Please connect your account first.');
    }

    if (oauthToken.expiresAt && oauthToken.expiresAt < new Date()) {
      // Token expired - refresh it
      if (!oauthToken.refreshToken) {
        throw new Error('OAuth token expired and no refresh token available. Please reconnect your Google account.');
      }

      logger.info('Refreshing expired OAuth token', { userId, provider: 'google' });

      try {
        const auth = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );

        auth.setCredentials({
          refresh_token: decryptToken(oauthToken.refreshToken)
        });

        // Refresh the token
        const { credentials } = await auth.refreshAccessToken();

        if (!credentials.access_token) {
          throw new Error('Failed to refresh access token');
        }

        // Update database with new token
        const { encryptToken } = await import('../utils/encryption');
        await prisma.oAuthToken.update({
          where: { id: oauthToken.id },
          data: {
            accessToken: encryptToken(credentials.access_token),
            expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
            updatedAt: new Date()
          }
        });

        logger.info('OAuth token refreshed successfully', { userId, provider: 'google' });

        return {
          access_token: credentials.access_token,
          refresh_token: decryptToken(oauthToken.refreshToken)
        };
      } catch (refreshError) {
        logger.error('Failed to refresh OAuth token', {
          userId,
          provider: 'google',
          error: (refreshError as Error).message
        });
        throw new Error('Failed to refresh OAuth token. Please reconnect your Google account.');
      }
    }

    return {
      access_token: decryptToken(oauthToken.accessToken),
      refresh_token: oauthToken.refreshToken
        ? decryptToken(oauthToken.refreshToken)
        : null
    };
  }

  /**
   * Get authenticated Google Calendar client
   */
  private async getCalendarClient(tokens: GoogleOAuthCredentials): Promise<Calendar> {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token
    });

    return google.calendar({ version: 'v3', auth });
  }

  /**
   * Parse natural language date/time to Date object
   */
  private parseDateTime(input: string): Date {
    // Use chrono-node for natural language parsing
    const parsed = chrono.parseDate(input);

    if (!parsed) {
      // Fallback to Date constructor
      const date = new Date(input);
      if (isNaN(date.getTime())) {
        throw new Error(`Could not parse date/time: "${input}"`);
      }
      return date;
    }

    return parsed;
  }
}
