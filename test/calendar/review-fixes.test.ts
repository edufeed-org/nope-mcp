import { describe, it, expect } from 'vitest';
import type { Filter, NostrEvent } from 'nostr-tools';
import { eventToCalendarEvent, eventToRsvp } from '../../src/calendar/transform.js';
import { searchCalendarEvents } from '../../src/calendar/search.js';
import { CalendarAuthorCache } from '../../src/calendar/authorInfo.js';

const PK = 'a'.repeat(64);
const MIRROR = 'b'.repeat(64);

function ev(kind: number, d: string, tags: string[][], pubkey = PK): NostrEvent {
  return { id: 'id-' + d, pubkey, created_at: 1700000000, kind, tags: [['d', d], ...tags], content: '', sig: 's' };
}

describe('spec tags surfaced on events', () => {
  it('exposes D day tags as numbers (31923, required by NIP-52)', () => {
    const r = eventToCalendarEvent(ev(31923, 'x', [['title', 'T'], ['start', '1791363600'], ['D', '20733'], ['D', '20734'], ['D', 'junk']]))!;
    expect(r.days).toEqual([20733, 20734]);
  });

  it('omits days when no D tag is present', () => {
    const r = eventToCalendarEvent(ev(31923, 'x', [['title', 'T'], ['start', '1791363600']]))!;
    expect(r.days).toBeUndefined();
  });

  it('an empty eventAttendanceMode value is no statement', () => {
    const r = eventToCalendarEvent(ev(31923, 'x', [['title', 'T'], ['start', '1791363600'], ['eventAttendanceMode', '']]))!;
    expect(r.attributes).toBeUndefined();
  });
});

describe('RSVP target kind', () => {
  it('ignores an RSVP whose a tag does not reference a 31922/31923 coordinate', () => {
    expect(eventToRsvp(ev(31925, 'r', [['a', `30142:${PK}:x`], ['status', 'accepted']]))).toBeNull();
    expect(eventToRsvp(ev(31925, 'r', [['a', `31922:${PK}:x`], ['status', 'accepted']]))).not.toBeNull();
  });
});

describe('hidden sources apply to calendars and RSVPs too', () => {
  it('drops and counts RSVPs and calendars from a hidden pubkey', async () => {
    const events = [
      ev(31925, 'r1', [['a', `31923:${PK}:x`], ['status', 'accepted']], MIRROR),
      ev(31925, 'r2', [['a', `31923:${PK}:x`], ['status', 'accepted']]),
      ev(31924, 'c1', [['title', 'C'], ['a', `31923:${PK}:x`]], MIRROR),
    ];
    const client = {
      queryEvents: async (filter: Filter) =>
        filter.kinds?.includes(0) ? [] : events.filter((e) => filter.kinds?.includes(e.kind)),
    };
    const out = await searchCalendarEvents(
      client,
      { kinds: [31924, 31925], limit: 10 },
      { authorCache: new CalendarAuthorCache(async () => []), hidden: new Set([MIRROR]), directory: null },
    );
    expect(out.rsvps?.map((r) => r.identifier)).toEqual(['r2']);
    expect(out.calendars).toBeUndefined();
    expect(out.hiddenSources).toMatchObject({ hidden: 2, included: false });
    expect(out.total).toBe(1);
  });
});
