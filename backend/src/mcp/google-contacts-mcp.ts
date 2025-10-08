/**
 * Google Contacts MCP Client
 *
 * Implements MCP protocol for Google Contacts (People API) operations
 * Supports contact search, retrieval, and listing
 *
 * Dependencies:
 * - googleapis: https://github.com/googleapis/google-api-nodejs-client
 * - @prisma/client: Database ORM
 *
 * Input: userId, tool name, tool arguments
 * Output: MCPToolCallResult with contact data
 *
 * Example:
 * const result = await googleContactsMCP.executeTool(userId, 'search_contacts', { query: 'John' });
 */

import { google, people_v1 } from 'googleapis';
import { PrismaClient } from '@prisma/client';
import { decryptToken, encryptToken } from '../utils/encryption';
import logger from '../utils/logger';
import { MCPTool, MCPToolCallResult, RiskLevel } from './types';

// Type aliases for clarity
type PeopleAPI = people_v1.People;
type Person = people_v1.Schema$Person;
type GoogleOAuthCredentials = {
  access_token: string;
  refresh_token?: string | null;
};

const prisma = new PrismaClient();

export class GoogleContactsMCP {
  private tools: MCPTool[] = [
    {
      name: 'search_contacts',
      description: 'Search contacts by name, email, or phone number',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (name, email, or phone number)'
          },
          maxResults: {
            type: 'string',
            description: 'Maximum number of results to return (default: 10)'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'get_contact',
      description: 'Get detailed information about a specific contact',
      inputSchema: {
        type: 'object',
        properties: {
          resourceName: {
            type: 'string',
            description: 'Contact resource name (e.g., "people/c1234567890")'
          }
        },
        required: ['resourceName']
      }
    },
    {
      name: 'list_contacts',
      description: 'List all contacts (paginated)',
      inputSchema: {
        type: 'object',
        properties: {
          maxResults: {
            type: 'string',
            description: 'Maximum number of contacts to return (default: 50, max: 1000)'
          },
          pageToken: {
            type: 'string',
            description: 'Page token for pagination (optional)'
          }
        },
        required: []
      }
    }
  ];

