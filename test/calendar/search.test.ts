import { describe, it, expect } from 'vitest';
import type { Filter, NostrEvent } from 'nostr-tools';
import { searchCalendarEvents } from '../../src/calendar/search.js';
import { CalendarAuthorCache } from '../../src/calendar/authorInfo.js';

const PK = 'a'.repeat(64);
const MIRROR = 'b'.repeat(64);

function ev(kind: number, d: string, tags: string[][], pubkey = PK): NostrEvent {
  return { id: 'id-' + d, pubkey, created_at: 1700000000, kind, tags: [['d', d], ...tags], content: '', sig: 's' };
}
const timed = (d: string, pubkey = PK) => ev(31923, d, [['title', d], ['start', '1718600000']], pubkey);
const rsvp = (d: string) => ev(31925, d, [['a', `31923:${PK}:x`], ['status', 'accepted']]);
const calendar = (d: string) => ev(31924, d, [['title', d], ['a', `31923:${PK}:x`]]);

function fakeClient(events: NostrEvent[]) {
  const filters: Filter[] = [];
  return {
    filters,
    queryEvents: async (filter: Filter) => {
      filters.push(filter);
      if (filter.kinds?.includes(0)) return [];
      return events.filter((e) => !filter.kinds || filter.kinds.includes(e.kind)).slice(0, filter.limit ?? 250);
    },
  };
}

const deps = () => ({
  authorCache: new CalendarAuthorCache(async () => []),
  hidden: new Set<string>(),
  directory: null,
});

describe('searchCalendarEvents accounting across NIP-52 kinds', () => {
  it('counts calendars and RSVPs in total and applies limit to them', async () => {
    const client = fakeClient([rsvp('r1'), rsvp('r2'), rsvp('r3'), calendar('c1')]);
    const out = await searchCalendarEvents(client, { kinds: [31925], limit: 2 }, deps());
    expect(out.events).toEqual([]);
    expect(out.rsvps).toHaveLength(2);
    expect(out.calendars).toBeUndefined();
    expect(out.total).toBe(2);
  });

  it('keeps limit on RSVPs even when hidden-source over-fetch is active', async () => {
    const client = fakeClient([rsvp('r1'), rsvp('r2'), rsvp('r3')]);
    const out = await searchCalendarEvents(client, { kinds: [31925], limit: 2 }, { ...deps(), hidden: new Set([MIRROR]) });
    expect(client.filters[0].limit).toBe(250);
    expect(out.rsvps).toHaveLength(2);
    expect(out.total).toBe(2);
  });

  it('drops hidden-source events, reports the count and cuts back to limit', async () => {
    const client = fakeClient([timed('m1', MIRROR), timed('e1'), timed('m2', MIRROR), timed('e2'), timed('e3')]);
    const out = await searchCalendarEvents(client, { limit: 2 }, { ...deps(), hidden: new Set([MIRROR]) });
    expect(out.events.map((e) => e.identifier)).toEqual(['e1', 'e2']);
    expect(out.hiddenSources).toMatchObject({ hidden: 2, included: false });
    expect(out.total).toBe(2);
  });

  it('attaches author info to every event', async () => {
    const client = fakeClient([timed('e1')]);
    const authorCache = new CalendarAuthorCache(async () => [
      { id: 'p', pubkey: PK, created_at: 1, kind: 0, tags: [], content: JSON.stringify({ name: 'relilab', bot: false }), sig: 's' },
    ]);
    const out = await searchCalendarEvents(client, {}, { ...deps(), authorCache });
    expect(out.events[0].author).toEqual({ pubkey: PK, name: 'relilab', bot: false });
  });
});
