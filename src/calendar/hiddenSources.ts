/**
 * Hidden calendar sources — bulk publishers whose events would otherwise
 * drown every calendar answer: edufeed's own event mirrors (Deutscher
 * Bildungsserver, OER World Map, ev-bildung crawlers; one to two thousand
 * events each) and imported course catalogues. On the production relay
 * roughly 9 of 10 recent calendar events come from such mirrors.
 *
 * Mirrors edufeed-app's `CALENDAR_HIDDEN_PUBKEYS` (src/lib/services/
 * calendar-sources.svelte.js): one operator-configured list, hidden by
 * default, shown on request (`includeHiddenSources: true`). A NIP-24
 * `bot: true` profile does NOT hide an author by itself — being a bot is not
 * the problem, flooding is, and that is the operator's call per source (OER
 * World Map is a bot and wanted on the calendar). The flag is still reported
 * per event (see authorInfo.ts) so a model can group or de-emphasise.
 */

import { nip19 } from 'nostr-tools';
import { loadAuthorSets } from '../authors.js';

const HEX64 = /^[0-9a-f]{64}$/i;

export interface HiddenSourceEntries {
  /** Resolved hex pubkeys (from hex or npub entries). */
  pubkeys: string[];
  /** Kind-30000 list naddrs, resolved at load time to their `p` members. */
  naddrs: string[];
}

/**
 * Parse the comma-separated `CALENDAR_HIDDEN_PUBKEYS` value. Entries may be
 * hex pubkeys, npubs or naddrs of NIP-51 kind-30000 lists (the same forms
 * edufeed-app accepts). Anything else is skipped.
 */
export function parseHiddenSourceEntries(raw: string | undefined): HiddenSourceEntries {
  const pubkeys: string[] = [];
  const naddrs: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    if (HEX64.test(value)) {
      pubkeys.push(value.toLowerCase());
      continue;
    }
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === 'npub') pubkeys.push(decoded.data);
      else if (decoded.type === 'naddr' && decoded.data.kind === 30000) naddrs.push(value);
    } catch {
      // not a NIP-19 value; skip
    }
  }
  return { pubkeys, naddrs };
}

/**
 * Resolve the configured entries into one set of hidden pubkeys. List naddrs
 * are fetched from `relays` (plus their embedded hints); a list that cannot
 * be fetched contributes nothing, the direct pubkeys still apply.
 */
export async function loadHiddenCalendarSources(
  raw: string | undefined,
  relays: string[],
): Promise<Set<string>> {
  const { pubkeys, naddrs } = parseHiddenSourceEntries(raw);
  const hidden = new Set(pubkeys);
  if (naddrs.length > 0) {
    const directory = await loadAuthorSets(naddrs, relays);
    for (const author of directory.authors) hidden.add(author.pubkey);
  }
  return hidden;
}

/**
 * Split calendar events into the ones to show and the count of hidden ones.
 * With `showHidden` everything is shown and `hidden` still reports how many
 * came from hidden sources.
 */
export function partitionHiddenCalendarSources<T extends { nostr: { pubkey: string } }>(
  events: T[],
  hidden: ReadonlySet<string>,
  { showHidden = false }: { showHidden?: boolean } = {},
): { shown: T[]; hidden: number } {
  if (hidden.size === 0) return { shown: events, hidden: 0 };
  let count = 0;
  for (const e of events) if (hidden.has(e.nostr.pubkey)) count++;
  if (count === 0 || showHidden) return { shown: events, hidden: count };
  return { shown: events.filter((e) => !hidden.has(e.nostr.pubkey)), hidden: count };
}

// ============ Module State ============

let hiddenCalendarSources: Set<string> = new Set();

export function getHiddenCalendarSources(): ReadonlySet<string> {
  return hiddenCalendarSources;
}

export function setHiddenCalendarSources(set: Set<string>): void {
  hiddenCalendarSources = set;
}
