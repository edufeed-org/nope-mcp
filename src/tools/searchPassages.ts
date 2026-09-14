import { z } from 'zod';
import { nip19 } from 'nostr-tools';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AMBRelayClient, RelayUnreachableError } from '../relay/client.js';
import { IndexerClient, type PassageHit } from '../indexer/client.js';
import { SPELL_KIND, SpellError, type Spell } from '../spells/types.js';
import {
  parseSpellEvent, spellFromParams, spellToEventTemplate, type InlineScopeParams,
} from '../spells/parse.js';
import { resolveSpell } from '../spells/resolve.js';
import { buildScope } from '../spells/scope.js';
import { resolveRelaysOrError, relaysNotSearched } from './relaySelection.js';
import { getSessionPubkey } from './signer.js';
import { OVERFETCH_FACTOR, PASSAGE_ALPHA, selectPassages } from './passageSelection.js';

export interface FetchSpellResult {
  event: NostrEvent | null;
  /** Every relay actually queried (spell relays, then sanitized hints), for the not-found message. */
  triedRelays: string[];
}

export interface SearchPassagesDeps {
  /** REQ against the effective AMB relay (materialize path). */
  queryContentEvents: (f: Filter) => Promise<NostrEvent[]>;
  /** Fetch a kind-777 event by hex id (spell relays + sanitized hints). Null when absent. */
  fetchSpellEvent: (idHex: string, hintRelays: string[]) => Promise<FetchSpellResult>;
  /** Latest kind-3 p-tags for a pubkey ($contacts). */
  fetchContacts: (pubkeyHex: string) => Promise<string[]>;
  /** Scoped chunk search on the effective relay's indexer. */
  searchChunks: (relay: string, body: { q: string; k: number; filter: Record<string, unknown>; alpha?: number }) => Promise<{ hits: PassageHit[]; total: number }>;
  /** The effective relay URL for this call. */
  relay: string;
}

export interface SearchPassagesParams extends InlineScopeParams {
  question: string;
  spell?: string;
  me?: string;
  limit?: number;
}

function decodeSpellRef(v: string): { id: string; hints: string[] } {
  if (/^[0-9a-f]{64}$/.test(v)) return { id: v, hints: [] };
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(v);
  } catch {
    throw new SpellError('spell_not_found', `not a spell reference (expected nevent/note/hex id): ${v}`);
  }
  if (decoded.type === 'nevent') return { id: decoded.data.id, hints: decoded.data.relays ?? [] };
  if (decoded.type === 'note') return { id: decoded.data, hints: [] };
  throw new SpellError('spell_not_found', `not a spell reference (expected nevent/note/hex id): ${v}`);
}

export const MAX_HINT_RELAYS = 3;
export const CONTACTS_FALLBACK_RELAY = 'wss://purplepag.es';

/**
 * nevent relay hints are caller-controlled and would otherwise be handed
 * straight to a throwaway relay-client constructor — an unsanitized outbound
 * connection surface. Keep only wss:// URLs, capped at MAX_HINT_RELAYS.
 */
export function sanitizeHintRelays(hints: string[]): string[] {
  const safe: string[] = [];
  for (const h of hints) {
    if (safe.length >= MAX_HINT_RELAYS) break;
    let parsed: URL;
    try {
      parsed = new URL(h);
    } catch {
      continue;
    }
    if (parsed.protocol === 'wss:') safe.push(h);
  }
  return safe;
}

interface ThrowawayClient {
  queryEvents(filter: Filter): Promise<NostrEvent[]>;
  close(): void;
}
type ClientFactory = (relays: string[]) => ThrowawayClient;

/** Builds the `fetchSpellEvent` dep: spell relays first, then sanitized hints. */
export function makeFetchSpellEvent(
  spellClient: Pick<AMBRelayClient, 'queryEvents' | 'getRelays'>,
  makeHintClient: ClientFactory = (relays) => new AMBRelayClient(relays)
): (idHex: string, hints: string[]) => Promise<FetchSpellResult> {
  return async (idHex, hints) => {
    const filter = { ids: [idHex], kinds: [SPELL_KIND], limit: 1 };
    const spellRelays = spellClient.getRelays();
    const found = await spellClient.queryEvents(filter);
    if (found.length > 0) return { event: found[0], triedRelays: spellRelays };

    const safeHints = sanitizeHintRelays(hints);
    const triedRelays = [...spellRelays, ...safeHints];
    if (safeHints.length > 0) {
      const hintClient = makeHintClient(safeHints);
      try {
        const viaHints = await hintClient.queryEvents(filter);
        if (viaHints.length > 0) return { event: viaHints[0], triedRelays };
      } finally {
        hintClient.close();
      }
    }
    return { event: null, triedRelays };
  };
}

