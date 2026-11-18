import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
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
import { registerFindCommunityTool } from './findCommunity.js';
import type { IndexerClient } from '../indexer/client.js';
import type { LicenseFilter } from '../license/classify.js';

export interface ToolProfile {
  read?: boolean;
  extract?: boolean;
  write?: boolean;
}

/**
 * Advertise every tool's arguments as a closed object
 * (`additionalProperties: false`, as the zod 3 conversion did) while unknown
 * arguments are still dropped instead of failing the call. Patches
 * `registerTool` (like instrumentToolLogging) so no tool can forget it.
 */
function closeToolInputs(server: McpServer): void {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, config: { inputSchema?: unknown }, cb: unknown) => {
    const input = config.inputSchema;
    if (input === undefined) return original(name, config, cb);
    // A raw shape ({ query: z.string() }) or an already built z.object(...)
    const schema = '~standard' in (input as object) ? (input as z.ZodType) : z.object(input as z.ZodRawShape);
    return original(name, { ...config, inputSchema: schema.meta({ additionalProperties: false }) }, cb);
  }) as unknown as McpServer['registerTool'];
}

/**
 * Tool profile for the Nostr (ContextVM) entry. Anyone with a key can call a
 * server on a public transport relay, so CVM_READ_ONLY=true leaves out the
 * extract tool (it spends the Anthropic key) and the write tools.
 */
export function nostrToolProfile(env: { CVM_READ_ONLY?: string }): ToolProfile {
  const readOnly = env.CVM_READ_ONLY === 'true';
  return { read: true, extract: !readOnly, write: !readOnly };
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
    /** Operator ceiling for search license filtering (LICENSE_FILTER_MAX, default any). */
    licenseFilterMax?: LicenseFilter;
    /** Community relay client (COMMUNITY_RELAYS); find_community registers only when set. */
    communityClient?: AMBRelayClient;
  },
): void {
  closeToolInputs(server);
  if (profile.read) {
    // Query / read tools
    const passagesAvailable = !!(options?.indexer && options?.spellClient);
    const licenseFilterMax = options?.licenseFilterMax ?? 'any';
    registerSearchTool(server, client, { licenseFilterMax });
    registerSearchContentTool(server, client, { passagesAvailable, licenseFilterMax });
    registerGetTool(server, client, { licenseFilterMax });
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
    if (options?.communityClient) registerFindCommunityTool(server, options.communityClient);
    if (options?.indexer && options?.spellClient) {
      registerSearchPassagesTool(server, client, options.spellClient, options.indexer, { licenseFilterMax });
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
