import { McpServer } from '@modelcontextprotocol/server';

import { AMBRelayClient } from './relay/client.js';
import { registerTools } from './tools/index.js';
import { instrumentToolLogging } from './tools/logging.js';
import { registerResources } from './resources/index.js';
import { SERVER_NAME, SERVER_VERSION, buildServerInstructions } from './server-info.js';
import type { IndexerClient } from './indexer/client.js';
import type { LicenseFilter } from './license/classify.js';

export interface SessionServer {
  server: McpServer;
  ambClient: AMBRelayClient;
  calendarClient: AMBRelayClient;
  dispose: () => void;
}

/**
 * Build a fresh MCP server with its own relay clients for a single session.
 *
 * Each call creates independent AMBRelayClient instances seeded from the given
 * defaults, so runtime relay changes (add_relay/remove_relay) made in one
 * session do not leak into any other session sharing the same process.
 */
export function buildSessionServer(
  ambRelays: string | string[],
  calendarRelays: string | string[],
  profile: import('./tools/index.js').ToolProfile = { read: true, extract: true, write: true },
  options?: {
    ambExtraRelays?: string[];
    defaultsFromConnectorUrl?: boolean;
    spellClient?: AMBRelayClient;
    indexer?: IndexerClient;
    licenseFilterMax?: LicenseFilter;
    communityClient?: AMBRelayClient;
    /**
     * Long-lived relay clients to use instead of creating a pair for this
     * server. The caller owns them: `dispose` leaves them open. Only for
     * servers without relay-mutating tools (profile.write off).
     */
    clients?: { ambClient: AMBRelayClient; calendarClient: AMBRelayClient };
  },
): SessionServer {
  const licenseFilterMax = options?.licenseFilterMax ?? 'any';
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildServerInstructions({ licenseFilterMax }) },
  );
  // Before registerTools: the patch only sees tools registered after it.
  instrumentToolLogging(server);
  const ambClient = options?.clients?.ambClient ?? new AMBRelayClient(ambRelays, {
    extraRelays: options?.ambExtraRelays,
  });
  const calendarClient = options?.clients?.calendarClient ?? new AMBRelayClient(calendarRelays);
  registerTools(server, ambClient, calendarClient, profile, {
    defaultsFromConnectorUrl: options?.defaultsFromConnectorUrl,
    spellClient: options?.spellClient,
    indexer: options?.indexer,
    licenseFilterMax,
    communityClient: options?.communityClient,
  });
  registerResources(server, ambClient);

  return {
    server,
    ambClient,
    calendarClient,
    dispose: () => {
      if (options?.clients) return;
      ambClient.close();
      calendarClient.close();
    },
  };
}
