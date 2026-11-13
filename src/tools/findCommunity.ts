import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AMBRelayClient } from '../relay/client.js';
import { parseCommunity, type Community } from '../community/parse.js';
import { lexicalScore, tokenize } from '../content/rank.js';
import { READ_ONLY } from './annotations.js';
import { newRelayDiagnostics, relayDiagnosticsFields } from './relaySelection.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

// In-memory per process: one community list shared by every session, since
// COMMUNITY_RELAYS is a single server-wide setting, not a per-session one.
let cachedCommunities: Community[] = [];
let cachedAt = 0;
let pendingFirstFetch: Promise<Community[]> | null = null;
let refreshing = false;
// Relays that did not fully answer the fetch behind the current cache (or the latest refresh).
let lastIncomplete: string[] = [];

/**
 * Fetch kind-10222 community definitions (the client keeps the newest per
 * pubkey — it's replaceable, as is kind 0), then (one batch query) their pubkeys' kind-0 profiles —
 * name/picture, and description's fallback, live there per the Communikey
 * spec, not on the 10222 itself.
 */
async function fetchCommunities(
  client: Pick<AMBRelayClient, 'queryEvents'>
): Promise<Community[]> {
  const diag = newRelayDiagnostics();
  const profileDiag = newRelayDiagnostics();
  const events = await client.queryEvents({ kinds: [10222], limit: 500 }, undefined, { diag });
  const pubkeys = events.map((e) => e.pubkey);
  // shortcut: one REQ with ≤500 authors, chunk into batches of 100 if a relay rejects large filters
  const profileEvents =
    pubkeys.length > 0
      ? await client.queryEvents({ kinds: [0], authors: pubkeys, limit: pubkeys.length }, undefined, { diag: profileDiag })
      : [];
  const profiles = new Map(profileEvents.map((e) => [e.pubkey, e]));
  lastIncomplete = [...new Set([...diag.timedOut, ...diag.unreachable, ...profileDiag.timedOut, ...profileDiag.unreachable])];

  return events.map((event) => parseCommunity(event, profiles.get(event.pubkey)));
}

/**
 * Stale-while-revalidate: the first call ever awaits the fetch; after that,
 * a stale cache is served immediately while a background refresh updates it
 * for the NEXT call (so one slow relay never blocks a request that already
 * has data to answer with).
 *
 * An empty result is never trusted over a good one: a first-ever fetch that
 * comes back empty (e.g. every relay down at startup) is NOT cached — the
 * next call retries from scratch — and a background refresh only overwrites
 * the cache when it found something with every relay answering, or when the
 * cache was already empty; an outage must not blank out 5 minutes of good data.
 */
async function getCommunities(
  client: Pick<AMBRelayClient, 'queryEvents'>
): Promise<Community[]> {
  if (cachedAt === 0) {
    pendingFirstFetch ??= fetchCommunities(client);
    let result: Community[];
    try {
      result = await pendingFirstFetch;
    } finally {
      pendingFirstFetch = null;
    }
    if (result.length > 0) {
      cachedCommunities = result;
      cachedAt = Date.now();
    }
    return result;
  }

  if (Date.now() - cachedAt > CACHE_TTL_MS && !refreshing) {
    refreshing = true;
    fetchCommunities(client)
      .then((communities) => {
        // A partial refresh (a relay failed) would drop that relay's communities.
        if (cachedCommunities.length === 0 || (communities.length > 0 && lastIncomplete.length === 0)) {
          cachedCommunities = communities;
        }
        cachedAt = Date.now();
      })
      .catch(() => {
        // Background refresh failure: keep serving the stale cache.
      })
      .finally(() => {
        refreshing = false;
      });
  }
  return cachedCommunities;
}

/** Test-only: clears the module-level cache between test cases. */
export function _resetCommunityCacheForTests(): void {
  cachedCommunities = [];
  cachedAt = 0;
  pendingFirstFetch = null;
  refreshing = false;
  lastIncomplete = [];
}

export async function findCommunities(
  client: Pick<AMBRelayClient, 'queryEvents'>,
  { query, limit = 5 }: { query: string; limit?: number }
): Promise<{ total: number; communities: Community[]; relaysIncomplete?: string[]; warning?: string }> {
  const all = await getCommunities(client);
  const tokens = new Set(tokenize(query));
  const matches = all
    .map((c) => ({ c, score: lexicalScore(tokens, { title: c.name, description: c.description }) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  const communities = matches.slice(0, limit).map(({ c }) => c);
  return {
    total: matches.length,
    communities,
    ...relayDiagnosticsFields({ timedOut: lastIncomplete, unreachable: [] }),
  };
}

export function registerFindCommunityTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'find_community',
    {
      title: 'Find Community',
      description:
        'Find Nostr communities (Communikey, kind 10222) matching a free-text topic — ' +
        'use for "welche Community/Gruppe beschäftigt sich mit …" questions. Each result\'s ' +
        '`pubkey` can be passed as the `community` parameter of search_content or ' +
        'search_calendar_events to scope a search to that community.',
      inputSchema: {
        query: z.string().max(500).describe('Free-text topic, e.g. "Religionspädagogik" or "e-teaching".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Max results (1-25), default 5.'),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      const result = await findCommunities(client, { query: params.query, limit: params.limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );
}
