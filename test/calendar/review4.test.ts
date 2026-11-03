import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { eventToCalendarEvent } from '../../src/calendar/transform.js';

const PK = 'a'.repeat(64);
const A = 'https://w3id.org/kim/educationalLevel/level_A';
const C = 'https://w3id.org/kim/educationalLevel/level_C';
function base(...tags: string[][]): NostrEvent {
  return { id: 'e', pubkey: PK, created_at: 1700000000, kind: 31923, tags: [['d', 'x'], ['title', 'T'], ['start', '1718600000'], ...tags], content: '', sig: 's' };
}
const levels = (e: NostrEvent) => eventToCalendarEvent(e)!.attributes?.educationalLevel;

// Concept labels follow edufeed-app's calendar-attributes.js: the first
// non-empty label per language wins, an empty id resets the current concept,
// a repeated id keeps the first occurrence's labels, ids are trimmed, and the
// display label is de → en → first language → URI tail.
describe('educationalLevel labels like the app', () => {
  it('skips an empty German label and falls back to English', () => {
    expect(levels(base(['educationalLevel:id', C], ['educationalLevel:prefLabel:de', ''], ['educationalLevel:prefLabel:en', 'Further education']))).toEqual([
      { id: C, label: 'Further education' },
    ]);
  });

  it('keeps the first non-empty label per language', () => {
    expect(levels(base(['educationalLevel:id', A], ['educationalLevel:prefLabel:de', 'Alpha'], ['educationalLevel:prefLabel:de', 'Alpha2']))).toEqual([
      { id: A, label: 'Alpha' },
    ]);
  });

  it('an empty id resets the current concept, so later labels attach to nothing', () => {
    expect(levels(base(['educationalLevel:id', A], ['educationalLevel:id', ''], ['educationalLevel:prefLabel:de', 'Beta']))).toEqual([
      { id: A, label: 'level_A' },
    ]);
  });

  it('a repeated id keeps the first occurrence and ignores the second one\'s labels', () => {
    expect(levels(base(['educationalLevel:id', A], ['educationalLevel:prefLabel:de', 'Erste'], ['educationalLevel:id', A], ['educationalLevel:prefLabel:de', 'Zweite']))).toEqual([
      { id: A, label: 'Erste' },
    ]);
  });

  it('trims ids and labels', () => {
    expect(levels(base(['educationalLevel:id', ` ${C} `], ['educationalLevel:prefLabel:de', ' Fortbildung ']))).toEqual([{ id: C, label: 'Fortbildung' }]);
  });
});

describe('time-based start grammar', () => {
  it('accepts a negative unix timestamp and rejects a leading plus (like the relay)', () => {
    expect(eventToCalendarEvent(base())!.effectiveEnd).toBe(1718600000);
    const neg = eventToCalendarEvent({ ...base(), tags: [['d', 'x'], ['title', 'T'], ['start', '-86400']] })!;
    expect(neg.effectiveEnd).toBe(-86400);
    const plus = eventToCalendarEvent({ ...base(), tags: [['d', 'x'], ['title', 'T'], ['start', '+1718600000']] })!;
    expect(plus.effectiveEnd).toBe(0);
  });
});
