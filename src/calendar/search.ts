/**
 * search_calendar_events core, separated from the MCP registration so the
 * accounting (limit, total, hidden sources, author info) is unit-testable.
 */

import type { Filter, NostrEvent } from 'nostr-tools';
import type { RelayQueryDiagnostics } from '../relay/client.js';
import type { AuthorDirectory } from '../authors.js';
import { buildCalendarFilter, type CalendarSearchParams } from './filters.js';
import {
  eventsToCalendarEvents,
  eventToCalendarCollection,
  eventToRsvp,
  type CalendarCollection,
  type CalendarEvent,
  type CalendarRsvp,
} from './transform.js';
import type { CalendarAuthorCache } from './authorInfo.js';
import { partitionHiddenCalendarSources } from './hiddenSources.js';

/** Relay page size; the over-fetch ceiling when hidden sources are dropped client-side. */
export const RELAY_MAX_LIMIT = 250;

export interface CalendarSearchClient {
  queryEvents(
    filter: Filter,
    relaySelection?: string[],
    opts?: { strict?: boolean; diag?: RelayQueryDiagnostics },
  ): Promise<NostrEvent[]>;
}

export interface CalendarSearchDeps {
  authorCache: CalendarAuthorCache;
  hidden: ReadonlySet<string>;
  directory: AuthorDirectory | null;
  diag?: RelayQueryDiagnostics;
}

export interface CalendarSearchResult {
  /** Number of items returned across `events`, `calendars` and `rsvps`. */
  total: number;
  events: CalendarEvent[];
  calendars?: CalendarCollection[];
  rsvps?: CalendarRsvp[];
  hiddenSources?: { hidden: number; included: boolean; note: string };
}

export type CalendarSearchInput = CalendarSearchParams & { includeHiddenSources?: boolean };

export async function searchCalendarEvents(
  client: CalendarSearchClient,
  params: CalendarSearchInput,
  deps: CalendarSearchDeps,
): Promise<CalendarSearchResult> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), RELAY_MAX_LIMIT);
  // Hidden sources are dropped client-side (a Nostr filter cannot exclude
  // authors), so over-fetch to the relay page size and cut back to the
  // requested limit afterwards.
  const dropHidden = deps.hidden.size > 0 && !params.includeHiddenSources;
  const filter = buildCalendarFilter({ ...params, limit: dropHidden ? RELAY_MAX_LIMIT : limit });

  const raw = await client.queryEvents(filter, undefined, { diag: deps.diag });

  const calendars: CalendarCollection[] = [];
  const rsvps: CalendarRsvp[] = [];
  for (const e of raw) {
    if (e.kind === 31924) {
      const c = eventToCalendarCollection(e);
      if (c) calendars.push(c);
    } else if (e.kind === 31925) {
      const r = eventToRsvp(e);
      if (r) rsvps.push(r);
    }
  }

  const opts = { showHidden: !dropHidden };
  const partition = partitionHiddenCalendarSources(eventsToCalendarEvents(raw), deps.hidden, opts);
  const calPartition = partitionHiddenCalendarSources(calendars, deps.hidden, opts);
  const rsvpPartition = partitionHiddenCalendarSources(rsvps, deps.hidden, opts);
  const hiddenCount = partition.hidden + calPartition.hidden + rsvpPartition.hidden;
  // `limit` caps the whole result, not each category: events first, then
  // calendars, then RSVPs, until the budget is spent. The relay's own limit
  // already bounds the non-over-fetched single-kind case; the slices matter
  // for mixed kinds and when we over-fetched for the hidden-source drop.
  let budget = limit;
  const events = partition.shown.slice(0, budget);
  budget -= events.length;
  const calendarsOut = calPartition.shown.slice(0, budget);
  budget -= calendarsOut.length;
  const rsvpsOut = rsvpPartition.shown.slice(0, budget);

  const authors = await deps.authorCache.lookup(events.map((e) => e.nostr.pubkey));
  for (const event of events) {
    const info = authors.get(event.nostr.pubkey) ?? { pubkey: event.nostr.pubkey, bot: false };
    const fromDirectory = deps.directory?.authors.find((a) => a.pubkey === event.nostr.pubkey)?.name;
    event.author = info.name || !fromDirectory ? info : { ...info, name: fromDirectory };
  }

  const result: CalendarSearchResult = {
    total: events.length + calendarsOut.length + rsvpsOut.length,
    events,
  };
  if (calendarsOut.length > 0) result.calendars = calendarsOut;
  if (rsvpsOut.length > 0) result.rsvps = rsvpsOut;
  if (deps.hidden.size > 0) {
    result.hiddenSources = {
      hidden: hiddenCount,
      included: !dropHidden,
      note: dropHidden
        ? 'Events from operator-hidden bulk sources (event mirrors, imported catalogues) were left out of one relay page of 250, so fewer than `limit` may remain; pass includeHiddenSources: true to see them.'
        : 'Events from operator-hidden bulk sources are included; their author.bot flag marks automated accounts.',
    };
  }
  return result;
}
