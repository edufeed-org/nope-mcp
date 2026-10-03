import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { READ_ONLY } from './annotations.js';

/**
 * NIP-11 stats for every selectable relay, each marked as default or extra so
 * a per-call-only relay is visibly alive rather than silently absent.
 */
export async function runRelayStats(
  client: Pick<AMBRelayClient, 'getRelayInfo' | 'getRelays' | 'getExtraRelays'>
): Promise<{ relays: Array<Record<string, unknown>>; count: number }> {
  const relayInfoMap = await client.getRelayInfo();
  const urls: Array<[string, 'default' | 'extra']> = [
    ...client.getRelays().map((u): [string, 'default'] => [u, 'default']),
    ...client.getExtraRelays().map((u): [string, 'extra'] => [u, 'extra']),
  ];

  const relayStats = urls.map(([url, role]) => {
    const info = relayInfoMap.get(url);
    if (info) {
      return {
        url,
        role,
        name: info.name,
        description: info.description,
        pubkey: info.pubkey,
        contact: info.contact,
        supportedNips: info.supported_nips,
        software: info.software,
        version: info.version,
      };
    }
    return {
      url,
      role,
      error: 'Failed to fetch relay info',
    };
  });

  return { relays: relayStats, count: urls.length };
}

/**
 * Register the relay_stats tool
 */
export function registerStatsTool(
  server: McpServer,
  client: AMBRelayClient
): void {
  server.registerTool(
    'relay_stats',
    {
      title: 'Relay Statistics',
      description:
        'Get information about all selectable AMB relays (default and extra), including supported NIPs, relay name, and description.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const out = await runRelayStats(client);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(out, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to fetch relay info',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}
