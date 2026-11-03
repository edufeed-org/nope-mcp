import type { NostrEvent } from 'nostr-tools';
import { encodeNaddrAndUrl } from '../utils/transform.js';
import type { CalendarAuthorInfo } from './authorInfo.js';

export interface CalendarEventParticipant {
  pubkey: string;
  relay?: string;
  role?: string;
}

/** A named person without a Nostr key, from edufeed's `participant` tag. */
export interface NamedParticipant {
  name: string;
  role?: string;
}

export type AttendanceMode = 'online' | 'offline' | 'mixed';

/**
 * The NIP-52-Edufeed educational attributes ("Calendar events in edufeed"
 * wiki article). Every field is optional: an absent field is "no statement",
 * never "no" / "not free".
 */
export interface CalendarEventAttributes {
  registrationRequired?: boolean;
  /** `free` is `amount === 0`; a positive amount is a paid event. */
  price?: { amount: number; currency?: string; free: boolean };
  attendanceMode?: AttendanceMode;
  /** The schema.org URI as written (normalised for the three known modes). */
  attendanceModeUri?: string;
  /** KIM Bildungsstufe concepts; `label` is the German prefLabel or the URI tail. */
  educationalLevel?: { id: string; label: string }[];
}

export interface CalendarEvent {
  kind: number;
  identifier: string;
  title: string;
  summary?: string;
  description?: string;
  image?: string;
  /** Raw `start` tag: Unix seconds (31923) or YYYY-MM-DD (31922). */
  start: string;
  /** Raw `end` tag, when present. NIP-52: EXCLUSIVE, and omitted for one-day / instantaneous events — use `effectiveEnd` / `lastDay`. */
  end?: string;
  /** True for date-based (31922) events: whole days, no clock time. */
  allDay: boolean;
  /**
   * Unix seconds when the event is over, per NIP-52: the explicit end when
   * it is after the start; otherwise the start itself (31923, "ends
   * instantaneously") or the start of the next UTC day (31922, one-day
   * event). An `end` at or before `start` counts as missing (legacy writers
   * put the inclusive last day in `end`).
   */
  effectiveEnd: number;
  /** 31922 only: the INCLUSIVE last day (YYYY-MM-DD), derived from the exclusive `end`. */
  lastDay?: string;
  startTzid?: string;
  /** Inherits `startTzid` when the event has an end but no `end_tzid` (NIP-52). */
  endTzid?: string;
  locations?: string[];
  geohash?: string;
  hashtags?: string[];
  references?: string[];
  /** Canonical external source page (e-teaching.org etc.), from the `r` tag. */
  sourcePage?: string;
  /** Participants with a Nostr key (`p` tags). */
  participants?: CalendarEventParticipant[];
  /** Named speakers/organizers without a key (`participant` tags). */
  namedParticipants?: NamedParticipant[];
  /** Communities the author targeted (`h` tags, Communikey pubkeys). */
  communities?: string[];
  /** Educational attributes; absent when the event carries none. */
  attributes?: CalendarEventAttributes;
  /** Author profile info (name, NIP-24 bot flag); attached by the tool layer. */
  author?: CalendarAuthorInfo;
  /** NIP-19 naddr for this addressable event; omitted on encoding failure. */
  naddr?: string;
  /** edufeed-app viewer URL (`<base>/<naddr>`); present only when EDUFEED_APP_BASE_URL is set. */
  url?: string;
  nostr: {
    eventId: string;
    pubkey: string;
    createdAt: number;
  };
}

const SECONDS_PER_DAY = 86400;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a NIP-52 date-based value (YYYY-MM-DD) into Unix seconds at UTC midnight. */
function parseDay(value: string | undefined): number | undefined {
  const m = value ? DATE_RE.exec(value) : null;
  if (!m) return undefined;
  const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(ts)) return undefined;
  // Reject rollover dates like 2026-02-31 (Date.UTC silently rolls them).
  return formatDay(ts / 1000) === value ? ts / 1000 : undefined;
}

function formatDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function parseSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/**
 * NIP-52 end rules, shared with the relay (nip52.EffectiveEnd in nostrlib):
 * see CalendarEvent.effectiveEnd. Returns 0 when the start is unparseable.
 */
export function effectiveEnd(
  kind: number,
  start: string,
  end: string | undefined,
): { effectiveEnd: number; lastDay?: string } {
  if (kind === 31922) {
    const s = parseDay(start);
    if (s === undefined) return { effectiveEnd: 0 };
    const e = parseDay(end);
    if (e !== undefined && e > s) return { effectiveEnd: e, lastDay: formatDay(e - SECONDS_PER_DAY) };
    return { effectiveEnd: s + SECONDS_PER_DAY, lastDay: start };
  }
  const s = parseSeconds(start);
  if (s === undefined) return { effectiveEnd: 0 };
  const e = parseSeconds(end);
  return { effectiveEnd: e !== undefined && e > s ? e : s };
}

const ATTENDANCE_MODES: Record<string, AttendanceMode> = {
  OnlineEventAttendanceMode: 'online',
  OfflineEventAttendanceMode: 'offline',
  MixedEventAttendanceMode: 'mixed',
};

/** Wiki read rule: tolerate http:// and a bare term; canonical form is the https://schema.org URI. */
function readAttendanceMode(value: string): { attendanceMode?: AttendanceMode; attendanceModeUri: string } {
  const term = value.replace(/^https?:\/\/schema\.org\//, '');
  const mode = ATTENDANCE_MODES[term];
  return mode ? { attendanceMode: mode, attendanceModeUri: `https://schema.org/${term}` } : { attendanceModeUri: value };
}

/** Wiki read rule: a non-negative number (decimal comma accepted); anything else is no statement. */
function readPrice(tag: string[]): CalendarEventAttributes['price'] | undefined {
  const amount = Number((tag[1] ?? '').trim().replace(',', '.'));
  if ((tag[1] ?? '').trim() === '' || !Number.isFinite(amount) || amount < 0) return undefined;
  const currency = (tag[2] ?? '').trim().toUpperCase();
  return { amount, ...(currency ? { currency } : {}), free: amount === 0 };
}

/**
 * Read the educational attributes off the tags with the wiki's rules: the
 * first tag of each name wins (even when invalid), `registrationRequired`
 * only counts literal true/false, concept triples are read in tag order with
 * German labels preferred and the URI tail as fallback.
 */
function readAttributes(event: NostrEvent): CalendarEventAttributes | undefined {
  const attrs: CalendarEventAttributes = {};
  let registrationSeen = false;
  let priceSeen = false;
  const levels: { id: string; label?: string; anyLabel?: string }[] = [];
  const levelIds = new Set<string>();

  for (const tag of event.tags) {
    if (tag.length < 2) continue;
    switch (tag[0]) {
      case 'registrationRequired':
        if (!registrationSeen) {
          registrationSeen = true;
          if (tag[1] === 'true' || tag[1] === 'false') attrs.registrationRequired = tag[1] === 'true';
        }
        break;
      case 'price':
        if (!priceSeen) {
          priceSeen = true;
          const price = readPrice(tag);
          if (price) attrs.price = price;
        }
        break;
      case 'eventAttendanceMode':
        if (!attrs.attendanceModeUri) Object.assign(attrs, readAttendanceMode(tag[1]));
        break;
      case 'educationalLevel:id':
        if (!levelIds.has(tag[1])) {
          levelIds.add(tag[1]);
          levels.push({ id: tag[1] });
        } else {
          // A repeated concept: route its labels to the existing entry.
          const existing = levels.find((l) => l.id === tag[1])!;
          levels.push(existing);
        }
        break;
      default:
        if (tag[0].startsWith('educationalLevel:prefLabel:') && levels.length > 0) {
          const current = levels[levels.length - 1];
          if (tag[0] === 'educationalLevel:prefLabel:de') current.label = tag[1];
          else current.anyLabel ??= tag[1];
        }
    }
  }

  if (levels.length > 0) {
    const seen = new Set<string>();
    attrs.educationalLevel = levels
      .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
      .map((l) => ({ id: l.id, label: l.label ?? l.anyLabel ?? l.id.split('/').filter(Boolean).pop() ?? l.id }));
  }

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

/**
 * Extract the first value for a given tag name from a Nostr event.
 */
function getTagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Extract all values for a given tag name from a Nostr event.
 */
function getTagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name).map((t) => t[1]);
}

