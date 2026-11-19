import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AMBRelayClient } from '../relay/client.js';
import {
  relaysNotSearched, resolveRelaysOrError, newRelayDiagnostics, relayDiagnosticsFields,
} from './relaySelection.js';
import { buildContentFilter, type ContentSearchParams } from '../relay/filters.js';
import { transformContentEvent } from '../content/transform.js';
import { parseSnippets, attachSnippets, SNIPPET_KIND } from '../content/snippet.js';
import { rankResults } from '../content/rank.js';
import { getEventRelay } from '../relay/provenance.js';
import { assertPublicRelayUrl, assertResolvesPublic, understandsHints } from '../relay/capabilities.js';
import { parseIntent, toSearchString, semanticDirective, levelFit, activeRules } from '../search/intent.js';
import type { SimplifiedContentResult, ResourceResult } from '../content/types.js';
import { READ_ONLY } from './annotations.js';
import {
  LICENSE_TEXT, clampLicenseFilter, eventLicense, matchesLicenseFilter, type LicenseFilter,
} from '../license/classify.js';
import { licenseOnlyZeroHint } from './licenseHint.js';

/**
 * License-filtered over-fetch: the license filter runs client-side (a relay
 * field filter would disable chunk rerank and its passages, and only kind
 * 30142 carries a license), so ask for this many times `limit` and trim.
 */
export const CONTENT_LICENSE_OVERFETCH_FACTOR = 3;
const RELAY_MAX_LIMIT = 250;
const MAX_EXTRA_RELAYS = 3;

/**
 * Run a cross-content search: one relay-ranked REQ over the selected content
 * kinds (+ 21142), partition out the snippet events, transform the content
 * events in arrival order, attach each matched passage to its parent, then
 * merge across relays (level fit, then per-relay rank, see rankResults).
 * licenseFilter (narrowed to the server's licenseFilterMax ceiling) drops
 * learning resources (30142) outside the requested tier; every other kind
 * passes unfiltered. A metadata-only resource never keeps a snippet/page/
 * heading/score/sourceUrl, even if a 21142 event arrived for it (defence in
 * depth — the indexer should already withhold fulltext for it).
 */
