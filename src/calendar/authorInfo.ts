/**
 * Per-event author info for calendar results: the author's display name and
 * the NIP-24 `bot` flag from their kind-0 profile, so a model can say who
 * publishes an event and tell a mirror/crawler account from a person or
 * organisation. The relay's profile index (kind 0 on the calendar relay) is
 * the source; misses are cached too, so an author without a profile costs
 * one lookup per cache lifetime, not one per call.
 */

import type { NostrEvent } from 'nostr-tools';
import { getProfileContent } from 'applesauce-core/helpers';

export interface CalendarAuthorInfo {
  pubkey: string;
  /** display_name, falling back to name; absent when the profile is unknown. */
  name?: string;
  /** NIP-24 `bot: true` in the profile (automated account, e.g. an event mirror). */
  bot: boolean;
}

/** Project a kind-0 event into CalendarAuthorInfo; unparseable content yields a bare entry. */
export function parseAuthorProfile(event: NostrEvent): CalendarAuthorInfo {
  const info: CalendarAuthorInfo = { pubkey: event.pubkey, bot: false };
  const content = getProfileContent(event) as (Record<string, unknown> & { bot?: unknown }) | undefined;
  if (!content) return info;
  const name = (content.display_name as string | undefined) || (content.name as string | undefined);
  if (name) info.name = name;
  if (content.bot === true) info.bot = true;
  return info;
}

export type ProfileFetcher = (pubkeys: string[]) => Promise<NostrEvent[]>;

const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** After a failed fetch (relay down) bare entries expire sooner, so a transient outage does not hide names for the full TTL. */
const ERROR_TTL_MS = 60 * 1000;

/**
 * In-memory cache of CalendarAuthorInfo keyed by pubkey. `lookup` fetches
 * only the pubkeys it has not seen (or whose entry expired), keeps the newest
 * kind-0 per author, and records a bare entry for every pubkey the fetcher
 * did not return — or for all of them when the fetcher throws.
 */
export class CalendarAuthorCache {
  private entries = new Map<string, { info: CalendarAuthorInfo; expires: number }>();

  constructor(
    private readonly fetcher: ProfileFetcher,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(pubkeys: string[]): Promise<Map<string, CalendarAuthorInfo>> {
    const result = new Map<string, CalendarAuthorInfo>();
    const missing: string[] = [];
    const t = this.now();
    for (const pubkey of new Set(pubkeys)) {
      const entry = this.entries.get(pubkey);
      if (entry && entry.expires > t) result.set(pubkey, entry.info);
      else missing.push(pubkey);
    }
    if (missing.length === 0) return result;

    const newest = new Map<string, NostrEvent>();
    let ttl = this.ttlMs;
    try {
      for (const event of await this.fetcher(missing)) {
        if (event.kind !== 0) continue;
        const prev = newest.get(event.pubkey);
        if (!prev || prev.created_at < event.created_at) newest.set(event.pubkey, event);
      }
    } catch {
      // Treat as "no profiles": bare entries below, retried after a short TTL.
      ttl = Math.min(this.ttlMs, ERROR_TTL_MS);
    }
    const expires = t + ttl;
    for (const pubkey of missing) {
      const event = newest.get(pubkey);
      const info = event ? parseAuthorProfile(event) : { pubkey, bot: false };
      this.entries.set(pubkey, { info, expires });
      result.set(pubkey, info);
    }
    return result;
  }
}
