import { describe, it, expect } from 'vitest';
import type { Filter, NostrEvent } from 'nostr-tools';
import { eventToCalendarEvent } from '../../src/calendar/transform.js';
import { searchCalendarEvents } from '../../src/calendar/search.js';
import { CalendarAuthorCache } from '../../src/calendar/authorInfo.js';

const PK = 'a'.repeat(64);

function ev(kind: number, d: string, tags: string[][], pubkey = PK): NostrEvent {
  return { id: 'id-' + d, pubkey, created_at: 1700000000, kind, tags: [['d', d], ...tags], content: '', sig: 's' };
}

describe('limit caps the whole result, not each category', () => {
  it('returns at most `limit` items across events, calendars and rsvps', async () => {
    const events = [
      ev(31923, 'e1', [['title', 'T'], ['start', '1718600000']]),
      ev(31923, 'e2', [['title', 'T'], ['start', '1718600000']]),
      ev(31924, 'c1', [['title', 'C']]),
      ev(31925, 'r1', [['a', `31923:${PK}:x`], ['status', 'accepted']]),
      ev(31925, 'r2', [['a', `31923:${PK}:x`], ['status', 'accepted']]),
    ];
    const client = { queryEvents: async (filter: Filter) => (filter.kinds?.includes(0) ? [] : events) };
    const out = await searchCalendarEvents(
      client,
      { kinds: [31922, 31923, 31924, 31925], limit: 3 },
      { authorCache: new CalendarAuthorCache(async () => []), hidden: new Set(['b'.repeat(64)]), directory: null },
    );
    const items = out.events.length + (out.calendars?.length ?? 0) + (out.rsvps?.length ?? 0);
    expect(items).toBe(3);
    expect(out.total).toBe(3);
  });
});

describe('price parsing matches the relay (plain decimal only)', () => {
  it.each(['1e3', '0x10', '0b1', 'Infinity', ' '])('treats %j as no statement', (raw) => {
    const r = eventToCalendarEvent(ev(31923, 'x', [['title', 'T'], ['start', '1718600000'], ['price', raw, 'EUR']]))!;
    expect(r.attributes?.price).toBeUndefined();
  });
  it.each([
    ['0', 0],
    ['25', 25],
    ['12.50', 12.5],
    ['12,5', 12.5],
  ])('accepts %j as %d', (raw, amount) => {
    const r = eventToCalendarEvent(ev(31923, 'x', [['title', 'T'], ['start', '1718600000'], ['price', raw, 'EUR']]))!;
    expect(r.attributes?.price?.amount).toBe(amount);
  });
});

describe('author cache after a failed fetch', () => {
  it('retries sooner than the normal TTL', async () => {
    let now = 0;
    let calls = 0;
    const cache = new CalendarAuthorCache(
      async () => {
        calls++;
        if (calls === 1) throw new Error('relay down');
        return [{ id: 'p', pubkey: PK, created_at: 1, kind: 0, tags: [], content: JSON.stringify({ name: 'relilab' }), sig: 's' }];
      },
      10 * 60 * 1000,
      () => now,
    );
    await cache.lookup([PK]);
    now = 2 * 60 * 1000; // two minutes later: a transient outage must not pin bare entries for ten
    const got = await cache.lookup([PK]);
    expect(calls).toBe(2);
    expect(got.get(PK)?.name).toBe('relilab');
  });
});