export async function runContentSearch(
  client: Pick<AMBRelayClient, 'queryEvents'>,
  params: ContentSearchParams & { language?: string; relays?: string[]; extraRelays?: string[]; licenseFilter?: LicenseFilter },
  opts: { licenseFilterMax?: LicenseFilter; fetchFn?: typeof fetch; lookupFn?: Parameters<typeof assertResolvesPublic>[1] } = {}
): Promise<{
  total: number;
  results: SimplifiedContentResult[];
  relaysIncomplete?: string[];
  warning?: string;
  /** How the question was read, when level, grade or type words were taken out of the text. */
  interpretation?: { text: string; levels: string[]; grade?: string; types: string[] };
  licenseFilter: LicenseFilter;
  licenseFilterClamped?: true;
  /** Recovery guidance for the zero-match case caused only by the license filter. */
  hint?: string;
}> {
  const language = params.language ?? 'de';
  // Level, grade and type words leave the text and go to the relays as
  // prefer.* hints; the same intent orders the merged list below.
  // Level, grade and type are statements about learning resources (kind 30142).
  const reachesResources = !params.types?.length || params.types.includes('resource');
  const intent = parseIntent(params.query ?? '', activeRules(), reachesResources);
  const hinted = toSearchString(intent) + semanticDirective(params.query ?? '', intent);
  const interpreted = hinted !== (params.query ?? '');
  const filter = buildContentFilter(interpreted ? { ...params, query: hinted } : params);
  const limit = filter.limit!;
  const { effective, clamped } = clampLicenseFilter(params.licenseFilter, opts.licenseFilterMax ?? 'any');
  const filterResources = effective !== 'any' && !!filter.kinds?.includes(30142);
  if (filterResources) filter.limit = Math.min(limit * CONTENT_LICENSE_OVERFETCH_FACTOR, RELAY_MAX_LIMIT);
  const diag = newRelayDiagnostics();
  // "Also use this relay": searched for this call only. A relay that does not
  // advertise the prefer.* hints gets the cleaned text without them; its hits
  // are merged like all others, by their own tags.
  const extraRelays = params.extraRelays ?? [];
  if (extraRelays.length > MAX_EXTRA_RELAYS) throw new Error(`extraRelays: at most ${MAX_EXTRA_RELAYS} relays per search`);
  extraRelays.forEach(assertPublicRelayUrl);
  await Promise.all(extraRelays.map((url) => assertResolvesPublic(url, opts.lookupFn)));
  const plain = new Set<string>();
  if (interpreted) {
    await Promise.all(extraRelays.map(async (url) => (await understandsHints(url, opts.fetchFn)) || plain.add(url)));
  }
  const plainSearch = buildContentFilter({ ...params, query: intent.text }).search;
  const events = await client.queryEvents(filter, params.relays, {
    diag,
    ...(extraRelays.length ? { extraRelays, searchFor: (url: string) => (plain.has(url) ? plainSearch : undefined) } : {}),
  });

  // A relay the caller named may only attach a passage to a hit it delivered
  // itself: otherwise it could put its own text and source URL on a result
  // that came from a trusted relay.
  const deliveredBy = new Map(events.filter((e) => e.kind !== SNIPPET_KIND).map((e) => [e.id, getEventRelay(e)]));
  const snippetEvents = events.filter((e) => {
    if (e.kind !== SNIPPET_KIND) return false;
    const relay = getEventRelay(e);
    if (!relay || !extraRelays.includes(relay)) return true;
    const parent = e.tags.find((t) => t[0] === 'e')?.[1];
    return parent !== undefined && deliveredBy.get(parent) === relay;
  });

  // One pass: transform in relay order, skipping invalid events, and keep the
  // surviving source events in lock-step so result[i] ↔ keptEvents[i] for
  // snippet attachment.
  const results: SimplifiedContentResult[] = [];
  const keptEvents: typeof events = [];
  for (const e of events) {
    if (e.kind === SNIPPET_KIND) continue;
    if (filterResources && e.kind === 30142 && !matchesLicenseFilter(eventLicense(e).group, effective)) continue;
    const r = transformContentEvent(e, language);
    if (r) {
      results.push(r);
      keptEvents.push(e);
    }
  }
  const snippets = parseSnippets(snippetEvents);
  attachSnippets(results, keptEvents, snippets);

  // Metadata-only resources never surface fulltext, even if a stale/unexpected
  // 21142 snippet arrived for them.
  for (const r of results) {
    if (r.type === 'resource' && (r as ResourceResult).accessLevel === 'metadata-only') {
      delete r.snippet;
      delete r.page;
      delete r.heading;
      delete r.score;
      delete r.sourceUrl;
    }
  }

  // Zero results caused ONLY by the license filter: the over-fetch already
  // pulled in the wider set (no relay-side license field filter is ever
  // added here), so the resource-kind events the filter dropped are already
  // in hand — no extra query needed, unlike search_resources' field-filter
  // path.
  let hint: string | undefined;
  if (results.length === 0 && filterResources) {
    const droppedResources = events.filter(
      (e) => e.kind === 30142 && !matchesLicenseFilter(eventLicense(e).group, effective)
    );
    if (droppedResources.length > 0) {
      hint = licenseOnlyZeroHint(
        droppedResources,
        effective as Exclude<LicenseFilter, 'any'>,
        opts.licenseFilterMax ?? 'any'
      );
    }
  }

  // One ranked list across relays; `limit` applies after the merge.
  const fit = new Map(results.map((r, i) => [r, levelFit(keptEvents[i].tags, intent)]));
  const ranked = rankResults(results, intent.text, limit, !filter.search, (r) => fit.get(r) ?? 0);

  return {
    total: ranked.length,
    results: ranked,
    ...(intent.levels.length || intent.grade || intent.types.length
      ? { interpretation: { text: intent.text, levels: intent.levels, grade: intent.grade, types: intent.types } }
      : {}),
    ...relayDiagnosticsFields(diag),
    licenseFilter: effective,
    ...(clamped ? { licenseFilterClamped: true as const } : {}),
    ...(hint ? { hint } : {}),
  };
}

/**
 * Address, title and relay per result: for a client that holds the events
 * already and only needs their order. A full 50-result answer is about
 * 110 kB, more than a Nostr transport relay takes once it is gift-wrapped.
 */
export function compactResults(results: SimplifiedContentResult[]): { naddr?: string; title?: string; relay?: string }[] {
  return results.map((r) => {
    const { naddr, title, relay } = r as { naddr?: string; title?: string; relay?: string };
    return { naddr, title, relay };
  });
}