/** Builds the `fetchContacts` dep: SPELL_RELAYS, falling back to purplepag.es when empty. */
export function makeFetchContacts(
  spellClient: Pick<AMBRelayClient, 'queryEvents'>,
  makeFallbackClient: ClientFactory = (relays) => new AMBRelayClient(relays)
): (pubkeyHex: string) => Promise<string[]> {
  const latestOf = (evs: NostrEvent[]): NostrEvent | undefined =>
    evs.sort((a, b) => b.created_at - a.created_at)[0];

  return async (pk) => {
    const primary = await spellClient.queryEvents({ kinds: [3], authors: [pk], limit: 1 });
    let latest = latestOf(primary);
    if (!latest) {
      const fallbackClient = makeFallbackClient([CONTACTS_FALLBACK_RELAY]);
      try {
        const fallback = await fallbackClient.queryEvents({ kinds: [3], authors: [pk], limit: 1 });
        latest = latestOf(fallback);
      } finally {
        fallbackClient.close();
      }
    }
    return latest ? latest.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]) : [];
  };
}

function resolveMe(paramMe: string | undefined, extra: unknown): string | undefined {
  if (paramMe) {
    if (/^[0-9a-f]{64}$/.test(paramMe)) return paramMe;
    let decoded: ReturnType<typeof nip19.decode>;
    try {
      decoded = nip19.decode(paramMe);
    } catch {
      throw new SpellError('me_unresolvable', `me must be an npub or hex pubkey, got: ${paramMe}`);
    }
    if (decoded.type === 'npub') return decoded.data;
    throw new SpellError('me_unresolvable', `me must be an npub or hex pubkey, got: ${paramMe}`);
  }
  const clientPubkey = (extra as { authInfo?: { clientPubkey?: string } } | undefined)?.authInfo?.clientPubkey;
  return clientPubkey ?? getSessionPubkey(extra) ?? undefined;
}

/** Core flow, transport-free — tested directly; the MCP wrapper below is thin. */
export async function runSearchPassages(
  deps: SearchPassagesDeps,
  params: SearchPassagesParams,
  extra: unknown
) {
  // A tag filter with an empty `values` array is a vacuous filter — treat
  // it as absent rather than forwarding it into spellFromParams, where an
  // empty-values tag would otherwise slip through as a filter key.
  const tag = params.tag && params.tag.values.length > 0 ? params.tag : undefined;
  const inline: InlineScopeParams = {
    authors: params.authors, kinds: params.kinds, tag,
    search: params.search, since: params.since, until: params.until,
  };
  const hasInline = Object.values(inline).some((v) => v !== undefined);
  if (params.spell && hasInline) {
    throw new SpellError('no_filter', 'pass either spell or inline scope parameters, not both');
  }

  let spell: Spell;
  let spellEventId: string | undefined;
  if (params.spell) {
    const ref = decodeSpellRef(params.spell);
    const { event, triedRelays } = await deps.fetchSpellEvent(ref.id, ref.hints);
    if (!event) {
      throw new SpellError(
        'spell_not_found',
        `spell ${ref.id} not found on any of: ${triedRelays.join(', ')}`
      );
    }
    spell = parseSpellEvent(event);
    spellEventId = event.id;
  } else {
    spell = spellFromParams(inline);
  }

  const filter = await resolveSpell(spell, {
    me: resolveMe(params.me, extra),
    fetchContacts: deps.fetchContacts,
  });
  let scope;
  try {
    scope = await buildScope(filter, deps.queryContentEvents);
  } catch (err) {
    // A dead or timing-out relay must be reported as such, not as an empty
    // scope — the user can retry an outage; an empty scope needs a different
    // spell. The strict query path throws RelayUnreachableError for this.
    if (err instanceof RelayUnreachableError) {
      throw new SpellError(
        'relay_unreachable',
        `content relay ${deps.relay} did not answer (unreachable or timed out) — the scope could not be determined; this is not an empty result, try again later`
      );
    }
    throw err;
  }
  // Over-fetch with vector-leaning ranking, then cap per document and apply
  // the relative score floor so `limit` passages come from several sources.
  const limit = Math.min(params.limit ?? 10, 25);
  const k = Math.min(limit * OVERFETCH_FACTOR, 100);
  const res = await deps.searchChunks(deps.relay, { q: params.question, k, filter: scope.chunkFilter, alpha: PASSAGE_ALPHA });

  return {
    passages: selectPassages(res.hits, limit),
    scope: {
      spell: spellToEventTemplate(spell),
      ...(spellEventId ? { spell_event_id: spellEventId } : {}),
      resolved_filter: filter,
      mode: scope.mode,
      ...(scope.eventsInScope !== undefined ? { events_in_scope: scope.eventsInScope } : {}),
      truncated: scope.truncated,
    },
  };
}

