import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { eventToCalendarEvent } from '../../src/calendar/transform.js';

const PK = 'a'.repeat(64);
function ev(kind: number, tags: string[][]): NostrEvent {
  return { id: 'e', pubkey: PK, created_at: 1700000000, kind, tags, content: '', sig: 's' };
}
const base = (...tags: string[][]) => ev(31923, [['d', 'x'], ['title', 'T'], ['start', '1718600000'], ...tags]);

describe('interop with edufeed-app readers', () => {
  it('an empty title falls back to the deprecated name (relay accepts such an event)', () => {
    const r = eventToCalendarEvent(ev(31923, [['d', 'x'], ['title', ''], ['name', 'Fallback'], ['start', '1718600000']]));
    expect(r?.title).toBe('Fallback');
  });

  it('only 31922/31923 are calendar events, whatever tags a 31924/31925 carries', () => {
    expect(eventToCalendarEvent(ev(31925, [['d', 'x'], ['title', 'T'], ['start', '1718600000']]))).toBeNull();
    expect(eventToCalendarEvent(ev(31924, [['d', 'x'], ['title', 'T'], ['start', '1718600000']]))).toBeNull();
  });

  it('the first VALID attribute tag wins, as calendar-attributes.js reads it', () => {
    const r = eventToCalendarEvent(
      base(
        ['registrationRequired', 'yes'],
        ['registrationRequired', 'true'],
        ['price', 'gratis', 'EUR'],
        ['price', '0', 'EUR'],
        ['eventAttendanceMode', 'bogus'],
        ['eventAttendanceMode', 'https://schema.org/OnlineEventAttendanceMode'],
      ),
    )!;
    expect(r.attributes).toEqual({
      registrationRequired: true,
      price: { amount: 0, currency: 'EUR', free: true },
      attendanceMode: 'online',
      attendanceModeUri: 'https://schema.org/OnlineEventAttendanceMode',
    });
  });

  it('attendance mode: trims and reads the last path segment like the app', () => {
    for (const v of ['https://schema.org/OnlineEventAttendanceMode ', 'http://www.schema.org/OnlineEventAttendanceMode', ' OnlineEventAttendanceMode']) {
      const r = eventToCalendarEvent(base(['eventAttendanceMode', v]))!;
      expect(r.attributes?.attendanceMode, v).toBe('online');
      expect(r.attributes?.attendanceModeUri, v).toBe('https://schema.org/OnlineEventAttendanceMode');
    }
  });

  it('an empty educationalLevel:id is skipped', () => {
    const r = eventToCalendarEvent(base(['educationalLevel:id', ''], ['educationalLevel:prefLabel:de', 'x']))!;
    expect(r.attributes).toBeUndefined();
  });
});
