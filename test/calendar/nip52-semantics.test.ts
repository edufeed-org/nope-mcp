import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { eventToCalendarEvent } from '../../src/calendar/transform.js';

const HEX_PUBKEY = 'b'.repeat(64);

function ev(kind: 31922 | 31923, tags: string[][], content = ''): NostrEvent {
  return {
    id: 'e1',
    pubkey: HEX_PUBKEY,
    created_at: 1700000000,
    kind,
    tags: [['d', 'x'], ['title', 'T'], ...tags],
    content,
    sig: 's',
  };
}

// NIP-52 end rules, mirrored from the relay (nip52.EffectiveEnd) and the
// "Calendar events in edufeed" wiki article, so an LLM never has to know
// that `end` is exclusive or that a missing `end` means something.
describe('effective end and all-day flag', () => {
  it('a time-based event without end ends instantaneously at start', () => {
    const r = eventToCalendarEvent(ev(31923, [['start', '1718600000']]))!;
    expect(r.allDay).toBe(false);
    expect(r.effectiveEnd).toBe(1718600000);
    expect(r.lastDay).toBeUndefined();
  });

  it('a time-based event keeps an explicit end after start', () => {
    const r = eventToCalendarEvent(ev(31923, [['start', '1718600000'], ['end', '1718603600']]))!;
    expect(r.effectiveEnd).toBe(1718603600);
  });

  it('a time-based end at or before start is read as instantaneous', () => {
    const r = eventToCalendarEvent(ev(31923, [['start', '1718600000'], ['end', '1718600000']]))!;
    expect(r.effectiveEnd).toBe(1718600000);
  });

  it('a date-based event without end is one day: lastDay = start, effectiveEnd = next midnight UTC', () => {
    const r = eventToCalendarEvent(ev(31922, [['start', '2026-11-20']]))!;
    expect(r.allDay).toBe(true);
    expect(r.lastDay).toBe('2026-11-20');
    expect(r.effectiveEnd).toBe(Date.UTC(2026, 10, 21) / 1000);
  });

  it('a date-based exclusive end yields the inclusive last day', () => {
    const r = eventToCalendarEvent(ev(31922, [['start', '2026-11-20'], ['end', '2026-11-23']]))!;
    expect(r.lastDay).toBe('2026-11-22');
    expect(r.effectiveEnd).toBe(Date.UTC(2026, 10, 23) / 1000);
  });

  it('a legacy inclusive end equal to start (edufeed-app ≤ v0.13.0) is one day', () => {
    const r = eventToCalendarEvent(ev(31922, [['start', '2026-11-20'], ['end', '2026-11-20']]))!;
    expect(r.lastDay).toBe('2026-11-20');
    expect(r.effectiveEnd).toBe(Date.UTC(2026, 10, 21) / 1000);
  });

  it('end_tzid inherits start_tzid when end is present and end_tzid is not', () => {
    const r = eventToCalendarEvent(
      ev(31923, [['start', '1718600000'], ['end', '1718603600'], ['start_tzid', 'Europe/Berlin']]),
    )!;
    expect(r.endTzid).toBe('Europe/Berlin');
  });

  it('no end_tzid is invented for an event without end', () => {
    const r = eventToCalendarEvent(ev(31923, [['start', '1718600000'], ['start_tzid', 'Europe/Berlin']]))!;
    expect(r.endTzid).toBeUndefined();
  });
});

describe('educational attributes (NIP-52-Edufeed)', () => {
  it('reads the wiki worked example', () => {
    const r = eventToCalendarEvent(
      ev(31923, [
        ['start', '1791363600'],
        ['end', '1791367200'],
        ['h', 'c'.repeat(64)],
        ['registrationRequired', 'false'],
        ['price', '0', 'EUR'],
        ['eventAttendanceMode', 'https://schema.org/OnlineEventAttendanceMode'],
        ['educationalLevel:id', 'https://w3id.org/kim/educationalLevel/level_A'],
        ['educationalLevel:prefLabel:de', 'Hochschule'],
        ['educationalLevel:prefLabel:en', 'University'],
        ['educationalLevel:type', 'Concept'],
        ['educationalLevel:id', 'https://w3id.org/kim/educationalLevel/level_C'],
        ['educationalLevel:prefLabel:de', 'Fortbildung'],
        ['educationalLevel:type', 'Concept'],
        ['participant', 'Jane Doe', '', 'speaker'],
        ['participant', 'John Roe'],
      ]),
    )!;
    expect(r.attributes).toEqual({
      registrationRequired: false,
      price: { amount: 0, currency: 'EUR', free: true },
      attendanceMode: 'online',
      attendanceModeUri: 'https://schema.org/OnlineEventAttendanceMode',
      educationalLevel: [
        { id: 'https://w3id.org/kim/educationalLevel/level_A', label: 'Hochschule' },
        { id: 'https://w3id.org/kim/educationalLevel/level_C', label: 'Fortbildung' },
      ],
    });
    expect(r.namedParticipants).toEqual([{ name: 'Jane Doe', role: 'speaker' }, { name: 'John Roe' }]);
    expect(r.communities).toEqual(['c'.repeat(64)]);
  });

  it('omits attributes entirely when no attribute tag is present', () => {
    const r = eventToCalendarEvent(ev(31923, [['start', '1718600000']]))!;
    expect(r.attributes).toBeUndefined();
    expect(r.namedParticipants).toBeUndefined();
    expect(r.communities).toBeUndefined();
  });

  it('applies the wiki read rules: first tag wins, literal booleans, numeric price, tolerant mode', () => {
    const r = eventToCalendarEvent(
      ev(31923, [
        ['start', '1718600000'],
        ['registrationRequired', 'yes'],
        ['registrationRequired', 'true'],
        ['price', '12,50', 'eur'],
        ['price', '0', 'EUR'],
        ['eventAttendanceMode', 'MixedEventAttendanceMode'],
      ]),
    )!;
    expect(r.attributes).toEqual({
      price: { amount: 12.5, currency: 'EUR', free: false },
      attendanceMode: 'mixed',
      attendanceModeUri: 'https://schema.org/MixedEventAttendanceMode',
    });
  });

  it('a non-numeric price amount is no statement', () => {
    const r = eventToCalendarEvent(ev(31923, [['start', '1718600000'], ['price', 'kostenlos', 'EUR']]))!;
    expect(r.attributes).toBeUndefined();
  });

  it('a concept without labels falls back to the URI tail', () => {
    const r = eventToCalendarEvent(
      ev(31923, [['start', '1718600000'], ['educationalLevel:id', 'https://w3id.org/kim/educationalLevel/level_B']]),
    )!;
    expect(r.attributes?.educationalLevel).toEqual([
      { id: 'https://w3id.org/kim/educationalLevel/level_B', label: 'level_B' },
    ]);
  });
});