export function registerSearchPassagesTool(
  server: McpServer,
  client: AMBRelayClient,
  spellClient: AMBRelayClient,
  indexer: IndexerClient
): void {
  server.registerTool(
    'search_passages',
    {
      title: 'Grounded passage search (RAG) scoped by a spell',
      description:
        'THE DEFAULT TOOL FOR QUESTION-SHAPED QUERIES ("wie/warum/was hilft bei X?", ' +
        '"how do I…?"): retrieves the best-matching fulltext passages from the corpus ' +
        'and returns them with citations (source resource, page, heading, source URL) — ' +
        'answer the user FROM the passages and cite each source. (For discovery intent — ' +
        '"finde/empfiehl Materialien" — use search_content instead, or afterwards to offer ' +
        'browsable links.) Keep `question` topic-only. Ranking is hybrid keyword+vector, so ' +
        'phrase the question as a topical statement that names the subject and the target ' +
        'group ("Friedenserziehung in der Grundschule: Einstieg in das Thema Frieden mit ' +
        'Kindern"), not as the user\'s literal sentence ("Wie kann ich …?"). Results are ' +
        'capped at two passages per document; a passage with only a snippet and no text is ' +
        'either license-gated or has no fulltext yet — say so instead of guessing. ' +
        'Scope is required but simple: with ' +
        'no source restriction from the user, pass the content kinds (e.g. kinds:[30142] ' +
        'for educational resources, [30040,30041] for publications, [30023] for articles). ' +
        'Route source restrictions ("nur Content von X") into the scope parameters: a ' +
        'metadata publisher (most organisations — resolve_publisher finds the exact ' +
        'spelling) goes into `search` as a QUOTED field filter, e.g. ' +
        'search:\'publisher.name:"LEHRE LADEN"\' (unquoted multi-word names match nothing); ' +
        'a Nostr signing account (resolve_author → pubkey) goes into `authors`. ' +
        'A published grimoire spell (kind 777, nevent or event id) can replace inline scope ' +
        'entirely; the response carries the canonical spell for whatever scope was used — ' +
        'publish it (e.g. via grimoire) to make the scope reusable. Spells may use ' +
        '$me/$contacts; they resolve to the calling user (pass `me` if the transport is ' +
        'anonymous). Fails rather than widening scope: an empty scope, unreachable relay ' +
        '(relay_unreachable — tell the user to retry), or unreachable index is a typed ' +
        'error, never a silently unscoped search.',
      inputSchema: {
        question: z.string().describe('The question or topic to find grounding passages for.'),
        spell: z.string().optional().describe('Published spell: nevent, note id, or 64-hex event id.'),
        authors: z.array(z.string()).optional().describe('Inline scope: Nostr event-author pubkeys (hex/npub/$me/$contacts) — resolve names via resolve_author. NOT for metadata publishers; those go into `search`.'),
        kinds: z.array(z.number()).optional().describe('Inline scope: content kinds (e.g. 30142).'),
        tag: z.object({ letter: z.string(), values: z.array(z.string()) }).optional()
          .describe('Inline scope: one tag filter, e.g. {letter:"h", values:["<community-pk>"]}.'),
        search: z.string().optional().describe('Inline scope: NIP-50 term selecting the EVENTS in scope (distinct from question). Supports field filters; quote multi-word values: publisher.name:"LEHRE LADEN".'),
        since: z.string().optional().describe('Inline scope: absolute Unix seconds or relative (7d, 1mo, now).'),
        until: z.string().optional().describe('Inline scope: absolute Unix seconds or relative.'),
        me: z.string().optional().describe('Who $me refers to (npub or hex). Defaults to the calling identity.'),
        relays: z.array(z.string()).optional().describe('Relay selection (list_relays set), by full URL or short name (e.g. "oersi", "sodix"). First mapped relay is used.'),
        limit: z.number().min(1).max(25).optional().default(10).describe('Passages to return (1-25, default 10).'),
      },
    },
    async (params, extra) => {
      const selection = resolveRelaysOrError(client, params.relays);
      if ('errorPayload' in selection) {
        return { content: [{ type: 'text', text: JSON.stringify(selection.errorPayload) }] };
      }
      const relay = selection.relays.find((r) => indexer.forRelay(r)) ?? selection.relays[0];
      const deps: SearchPassagesDeps = {
        relay,
        queryContentEvents: (f) => client.queryEvents(f, [relay], { strict: true }),
        fetchSpellEvent: makeFetchSpellEvent(spellClient),
        fetchContacts: makeFetchContacts(spellClient),
        searchChunks: (r, body) => indexer.searchChunks(r, body),
      };
      try {
        const out = await runSearchPassages(deps, params as SearchPassagesParams, extra);
        const notSearched = relaysNotSearched(client, [relay]);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              relaySearched: relay,
              ...(notSearched.length > 0 ? { relaysNotSearched: notSearched } : {}),
              ...out,
            }),
          }],
        };
      } catch (err) {
        if (err instanceof SpellError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.code, message: err.message }) }] };
        }
        throw err;
      }
    }
  );
}
