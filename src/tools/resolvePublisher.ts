import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { resolveRelaysOrError } from './relaySelection.js';
import { eventsToAMBResources } from '../utils/transform.js';
import { READ_ONLY } from './annotations.js';

/**
 * A metadata-actor spelling observed in the corpus. `field` says where the
 * name appeared (AMB publisher vs creator), `count` on how many sampled
 * resources.
 */
export interface ActorCandidate {
  name: string;
  field: 'publisher' | 'creator';
  count: number;
}

interface ActorNamedResource {
  publisher?: Array<{ name: string }>;
  creator?: Array<{ name: string }>;
}

/**
 * Aggregate distinct publisher/creator names across resources. Case variants
 * of the same name are merged (the metadata filters match case-insensitively)
 * under the first-seen spelling.
 */
export function aggregateActorNames(resources: ActorNamedResource[]): ActorCandidate[] {
  const byKey = new Map<string, ActorCandidate>();
  for (const resource of resources) {
    for (const field of ['publisher', 'creator'] as const) {
      for (const entity of resource[field] ?? []) {
        if (!entity.name) continue;
        const key = `${field}:${entity.name.toLowerCase()}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.count++;
        } else {
          byKey.set(key, { name: entity.name, field, count: 1 });
        }
      }
    }
  }
  return [...byKey.values()];
}

/** Lowercase and strip everything but letters/digits, so "LEHRE LADEN",
 * "Lehreladen" and "lehre-laden" all normalize to the same key. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Keep only candidates plausibly meaning the queried actor, best first:
 * exact normalized match, then substring match (either direction). Unrelated
 * names are dropped — a frequent-but-different publisher in the sample must
 * not be suggested as "did you mean".
 */
export function rankActorCandidates(query: string, candidates: ActorCandidate[]): ActorCandidate[] {
  const q = normalizeName(query);
  if (!q) return [];
  const score = (c: ActorCandidate): number => {
    const n = normalizeName(c.name);
    if (n === q) return 2;
    if (n.includes(q) || q.includes(n)) return 1;
    return 0;
  };
  return candidates
    .map((c) => ({ c, s: score(c) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || b.c.count - a.c.count)
    .map(({ c }) => c);
}

/** How many search hits to sample when aggregating actor spellings. */
const SAMPLE_LIMIT = 50;
/** Cap on returned candidates. */
const MAX_CANDIDATES = 5;

/**
 * Resolve an actor name to the canonical spellings the corpus actually uses:
 * free-text search the name, aggregate publisher/creator names over the hits,
 * return the ones similar to the query. Used by the resolve_publisher tool
 * and by search_resources' did-you-mean fallback on zero filter matches.
 */
export async function findActorCandidates(
  client: Pick<AMBRelayClient, 'search'>,
  name: string,
  relays?: string[]
): Promise<ActorCandidate[]> {
  const events = await client.search(name, { limit: SAMPLE_LIMIT }, relays);
  const resources = eventsToAMBResources(events).map((r) => r.resource);
  return rankActorCandidates(name, aggregateActorNames(resources)).slice(0, MAX_CANDIDATES);
}

export function registerResolvePublisherTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'resolve_publisher',
    {
      title: 'Resolve Publisher/Creator Name to Canonical Metadata Spelling',
      description:
        'Resolve an actor name (organization or person) to the EXACT spelling used in ' +
        'the AMB metadata, so it can be passed to the publisherName/creatorName filters ' +
        'of search_resources. Those filters are exact full-string matches (case-' +
        'insensitive), so a guessed spelling like "Lehreladen" silently misses the ' +
        'stored "LEHRE LADEN". This tool free-text searches the name and returns the ' +
        'similar publisher/creator names found in the corpus, with the field they ' +
        'appear in and a resource count. Distinct from resolve_author, which resolves ' +
        'Nostr signing accounts (kind-0 profiles) to pubkeys — metadata publishers ' +
        'usually have no Nostr account at all.',
      inputSchema: {
        name: z
          .string()
          .describe('Actor name as the user said it (e.g. "Lehreladen").'),
        relays: z
          .array(z.string())
          .optional()
          .describe(
            'Restrict the lookup to specific relays. Only relays returned by list_relays ' +
              '(default or extra) are accepted, by full URL or short name (e.g. "oersi", "sodix"). ' +
              'Default: the default relay set.'
          ),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      const selection = resolveRelaysOrError(client, params.relays);
      if ('errorPayload' in selection) {
        return { content: [{ type: 'text', text: JSON.stringify(selection.errorPayload) }] };
      }
      const candidates = await findActorCandidates(client, params.name, selection.relays);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query: params.name,
              relaysSearched: selection.relays,
              total: candidates.length,
              candidates,
              note:
                candidates.length > 0
                  ? 'Pass a candidate name verbatim as publisherName or creatorName to search_resources.'
                  : 'No similar publisher/creator name found in sampled resources. The actor may not exist in this corpus, or may only appear as a Nostr author — try resolve_author.',
            }),
          },
        ],
      };
    }
  );
}
