import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { eventToCalendarEvent, eventToCalendarCollection, eventToRsvp } from '../../src/calendar/transform.js';

const PK = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

function ev(kind: number, tags: string[][], content = ''): NostrEvent {
  return { id: 'e-' + kind, pubkey: PK, created_at: 1700000000, kind, tags, content, sig: 's' };
}

describe('calendar references on events (NIP-52 collaborative requests)', () => {
  it('exposes a-tag references to kind-31924 calendars', () => {
    const r = eventToCalendarEvent(
      ev(31923, [
        ['d', 'x'],
        ['title', 'T'],
        ['start', '1718600000'],
        ['a', `31924:${OTHER}:meetups`, 'wss://relay.example'],
        ['a', `30142:${OTHER}:unrelated`],
      ]),
    )!;
    expect(r.calendarRefs).toEqual([`31924:${OTHER}:meetups`]);
  });
});

describe('eventToCalendarCollection (kind 31924)', () => {
  it('reads title, description and the referenced event coordinates', () => {
    const r = eventToCalendarCollection(
      ev(
        31924,
        [
          ['d', 'meetups'],
          ['title', 'Meetups'],
          ['a', `31923:${OTHER}:one`, 'wss://relay.example'],
          ['a', `31922:${OTHER}:two`],
        ],
        'All our meetups',
      ),
    )!;
    expect(r.kind).toBe(31924);
    expect(r.identifier).toBe('meetups');
    expect(r.title).toBe('Meetups');
    expect(r.description).toBe('All our meetups');
    expect(r.eventRefs).toEqual([`31923:${OTHER}:one`, `31922:${OTHER}:two`]);
    expect(r.naddr).toMatch(/^naddr1/);
    expect(r.nostr.pubkey).toBe(PK);
  });

  it('rejects a calendar without d or title, and non-31924 kinds', () => {
    expect(eventToCalendarCollection(ev(31924, [['d', 'x']]))).toBeNull();
    expect(eventToCalendarCollection(ev(31923, [['d', 'x'], ['title', 'T']]))).toBeNull();
  });
});

describe('eventToRsvp (kind 31925)', () => {
  it('reads status, free/busy, the event coordinate, revision id and the event author', () => {
    const r = eventToRsvp(
      ev(
        31925,
        [
          ['d', 'r1'],
          ['a', `31923:${OTHER}:one`, 'wss://relay.example'],
          ['e', 'f'.repeat(64), 'wss://relay.example'],
          ['status', 'accepted'],
          ['fb', 'busy'],
          ['p', OTHER],
        ],
        'See you there',
      ),
    )!;
    expect(r).toMatchObject({
      kind: 31925,
      identifier: 'r1',
      status: 'accepted',
      freeBusy: 'busy',
      eventRef: `31923:${OTHER}:one`,
      eventId: 'f'.repeat(64),
      eventAuthor: OTHER,
      note: 'See you there',
    });
  });

  it('ignores an RSVP without a valid status (spec: status is required)', () => {
    expect(eventToRsvp(ev(31925, [['d', 'r'], ['a', `31923:${OTHER}:one`], ['status', 'maybe']]))).toBeNull();
    expect(eventToRsvp(ev(31925, [['d', 'r'], ['a', `31923:${OTHER}:one`]]))).toBeNull();
  });

  it('drops fb when the status is declined (spec: must be omitted or ignored)', () => {
    const r = eventToRsvp(ev(31925, [['d', 'r'], ['a', `31923:${OTHER}:one`], ['status', 'declined'], ['fb', 'free']]))!;
    expect(r.freeBusy).toBeUndefined();
  });
});
