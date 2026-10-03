import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { getRelayListService } from '../signer/index.js';
import { getSignerManager } from './signer.js';
import { READ_ONLY, SESSION_MUTATOR } from './annotations.js';

/**
 * list_relays payload: relay groups plus, when extras exist, an explicit
 * usage note — LLM clients otherwise assume "configured ⇒ searched".
 *
 * defaultRelaysSource tells the client whose choice the default set is: the
 * server's own config, or the `relays` parameter of the URL this connector
 * was added with. Without it a model cannot tell a deliberately narrowed
 * session from the deployment's standard corpus.
 */
export function runListRelays(
  client: Pick<AMBRelayClient, 'getRelays' | 'getExtraRelays'>,
  options?: { defaultsFromConnectorUrl?: boolean }
): {
  defaultRelays: string[];
  extraRelays: string[];
  defaultRelaysSource: 'server-config' | 'connector-url';
  count: number;
  note?: string;
} {
  const defaultRelays = client.getRelays();
  const extraRelays = client.getExtraRelays();
  const notes: string[] = [];

  if (options?.defaultsFromConnectorUrl) {
    notes.push(
      'defaultRelays were chosen by the relays parameter of this connection URL, ' +
        'not by the server default.'
    );
  }
  if (extraRelays.length > 0) {
    notes.push(
      'extraRelays are NOT searched by default — they hold different corpora. ' +
        'To query one, pass it in the relays parameter of search_content, ' +
        'search_resources, or get_resource — by full URL or short name ' +
        '(the hostname or first label, e.g. "oersi", "sodix").'
    );
  }

  return {
    defaultRelays,
    extraRelays,
    defaultRelaysSource: options?.defaultsFromConnectorUrl
      ? 'connector-url'
      : 'server-config',
    count: defaultRelays.length + extraRelays.length,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

/**
 * Register the list_relays tool
 */
export function registerListRelaysTool(
  server: McpServer,
  client: AMBRelayClient,
  options?: { defaultsFromConnectorUrl?: boolean }
): void {
  server.registerTool(
    'list_relays',
    {
      title: 'List Relays',
      description:
        'List the configured AMB relays. defaultRelays are searched on every query; ' +
        'extraRelays hold different corpora (e.g. the OERSI aggregation) and are only ' +
        'searched when a search/get tool call passes them in its relays parameter.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(runListRelays(client, options), null, 2),
          },
        ],
      };
    }
  );
}

/**
 * Register the add_relay tool
 */
export function registerAddRelayTool(
  server: McpServer,
  client: AMBRelayClient
): void {
  server.registerTool(
    'add_relay',
    {
      title: 'Add Relay',
      description:
        'Add a new AMB relay to query. The relay will be used for subsequent queries. ' +
        'Distinct from the env-configured extra relays, which are selectable per call ' +
        'but never part of the default set.',
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe(
            'WebSocket URL of the relay to add (e.g., "wss://relay.example.com")'
          ),
      }),
      annotations: SESSION_MUTATOR,
    },
    async ({ url }) => {
      // Validate it's a websocket URL
      if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'URL must start with wss:// or ws://',
              }),
            },
          ],
        };
      }

      const relaysBefore = client.getRelays();
      if (relaysBefore.includes(url)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Relay already exists',
                url,
              }),
            },
          ],
        };
      }

      client.addRelay(url);

      // Test the connection
      const connectionTest = await client.testRelayConnection(url);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: connectionTest.ok
                  ? `Added relay: ${url}`
                  : `Added relay: ${url} (WARNING: connection test failed - ${connectionTest.error})`,
                relays: client.getRelays(),
                connectionTest: {
                  reachable: connectionTest.ok,
                  error: connectionTest.error,
                  relayInfo: connectionTest.info,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

/**
 * Register the remove_relay tool
 */
export function registerRemoveRelayTool(
  server: McpServer,
  client: AMBRelayClient
): void {
  server.registerTool(
    'remove_relay',
    {
      title: 'Remove Relay',
      description:
        'Remove an AMB relay from the query pool. Cannot remove the last relay. ' +
        'Env-configured extra relays cannot be removed here.',
      inputSchema: z.object({
        url: z.string().describe('URL of the relay to remove'),
      }),
      annotations: SESSION_MUTATOR,
    },
    async ({ url }) => {
      const relays = client.getRelays();

      if (relays.length <= 1) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Cannot remove the last relay',
                relays,
              }),
            },
          ],
        };
      }

      const removed = client.removeRelay(url);

      if (!removed) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Relay not found',
                url,
                relays,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Removed relay: ${url}`,
              relays: client.getRelays(),
            }),
          },
        ],
      };
    }
  );
}

/**
 * Extract user ID from MCP auth context
 */
function getUserId(extra: unknown): string {
  const authInfo = (extra as { authInfo?: { clientPubkey?: string } })?.authInfo;
  return authInfo?.clientPubkey ?? 'local';
}

/**
 * Register the relay_list_get tool
 *
 * Fetches a user's NIP-65 relay list (kind 10002).
 */
export function registerRelayListGetTool(
  server: McpServer,
  client: AMBRelayClient
): void {
  server.registerTool(
    'relay_list_get',
    {
      title: 'Get Relay List',
      description:
        'Get a user\'s NIP-65 relay list (kind 10002). ' +
        'Returns read and write relays for the specified pubkey. ' +
        'If no pubkey provided, uses the connected signer\'s pubkey.',
      inputSchema: {
        pubkey: z
          .string()
          .optional()
          .describe('Public key to fetch relay list for (defaults to connected signer)'),
      },
      annotations: READ_ONLY,
    },
    async (params, extra) => {
      try {
        let pubkey = params.pubkey;

        // If no pubkey provided, try to get from connected signer
        if (!pubkey) {
          const manager = getSignerManager();
          const userId = getUserId(extra);
          const signer = manager.getSigner(userId);

          if (signer) {
            pubkey = await signer.getPublicKey();
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'No pubkey specified and no signer connected',
                    message: 'Provide a pubkey or connect a signer first',
                  }),
                },
              ],
            };
          }
        }

        // Validate pubkey format
        if (pubkey.length !== 64) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Invalid pubkey',
                  message: 'Pubkey must be 64 hex characters',
                }),
              },
            ],
          };
        }

        // Fetch relay list
        const relayListService = getRelayListService();
        const relayList = await relayListService.getRelayList(
          pubkey,
          client.getRelays()
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  pubkey,
                  readRelays: relayList.readRelays,
                  writeRelays: relayList.writeRelays,
                  totalRead: relayList.readRelays.length,
                  totalWrite: relayList.writeRelays.length,
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
                error: 'Failed to fetch relay list',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}
