import type { McpServer } from '@modelcontextprotocol/server';
import type { AMBRelayClient } from '../relay/client.js';

/**
 * Relay info resource - provides NIP-11 relay information for all connected relays
 */
export function registerRelayInfoResource(
  server: McpServer,
  client: AMBRelayClient
): void {
  server.registerResource(
    'Relay Information',
    'amb://relay-info',
    {
      description:
        'NIP-11 relay information for all connected AMB relays, including supported NIPs and relay metadata.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const relayInfoMap = await client.getRelayInfo();
        const relays = client.getRelays();

        const relayInfos = relays.map((url) => {
          const info = relayInfoMap.get(url);
          if (info) {
            return {
              url,
              name: info.name,
              description: info.description,
              pubkey: info.pubkey,
              contact: info.contact,
              supported_nips: info.supported_nips,
              software: info.software,
              version: info.version,
              capabilities: {
                nip01: 'Basic protocol support',
                nip11: 'Relay information document',
                nip50: info.supported_nips?.includes(50)
                  ? 'Full-text search supported'
                  : 'Not supported',
              },
            };
          }
          return {
            url,
            error: 'Failed to fetch relay information',
          };
        });

        return {
          contents: [
            {
              uri: 'amb://relay-info',
              mimeType: 'application/json',
              text: JSON.stringify({ relays: relayInfos }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: 'amb://relay-info',
              mimeType: 'application/json',
              text: JSON.stringify({
                error: 'Failed to fetch relay information',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}
