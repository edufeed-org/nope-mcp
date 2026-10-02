import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { transformProfileEvent, type ProfileResult } from '../profiles/transform.js';
import { READ_ONLY } from './annotations.js';

/**
 * Resolve a name against the relay's kind-0 profile index: search, transform
 * each result (dropping non-kind-0 / unparseable events), preserve relay
 * relevance order.
 */
export async function resolveAuthor(
  client: Pick<AMBRelayClient, 'searchProfiles'>,
  params: { name: string; limit?: number }
): Promise<{ total: number; candidates: ProfileResult[] }> {
  const events = await client.searchProfiles(params.name, params.limit);
  const candidates: ProfileResult[] = [];
  for (const e of events) {
    const c = transformProfileEvent(e);
    if (c) candidates.push(c);
  }
  return { total: candidates.length, candidates };
}

export function registerResolveAuthorTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'resolve_author',
    {
      title: 'Resolve Author Name to Pubkey',
      description:
        'Resolve an org or person NAME to candidate pubkeys using the relay\'s ' +
        'kind-0 author-profile index (NIP-50 search). Use this to answer ' +
        'name-driven content questions like "recent articles and resources of ' +
        'Jörg Lohrer": call resolve_author(name), pick the best candidate, then ' +
        'pass its pubkey to search_content({ authors: [pubkey], ... }) (and/or ' +
        'search_calendar_events) to fetch that author\'s content. Returns several ' +
        'candidates ranked by relevance so you can disambiguate. This indexes ' +
        'authors who have published content here — distinct from list_known_authors, ' +
        'which lists hand-curated follow sets. NOTE: this resolves only kind-0 ' +
        'author profiles. It does NOT resolve a community\'s identifying pubkey — a ' +
        'community is defined by a kind-10222 event and frequently has no kind-0 at ' +
        'all. To list content shared into a community you need that community pubkey ' +
        '(a Nostr identifier, e.g. from the community\'s spec/naddr), which you pass ' +
        'to the `community` param of search_content / search_calendar_events. ' +
        'resolve_author CAN, however, find a community\'s posting account (e.g. a ' +
        '"…-Termine-Bot") when that account has a kind-0; querying that pubkey via ' +
        'authors:[...] returns the content it published. A wrong pick simply yields ' +
        'empty results.',
      inputSchema: {
        name: z.string().describe('Org or person name to resolve (e.g. "Jörg Lohrer").'),
        limit: z
          .number()
          .min(1)
          .max(25)
          .optional()
          .default(10)
          .describe('Max candidates (1-25, default 10).'),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      const out = await resolveAuthor(client, { name: params.name, limit: params.limit });
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
  );
}
