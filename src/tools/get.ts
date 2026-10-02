import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { resolveRelaysOrError } from './relaySelection.js';
import type { NostrEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { eventToAMBResource, toSimplifiedResource } from '../utils/transform.js';
import { hasContentTransform, transformContentEvent } from '../content/transform.js';
import { READ_ONLY } from './annotations.js';

/** Decode an naddr into a d-tag + author + kind for getByDTag; null on malformed/non-naddr input. */
export function naddrToLookup(
  naddr: string
): { identifier: string; author: string; kind: number } | null {
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== 'naddr') return null;
    return {
      identifier: decoded.data.identifier,
      author: decoded.data.pubkey,
      kind: decoded.data.kind,
    };
  } catch {
    return null;
  }
}

/** The minimal client surface runGetResource needs — mirrors runContentSearch's Pick<...> pattern. */
interface GetClient {
  getByDTag(
    dTag: string,
    author?: string,
    kinds?: number[],
    relays?: string[]
  ): Promise<NostrEvent | null>;
  getById(eventId: string, kinds?: number[], relays?: string[]): Promise<NostrEvent | null>;
}

/** The pre-existing 30142 formatting, byte-identical in behavior. */
function formatAMB(event: NostrEvent | null, lang: string): Record<string, unknown> {
  if (!event) return { resource: null, message: 'Resource not found' };
  const ambResource = eventToAMBResource(event);
  if (!ambResource) {
    return {
      resource: null,
      message: 'Failed to parse resource',
      rawEvent: { id: event.id, pubkey: event.pubkey, created_at: event.created_at },
    };
  }
  return { resource: toSimplifiedResource(ambResource, lang) };
}

export async function runGetResource(
  client: GetClient,
  params: {
    identifier?: string;
    author?: string;
    eventId?: string;
    naddr?: string;
    language?: string;
    relays?: string[];
  }
): Promise<Record<string, unknown>> {
  if (!params.identifier && !params.eventId && !params.naddr) {
    return { error: 'Either identifier, eventId, or naddr must be provided', resource: null };
  }
  const lang = params.language || 'de';

  // Priority order: eventId > naddr > identifier (restores pre-refactor behavior)
  if (params.eventId) {
    const event = await client.getById(params.eventId, undefined, params.relays);
    return formatAMB(event, lang);
  }

  if (params.naddr) {
    const lookup = naddrToLookup(params.naddr);
    if (!lookup) return { error: 'Invalid naddr', resource: null };
    if (lookup.kind !== 30142) {
      if (!hasContentTransform(lookup.kind)) {
        const hint = [31922, 31923, 31924, 31925].includes(lookup.kind)
          ? ' For calendar events use search_calendar_events.'
          : '';
        return { error: `naddr kind ${lookup.kind} cannot be resolved by get_resource on this server.${hint}`, resource: null };
      }
      const event = await client.getByDTag(
        lookup.identifier,
        lookup.author,
        [lookup.kind],
        params.relays
      );
      if (!event) return { resource: null, message: 'Resource not found' };
      const result = transformContentEvent(event, lang);
      if (!result) return { resource: null, message: 'Failed to parse resource' };
      return { resource: result };
    }
    // 30142 falls through to the existing full-AMB path below.
    const event = await client.getByDTag(
      lookup.identifier,
      lookup.author,
      undefined,
      params.relays
    );
    return formatAMB(event, lang);
  }

  const event = await client.getByDTag(
    params.identifier!,
    params.author,
    undefined,
    params.relays
  );
  return formatAMB(event, lang);
}

/**
 * Register the get_resource tool
 */
export function registerGetTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'get_resource',
    {
      title: 'Get Educational Resource',
      description:
        'Retrieve a single piece of content by naddr (preferred — pass a ' +
        'search_content result\'s naddr), d-tag identifier, or event ID. naddrs of ANY ' +
        'content type from search_content work (resources, articles, wikis, projects, ' +
        'measures, publications); non-resource kinds return the same shape as their ' +
        'search results. Bare identifier/eventId lookups (no naddr) always resolve the ' +
        'full educational-resource metadata (kind 30142), including creator/publisher ' +
        'and educational properties. ' +
        'When presenting the resource, render a markdown link the user can open: prefer ' +
        'its sourcePage (the original source page); fall back to url (the edufeed viewer) ' +
        'only when sourcePage is absent.',
      inputSchema: {
        identifier: z
          .string()
          .optional()
          .describe('Resource identifier (d-tag). Use this for stable lookups.'),
        author: z
          .string()
          .optional()
          .describe('Author pubkey (hex) to disambiguate if multiple resources share the same identifier'),
        eventId: z
          .string()
          .optional()
          .describe('Nostr event ID (hex) for direct lookup. Alternative to identifier.'),
        naddr: z
          .string()
          .optional()
          .describe('NIP-19 naddr from a search result — the preferred handoff to fetch full metadata.'),
        language: z
          .string()
          .optional()
          .default('de')
          .describe('Preferred language for labels (default: "de")'),
        relays: z
          .array(z.string())
          .optional()
          .describe(
            'Restrict the lookup to specific relays — pass the relays a search found the ' +
              'result on. Only relays returned by list_relays (default or extra) are ' +
              'accepted, by full URL or short name (e.g. "oersi"). Default: the default relay set.'
          ),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      const selection = resolveRelaysOrError(client, params.relays);
      if ('errorPayload' in selection) {
        return { content: [{ type: 'text', text: JSON.stringify(selection.errorPayload) }] };
      }
      const payload = await runGetResource(client, { ...params, relays: selection.relays });
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
  );
}
