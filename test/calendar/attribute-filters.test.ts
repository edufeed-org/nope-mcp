import { describe, it, expect } from 'vitest';
import { buildCalendarFilter } from '../../src/calendar/filters.js';

const tag = (f: object, name: string) => (f as Record<string, unknown>)[name];

describe('buildCalendarFilter educational attribute filters', () => {
  it('free → #price ["0"]', () => {
    expect(tag(buildCalendarFilter({ free: true }), '#price')).toEqual(['0']);
  });

  it('free:false adds no price filter (the relay cannot express "not 0")', () => {
    expect(tag(buildCalendarFilter({ free: false }), '#price')).toBeUndefined();
  });

  it('registrationRequired → literal true/false', () => {
    expect(tag(buildCalendarFilter({ registrationRequired: true }), '#registrationRequired')).toEqual(['true']);
    expect(tag(buildCalendarFilter({ registrationRequired: false }), '#registrationRequired')).toEqual(['false']);
  });

  it('attendanceMode → the schema.org URI', () => {
    expect(tag(buildCalendarFilter({ attendanceMode: 'online' }), '#eventAttendanceMode')).toEqual([
      'https://schema.org/OnlineEventAttendanceMode',
    ]);
    expect(tag(buildCalendarFilter({ attendanceMode: 'mixed' }), '#eventAttendanceMode')).toEqual([
      'https://schema.org/MixedEventAttendanceMode',
    ]);
  });

  it('educationalLevel → #educationalLevel:id', () => {
    expect(
      tag(buildCalendarFilter({ educationalLevel: 'https://w3id.org/kim/educationalLevel/level_C' }), '#educationalLevel:id'),
    ).toEqual(['https://w3id.org/kim/educationalLevel/level_C']);
  });
});