  /**
   * Tool discovery - returns available tools
   */
  async discoverTools(): Promise<MCPTool[]> {
    logger.info('Google Contacts MCP: Tool discovery requested');
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
    logger.info('Executing Google Contacts tool', { toolName, userId });

    try {
      // Get user's OAuth tokens
      const tokens = await this.getTokens(userId);
      const peopleAPI = await this.getPeopleClient(tokens);

      switch (toolName) {
        case 'search_contacts':
          return await this.searchContacts(peopleAPI, args);

        case 'get_contact':
          return await this.getContact(peopleAPI, args);

        case 'list_contacts':
          return await this.listContacts(peopleAPI, args);

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (error) {
      logger.error('Google Contacts tool execution failed', {
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
      'search_contacts': RiskLevel.SAFE,    // Read-only
      'get_contact': RiskLevel.SAFE,        // Read-only
      'list_contacts': RiskLevel.SAFE       // Read-only
    };

    return riskMap[toolName] ?? RiskLevel.SAFE;
  }

  /**
   * Search contacts by query
   */
  private async searchContacts(
    peopleAPI: PeopleAPI,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    const { query, maxResults = '10' } = args;

    logger.info('Searching contacts', { query, maxResults });

    const response = await peopleAPI.people.searchContacts({
      query: query as string,
      pageSize: parseInt(maxResults as string, 10),
      readMask: 'names,emailAddresses,phoneNumbers,organizations,photos'
    });

    const contacts = (response.data.results || []).map(result => {
      const person = result.person;
      return this.formatContact(person);
    });

    logger.info('Contacts search completed', {
      query,
      resultsCount: contacts.length
    });

    return {
      success: true,
      data: {
        contacts,
        count: contacts.length
      }
    };
  }

  /**
   * Get specific contact by resource name
   */
  private async getContact(
    peopleAPI: PeopleAPI,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    const { resourceName } = args;

    logger.info('Getting contact', { resourceName });

    const response = await peopleAPI.people.get({
      resourceName: resourceName as string,
      personFields: 'names,emailAddresses,phoneNumbers,addresses,organizations,birthdays,photos,biographies'
    });

    const contact = this.formatContact(response.data);

    logger.info('Contact retrieved', { resourceName });

    return {
      success: true,
      data: contact
    };
  }

  /**
   * List all contacts (paginated)
   */
  private async listContacts(
    peopleAPI: PeopleAPI,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    const { maxResults = '50', pageToken } = args;

    logger.info('Listing contacts', { maxResults, pageToken });

    const response = await peopleAPI.people.connections.list({
      resourceName: 'people/me',
      pageSize: parseInt(maxResults as string, 10),
      pageToken: pageToken as string | undefined,
      personFields: 'names,emailAddresses,phoneNumbers,organizations,photos'
    });

    const contacts = (response.data.connections || []).map(person => {
      return this.formatContact(person);
    });

    logger.info('Contacts listed', {
      resultsCount: contacts.length,
      nextPageToken: response.data.nextPageToken
    });

    return {
      success: true,
      data: {
        contacts,
        count: contacts.length,
        nextPageToken: response.data.nextPageToken
      }
    };
  }

  /**
   * Format contact data for consistent output
   */
  private formatContact(person: Person | undefined): Record<string, unknown> {
    if (!person) {
      return {};
    }

    const primaryName = person.names?.[0];
    const primaryEmail = person.emailAddresses?.find(e => e.metadata?.primary)
      || person.emailAddresses?.[0];
    const primaryPhone = person.phoneNumbers?.find(p => p.metadata?.primary)
      || person.phoneNumbers?.[0];
    const primaryOrg = person.organizations?.[0];
    const primaryPhoto = person.photos?.[0];

    return {
      resourceName: person.resourceName,
      name: primaryName?.displayName || '',
      givenName: primaryName?.givenName || '',
      familyName: primaryName?.familyName || '',
      email: primaryEmail?.value || '',
      phone: primaryPhone?.value || '',
      organization: primaryOrg?.name || '',
      jobTitle: primaryOrg?.title || '',
      photoUrl: primaryPhoto?.url || '',
      allEmails: person.emailAddresses?.map(e => e.value) || [],
      allPhones: person.phoneNumbers?.map(p => p.value) || []
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
      throw new Error('Google Contacts not connected. Please connect your Google account first.');
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

        const { credentials } = await auth.refreshAccessToken();

        if (!credentials.access_token) {
          throw new Error('Failed to refresh access token');
        }

        // Update tokens in database
        const encryptedAccessToken = encryptToken(credentials.access_token);
        const expiresAt = credentials.expiry_date
          ? new Date(credentials.expiry_date)
          : new Date(Date.now() + 3600 * 1000);

        await prisma.oAuthToken.update({
          where: {
            userId_provider: {
              userId,
              provider: 'google'
            }
          },
          data: {
            accessToken: encryptedAccessToken,
            expiresAt,
            updatedAt: new Date()
          }
        });

        logger.info('OAuth token refreshed successfully', { userId, provider: 'google' });

        return {
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token || undefined
        };

      } catch (refreshError) {
        logger.error('Failed to refresh OAuth token', {
          userId,
          error: (refreshError as Error).message
        });
        throw new Error('Failed to refresh OAuth token. Please reconnect your Google account.');
      }
    }

    // Token still valid - decrypt and return
    const accessToken = decryptToken(oauthToken.accessToken);
    const refreshToken = oauthToken.refreshToken
      ? decryptToken(oauthToken.refreshToken)
      : undefined;

    return {
      access_token: accessToken,
      refresh_token: refreshToken
    };
  }

  /**
   * Create Google People API client
   */
  private async getPeopleClient(credentials: GoogleOAuthCredentials): Promise<PeopleAPI> {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token
    });

    return google.people({
      version: 'v1',
      auth
    });
  }
}

// Module validation function
if (require.main === module) {
  async function validateModule() {
    const failures: string[] = [];
    let totalTests = 0;

    // Test 1: Tool discovery
    totalTests++;
    try {
      const mcp = new GoogleContactsMCP();
      const tools = await mcp.discoverTools();
      if (!tools || tools.length === 0) {
        failures.push('Tool discovery: No tools returned');
      }
      if (!tools.some(t => t.name === 'search_contacts')) {
        failures.push('Tool discovery: Missing search_contacts tool');
      }
      console.log(`✓ Tool discovery returned ${tools.length} tools`);
    } catch (error) {
      failures.push(`Tool discovery: ${(error as Error).message}`);
    }

    // Test 2: Get specific tool
    totalTests++;
    try {
      const mcp = new GoogleContactsMCP();
      const tool = mcp.getTool('search_contacts');
      if (!tool) {
        failures.push('Get tool: search_contacts tool not found');
      }
      if (tool && tool.name !== 'search_contacts') {
        failures.push('Get tool: Wrong tool returned');
      }
      console.log('✓ Get tool successful');
    } catch (error) {
      failures.push(`Get tool: ${(error as Error).message}`);
    }

    // Test 3: Risk level validation
    totalTests++;
    try {
      const mcp = new GoogleContactsMCP();
      const riskLevel = mcp.getToolRiskLevel('search_contacts');
      if (riskLevel !== RiskLevel.SAFE) {
        failures.push(`Risk level: Expected SAFE, got ${riskLevel}`);
      }
      console.log('✓ Risk level validation successful');
    } catch (error) {
      failures.push(`Risk level: ${(error as Error).message}`);
    }

    // Report results
    if (failures.length > 0) {
      console.error(`\n❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
      failures.forEach(f => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log(`\n✅ VALIDATION PASSED - All ${totalTests} tests successful`);
      process.exit(0);
    }
  }

  validateModule().catch(error => {
    console.error('Validation error:', error);
    process.exit(1);
  });
}
