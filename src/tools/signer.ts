/**
 * Signer MCP Tools
 *
 * Tools for managing NIP-46 signer connections.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SignerManager } from '../signer/index.js';
import { READ_ONLY, SESSION_MUTATOR } from './annotations.js';

// Default relays for NIP-46 communication
const DEFAULT_RELAYS = process.env.AMB_RELAYS?.split(',') || ['wss://relay.edufeed.org'];

// Singleton signer manager
let signerManager: SignerManager | null = null;

/**
 * Get or create the signer manager
 */
function getSignerManager(): SignerManager {
  if (!signerManager) {
    signerManager = new SignerManager(DEFAULT_RELAYS);
  }
  return signerManager;
}

/**
 * Extract user ID from MCP auth context
 * Falls back to 'local' for stdio transport
 */
function getUserId(extra: unknown): string {
  const authInfo = (extra as { authInfo?: { clientPubkey?: string } })?.authInfo;
  return authInfo?.clientPubkey ?? 'local';
}

/**
 * The caller's connected NIP-46 signer pubkey, if any — used by
 * search_passages to resolve $me when the transport itself is anonymous.
 */
export function getSessionPubkey(extra: unknown): string | null {
  const status = getSignerManager().getStatus(getUserId(extra));
  return status.connected && status.userPubkey ? status.userPubkey : null;
}

/**
 * Register signer_init tool
 *
 * Starts a connection flow by generating a QR code that can be scanned
 * by a bunker app (like Amber or nsecBunker).
 */
function registerSignerInitTool(server: McpServer): void {
  server.registerTool(
    'signer_init',
    {
      title: 'Initialize Signer Connection',
      description:
        'Generate a QR code for connecting a signer app. ' +
        'Scan with Amber, nsecBunker, or another NIP-46 compatible bunker app.',
      inputSchema: {
        relays: z
          .array(z.string())
          .optional()
          .describe('Relays for NIP-46 communication (defaults to AMB relays)'),
        name: z
          .string()
          .optional()
          .describe('Client name shown in the bunker app'),
        permissions: z
          .array(z.string())
          .optional()
          .describe('Requested permissions (e.g., ["sign_event:0", "sign_event:30142"])'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const manager = getSignerManager();
        const userId = getUserId(extra);

        const result = await manager.initConnection(userId, {
          relays: params.relays,
          name: params.name,
          permissions: params.permissions,
        });

        return {
          content: [
            {
              type: 'text',
              text: '📱 Scan this QR code with your signer app (Amber, nsecBunker, etc.):\n\n' +
                '```\n' + result.qrCode + '```\n',
            },
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  sessionId: result.sessionId,
                  nostrconnectUrl: result.nostrconnectUrl,
                  nextStep: 'Connection happens automatically. Use signer_status to check if connected.',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to initialize connection',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register signer_await tool
 *
 * Waits for a bunker to connect after scanning the QR code.
 * Note: This is not yet fully implemented.
 */
function registerSignerAwaitTool(server: McpServer): void {
  server.registerTool(
    'signer_await',
    {
      title: 'Await Signer Connection',
      description:
        'Wait for the bunker app to connect after scanning the QR code. ' +
        'Note: This is optional - connections are handled automatically in the background. ' +
        'Use signer_status to check connection status.',
      inputSchema: {
        sessionId: z
          .string()
          .optional()
          .describe('Session ID from signer_init (optional if only one pending)'),
        timeout: z
          .number()
          .optional()
          .describe('Timeout in seconds (default: 120)'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const manager = getSignerManager();
        const userId = getUserId(extra);
        const timeout = (params.timeout || 120) * 1000;

        const userPubkey = await manager.awaitConnection(
          userId,
          params.sessionId || '',
          timeout
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Connected to signer',
                  userPubkey,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to await connection',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register signer_connect tool
 *
 * Connect directly using a bunker URL or private key.
 */
function registerSignerConnectTool(server: McpServer): void {
  server.registerTool(
    'signer_connect',
    {
      title: 'Connect Signer',
      description:
        'Connect to a signer using a bunker:// URL or private key (for development). ' +
        'Note: For development, use nsec with allowInsecure=true.',
      inputSchema: {
        bunkerUrl: z
          .string()
          .optional()
          .describe('bunker:// URL from your signer app'),
        nsec: z
          .string()
          .optional()
          .describe('Private key (nsec or hex) - FOR DEVELOPMENT ONLY'),
        allowInsecure: z
          .boolean()
          .optional()
          .describe('Allow insecure connection with private key (required for nsec)'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const manager = getSignerManager();
        const userId = getUserId(extra);

        let userPubkey: string;

        if (params.nsec) {
          // Development mode with private key
          if (!params.allowInsecure) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'Insecure mode not allowed',
                    message:
                      'Using a private key requires allowInsecure=true. ' +
                      'This should only be used for development/testing.',
                  }),
                },
              ],
            };
          }

          userPubkey = await manager.connectWithKey(userId, params.nsec);
        } else if (params.bunkerUrl) {
          // Bunker URL mode
          userPubkey = await manager.connect(userId, params.bunkerUrl);
        } else {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Missing connection parameters',
                  message: 'Provide either bunkerUrl or nsec (with allowInsecure=true)',
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Signer connected',
                  userPubkey,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to connect signer',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register signer_disconnect tool
 */
function registerSignerDisconnectTool(server: McpServer): void {
  server.registerTool(
    'signer_disconnect',
    {
      title: 'Disconnect Signer',
      description: 'Disconnect the current signer session.',
      inputSchema: {},
      annotations: SESSION_MUTATOR,
    },
    async (_params, extra) => {
      try {
        const manager = getSignerManager();
        const userId = getUserId(extra);

        const disconnected = await manager.disconnect(userId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: disconnected,
                  message: disconnected
                    ? 'Signer disconnected'
                    : 'No active signer connection',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to disconnect signer',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register signer_status tool
 */
function registerSignerStatusTool(server: McpServer): void {
  server.registerTool(
    'signer_status',
    {
      title: 'Signer Status',
      description: 'Check the current signer connection status.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async (_params, extra) => {
      try {
        const manager = getSignerManager();
        const userId = getUserId(extra);

        const status = manager.getStatus(userId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  connected: status.connected,
                  userPubkey: status.userPubkey,
                  connectedAt: status.connectedAt
                    ? new Date(status.connectedAt).toISOString()
                    : undefined,
                  pendingConnection: status.pendingConnection,
                  pendingSessionId: status.pendingSessionId,
                  message: status.connected
                    ? 'Signer connected'
                    : status.pendingConnection
                      ? 'Waiting for bunker to connect (scan QR code)'
                      : 'No signer connected',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to get signer status',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register all signer tools
 */
export function registerSignerTools(server: McpServer): void {
  registerSignerInitTool(server);
  registerSignerAwaitTool(server);
  registerSignerConnectTool(server);
  registerSignerDisconnectTool(server);
  registerSignerStatusTool(server);
}

/**
 * Get the signer manager (for use by publish tools)
 */
export { getSignerManager };