export function registerSearchContentTool(
  server: McpServer,
  client: AMBRelayClient,
  opts?: { passagesAvailable?: boolean; licenseFilterMax?: LicenseFilter }
): void {
  const licenseFilterMax = opts?.licenseFilterMax ?? 'any';
  const intentSentence = opts?.passagesAvailable
    ? 'This is the tool for DISCOVERY intent — the user wants materials to browse ' +
      '("finde/suche/empfiehl Materialien zu X"): present the items. For QUESTION ' +
      'intent — the user wants an answer built from the content ("wie/warum/was ' +
      'hilft bei X?") — prefer search_passages, which returns quotable fulltext ' +
      'passages with citations; this tool then supplements the answer with ' +
      'browsable links. '
    : 'This is the default tool for ' +
      'natural-language questions like "what can I do about inattentive students?". ';
  server.registerTool(
    'search_content',
    {
      title: 'Search Educational Content (resources, articles, wikis, projects, measures, publications)',
      description:
        'Topic search across ALL content types on the relay in one ranked call: ' +
        'educational resources (kind 30142), long-form articles/blogs (30023), ' +
        'wikis (30818), projects (30143), measures (30144), and NKBIP-01 publications (30040 indices + 30041 sections — scientific articles, books). Results are interleaved and ranked by semantic passage match, ' +
        'and each carries the matched passage ("snippet") when available — use it to ' +
        'answer the user, not just list links. ' +
        'Every learning resource is returned by default, whatever its license; each resource ' +
        'result carries license ({id, label}, or null when unlicensed) and accessLevel ' +
        `("full" for ${LICENSE_TEXT.full}; "metadata-only" otherwise). Snippets ` +
        'and passages exist only for accessLevel:"full" resources — present a "metadata-only" ' +
        'resource by its title, description, license and link, never quoted beyond its ' +
        'metadata, and always name the license and the creator/publisher. licenseFilter ' +
        `narrows the results: "open" = ${LICENSE_TEXT.open}; "cc-any" = ${LICENSE_TEXT.ccAny}; ` +
        '"any" = also unlicensed and ' +
        'all-rights-reserved resources. The other content types carry no license and are ' +
        'always included. ' +
        (licenseFilterMax !== 'any'
          ? `This server limits results to licenseFilter '${licenseFilterMax}'. `
          : '') +
        intentSentence +
        'Each result carries eventAuthor (the Nostr signer who uploaded the ' +
        'event — often an aggregator) plus, for resources, creator/publisher ' +
        '(who actually made and published the resource); these can differ, so ' +
        'do not treat eventAuthor as the publisher. For full metadata (license, ' +
        'dates, complete entity lists) pass a result\'s naddr to get_resource. ' +
        'Publication facets ride inside the query string as NIP-50 field filters: ' +
        'append type:academic, doi:10.1234/abcd.5678, keywords:<term>, or partOf:30143:<pubkey>:<d> ' +
        '("publications of a project") to the query — the relay resolves them server-side. ' +
        'When presenting results to the user, render each as a markdown link so ' +
        'they can open it directly — prefer sourcePage (the original external ' +
        'source page, present on most resources and on projects/measures/' +
        'publications), then url, then naddr. ' +
        'For upcoming events on the same topic, follow up with search_calendar_events.',
      inputSchema: {
        query: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Free-text topic (e.g., "Unaufmerksamkeit im Seminar"). Keep it to the TOPIC ' +
              'only — do not append actor/organization names ("… Lehreladen"): they dilute ' +
              'the semantic ranking and the actor\'s content drops out of the top results. ' +
              'To constrain by actor, resolve the name first (resolve_author → authors ' +
              'param here; or resolve_publisher → search_resources publisherName).'
          ),
        types: z
          .array(
            z.enum(['resource', 'article', 'wiki', 'project', 'measure', 'publication'])
          )
          .optional()
          .describe('Restrict to a subset of content types. Default: all of them.'),
        language: z.string().optional().default('de').describe('Label language (default "de").'),
        since: z.number().optional().describe('Created at or after this Unix timestamp.'),
        until: z.number().optional().describe('Created at or before this Unix timestamp.'),
        authors: z.array(z.string()).optional().describe('Filter by author pubkeys (hex).'),
        limit: z
          .number()
          .min(1)
          .max(250)
          .optional()
          .default(20)
          .describe('Max results (1-250, default 20).'),
        community: z
          .string()
          .optional()
          .describe(
            'Return content shared into this community (Communikey). Accepts a hex pubkey or npub. ' +
              'Resolve a community name with find_community (when available) or resolve_author. Combine with query to ' +
              'scope a topic to a community (e.g. "math resources shared with X").',
          ),
        licenseFilter: z
          .enum(['open', 'cc-any', 'any'])
          .optional()
          .describe(
            `Restrict educational-resource results by license: "open" (${LICENSE_TEXT.open}), ` +
              `"cc-any" (${LICENSE_TEXT.ccAny}) or "any" ` +
              "(every resource, including unlicensed and all-rights-reserved). Default: the " +
              "server's ceiling (normally any). Other content types are never license-filtered."
          ),
        extraRelays: z
          .array(z.string())
          .max(3)
          .optional()
          .describe(
            'Up to 3 further relay URLs (wss://, public hostname) to search in addition, for this ' +
              'call only: use when the user names a relay ("also search wss://…"). Nothing is stored. ' +
              'Their hits are merged with the others.'
          ),
        compact: z
          .boolean()
          .optional()
          .describe(
            'Return only naddr, title and relay per result. For clients that hold the events already ' +
              'and need the order alone; keeps a long list small enough for the Nostr transport.'
          ),
        relays: z
          .array(z.string())
          .optional()
          .describe(
            'Restrict the search to specific relays. Only relays returned by list_relays ' +
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
      const relaysSearched = selection.relays;
      const out = await runContentSearch(
        client,
        {
          query: params.query,
          types: params.types,
          language: params.language,
          since: params.since,
          until: params.until,
          authors: params.authors,
          limit: params.limit,
          community: params.community,
          relays: relaysSearched,
          extraRelays: params.extraRelays,
          licenseFilter: params.licenseFilter,
        },
        { licenseFilterMax }
      );
      const notSearched = relaysNotSearched(client, relaysSearched);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              relaysSearched,
              ...(notSearched.length > 0 ? { relaysNotSearched: notSearched } : {}),
              ...out,
              ...(params.compact ? { results: compactResults(out.results) } : {}),
            }),
          },
        ],
      };
    }
  );
}
