import { describe, it, expect } from 'vitest';
import { buildCalendarFilter } from '../../src/calendar/filters.js';

const PK = 'e'.repeat(64);

describe('buildCalendarFilter NIP-52 reference filters', () => {
  it('references → #a (RSVPs for an event, calendars listing it, events requesting a calendar)', () => {
    const f = buildCalendarFilter({ kinds: [31925], references: [`31923:${PK}:ws`] });
    expect(f['#a']).toEqual([`31923:${PK}:ws`]);
  });

  it('participants → #p', () => {
    const f = buildCalendarFilter({ participants: [PK] });
    expect(f['#p']).toEqual([PK]);
  });

  it('adds neither when empty', () => {
    const f = buildCalendarFilter({ references: [], participants: [] });
    expect(f['#a']).toBeUndefined();
    expect(f['#p']).toBeUndefined();
  });
});
