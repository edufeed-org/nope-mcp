import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { registerSearchTool } from './search.js';
import { registerGetTool } from './get.js';
import {
  registerBrowseSubjectsTool,
  registerBrowseResourceTypesTool,
  registerBrowseEducationalLevelsTool,
} from './browse.js';
import { registerStatsTool } from './stats.js';
import {
  registerListRelaysTool,
  registerAddRelayTool,
  registerRemoveRelayTool,
  registerRelayListGetTool,
} from './relays.js';
import { registerSKOSTools } from './skos.js';
import { registerSKOSBuilderTools } from './skos-builder.js';
import { registerSignerTools } from './signer.js';
import { registerPublishTools } from './publish.js';
import { registerAuthorTools } from './authors.js';
import { registerResolveAuthorTool } from './resolveAuthor.js';
import { registerResolvePublisherTool } from './resolvePublisher.js';
import { registerCalendarTools } from './calendar.js';
import { registerExtractTool } from './extract.js';
import { registerSearchContentTool } from './searchContent.js';
import { registerSearchPassagesTool } from './searchPassages.js';
import type { IndexerClient } from '../indexer/client.js';

export interface ToolProfile {
  read?: boolean;
  extract?: boolean;
  write?: boolean;
}

/**
 * Register MCP tools with the server, filtered by the given profile.
 *
 * Defaults to the full toolset (read + extract + write) to preserve
 * existing behaviour for stdio callers.
 */
export function registerTools(
  server: McpServer,
  client: AMBRelayClient,
  calendarClient?: AMBRelayClient,
  profile: ToolProfile = { read: true, extract: true, write: true },
  options?: {
    defaultsFromConnectorUrl?: boolean;
    spellClient?: AMBRelayClient;
    indexer?: IndexerClient;
    /** Search results hold openly licensed resources only (OPEN_LICENSES_ONLY, default true). */
    openLicensesOnly?: boolean;
  },
): void {
  if (profile.read) {
    // Query / read tools
    const passagesAvailable = !!(options?.indexer && options?.spellClient);
    const openLicensesOnly = options?.openLicensesOnly ?? true;
    registerSearchTool(server, client, { openLicensesOnly });
    registerSearchContentTool(server, client, { passagesAvailable, openLicensesOnly });
    registerGetTool(server, client, { openLicensesOnly });
    registerBrowseSubjectsTool(server, client);
    registerBrowseResourceTypesTool(server, client);
    registerBrowseEducationalLevelsTool(server, client);
    registerStatsTool(server, client);
    registerListRelaysTool(server, client, options);
    registerRelayListGetTool(server, client);
    registerSKOSTools(server);
    registerAuthorTools(server);
    registerResolveAuthorTool(server, client);
    registerResolvePublisherTool(server, client);
    if (calendarClient) registerCalendarTools(server, calendarClient);
    if (options?.indexer && options?.spellClient) {
      registerSearchPassagesTool(server, client, options.spellClient, options.indexer, { openLicensesOnly });
    }
  }

  if (profile.extract) {
    // URL → form-prefill metadata extraction
    registerExtractTool(server);
  }

  if (profile.write) {
    // Mutating / signing tools — never exposed on the public HTTP endpoint.
    registerAddRelayTool(server, client);
    registerRemoveRelayTool(server, client);
    registerSKOSBuilderTools(server);
    registerSignerTools(server);
    registerPublishTools(server);
  }
}