/**
 * Transform a NIP-52 calendar event (kind 31922 or 31923) into a CalendarEvent.
 * Returns null if the event is missing required fields (d, title/name, start).
 */
export function eventToCalendarEvent(event: NostrEvent): CalendarEvent | null {
  const identifier = getTagValue(event, 'd');
  const title = getTagValue(event, 'title') ?? getTagValue(event, 'name');
  const start = getTagValue(event, 'start');

  if (!identifier || !title || !start) {
    return null;
  }

  const locations = getTagValues(event, 'location');
  const hashtags = getTagValues(event, 't');
  const references = getTagValues(event, 'r');

  // Parse participants from p tags: ["p", pubkey, relay?, role?]
  const participants: CalendarEventParticipant[] = event.tags
    .filter((t) => t[0] === 'p' && t[1])
    .map((t) => ({
      pubkey: t[1],
      ...(t[2] ? { relay: t[2] } : {}),
      ...(t[3] ? { role: t[3] } : {}),
    }));

  const end = getTagValue(event, 'end');
  const ends = effectiveEnd(event.kind, start, end);

  const result: CalendarEvent = {
    kind: event.kind,
    identifier,
    title,
    start,
    allDay: event.kind === 31922,
    effectiveEnd: ends.effectiveEnd,
    ...(ends.lastDay ? { lastDay: ends.lastDay } : {}),
    nostr: {
      eventId: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at,
    },
  };

  const { naddr, url } = encodeNaddrAndUrl(event.kind, event.pubkey, identifier);
  if (naddr) result.naddr = naddr;
  if (url) result.url = url;

  // Optional fields — only include if present
  const summary = getTagValue(event, 'summary');
  if (summary) result.summary = summary;

  if (event.content) result.description = event.content;

  const image = getTagValue(event, 'image');
  if (image) result.image = image;

  if (end) result.end = end;

  const startTzid = getTagValue(event, 'start_tzid');
  if (startTzid) result.startTzid = startTzid;

  // NIP-52: a missing end_tzid means the end is in the start_tzid zone.
  const endTzid = getTagValue(event, 'end_tzid') ?? (end ? startTzid : undefined);
  if (endTzid) result.endTzid = endTzid;

  if (locations.length > 0) result.locations = locations;

  const geohash = getTagValue(event, 'g');
  if (geohash) result.geohash = geohash;

  if (hashtags.length > 0) result.hashtags = hashtags;
  if (references.length > 0) result.references = references;
  const sourcePage = references.find((r) => /^https?:\/\//.test(r));
  if (sourcePage) result.sourcePage = sourcePage;
  if (participants.length > 0) result.participants = participants;

  const named: NamedParticipant[] = event.tags
    .filter((t) => t[0] === 'participant' && t[1])
    .map((t) => ({ name: t[1], ...(t[3] ? { role: t[3] } : {}) }));
  if (named.length > 0) result.namedParticipants = named;

  const communities = getTagValues(event, 'h').filter(Boolean);
  if (communities.length > 0) result.communities = communities;

  const attributes = readAttributes(event);
  if (attributes) result.attributes = attributes;

  return result;
}

/**
 * Transform multiple Nostr events into CalendarEvents, filtering invalid ones.
 */
export function eventsToCalendarEvents(events: NostrEvent[]): CalendarEvent[] {
  const results: CalendarEvent[] = [];
  for (const event of events) {
    const cal = eventToCalendarEvent(event);
    if (cal) results.push(cal);
  }
  return results;
}
