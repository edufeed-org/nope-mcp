import type { Filter } from 'nostr-tools';
import { normalizeCommunityPubkey } from '../utils/community.js';

/**
 * Parameters for searching NIP-52 calendar events.
 *
 * Extended tag filters (#start_after, etc.) are supported by the calendar relay protocol.
 * Standard relays will ignore them.
 */
export interface CalendarSearchParams {
  /** Unix timestamp — only events starting at or after this time (inclusive) */
  startAfter?: number;
  /** Unix timestamp — only events starting at or before this time (inclusive) */
  startBefore?: number;
  /** Unix timestamp — only events whose effective end is after this time (strict: NIP-52 `end` is exclusive) */
  endAfter?: number;
  /** Unix timestamp — only events whose effective end is at or before this time (inclusive) */
  endBefore?: number;
  /** Geohash prefix for location-based search */
  geohash?: string;
  /** Hashtag filters */
  hashtags?: string[];
  /** Filter by author pubkeys */
  authors?: string[];
  /** Event kinds (default: [31922, 31923]) */
  kinds?: number[];
  /** NIP-01 created_at since */
  since?: number;
  /** NIP-01 created_at until */
  until?: number;
  /** Maximum number of results (1-250, default: 20) */
  limit?: number;
  /** Free-text topic (NIP-50 search on the calendar collection). */
  query?: string;
  /** Community hex pubkey or npub; appends NIP-50 community:<hex> to the search. */
  community?: string;
  /** Only free events (`price` amount 0). `false` adds no filter: a relay facet cannot express "not 0". */
  free?: boolean;
  /** Only events that do (true) / do not (false) require registration. */
  registrationRequired?: boolean;
  /** Only events held online / in person (offline) / hybrid (mixed). */
  attendanceMode?: 'online' | 'offline' | 'mixed';
  /** Only events for this KIM Bildungsstufe concept URI (`#educationalLevel:id`). */
  educationalLevel?: string;
  /** `#a` — referenced coordinates: the event an RSVP answers, a calendar's events, an event's calendar request. */
  references?: string[];
  /** `#p` — participant / event-author pubkeys (hex). */
  participants?: string[];
}

const ATTENDANCE_MODE_URI: Record<NonNullable<CalendarSearchParams['attendanceMode']>, string> = {
  online: 'https://schema.org/OnlineEventAttendanceMode',
  offline: 'https://schema.org/OfflineEventAttendanceMode',
  mixed: 'https://schema.org/MixedEventAttendanceMode',
};

/**
 * Build a Nostr filter for NIP-52 calendar event queries.
 *
 * Extended filters are standard Nostr tag filters passed through as-is.
 * Relays supporting the calendar relay protocol will index them.
 */
export function buildCalendarFilter(params: CalendarSearchParams): Filter {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 250);
  const kinds = params.kinds ?? [31922, 31923];

  const filter: Filter = { kinds, limit };

  const searchTerms: string[] = [];
  if (params.query?.trim()) searchTerms.push(params.query.trim());
  if (params.community) searchTerms.push(`community:${normalizeCommunityPubkey(params.community)}`);
  if (searchTerms.length) filter.search = searchTerms.join(' ');

  if (params.authors?.length) {
    filter.authors = params.authors;
  }
  if (params.since !== undefined) {
    filter.since = params.since;
  }
  if (params.until !== undefined) {
    filter.until = params.until;
  }

  // Extended tag filters for calendar relay protocol
  if (params.startAfter !== undefined) {
    (filter as Record<string, unknown>)['#start_after'] = [String(params.startAfter)];
  }
  if (params.startBefore !== undefined) {
    (filter as Record<string, unknown>)['#start_before'] = [String(params.startBefore)];
  }
  if (params.endAfter !== undefined) {
    (filter as Record<string, unknown>)['#end_after'] = [String(params.endAfter)];
  }
  if (params.endBefore !== undefined) {
    (filter as Record<string, unknown>)['#end_before'] = [String(params.endBefore)];
  }
  if (params.geohash) {
    (filter as Record<string, unknown>)['#g'] = [params.geohash];
  }
  if (params.hashtags?.length) {
    filter['#t'] = params.hashtags;
  }
  if (params.references?.length) {
    filter['#a'] = params.references;
  }
  if (params.participants?.length) {
    filter['#p'] = params.participants;
  }

  // NIP-52-Edufeed attribute facets (nope-relay calendar collection). An
  // event without the tag matches none of these — "no statement" is never
  // "free" or "no registration".
  const ext = filter as Record<string, unknown>;
  if (params.free === true) ext['#price'] = ['0'];
  if (params.registrationRequired !== undefined) {
    ext['#registrationRequired'] = [String(params.registrationRequired)];
  }
  if (params.attendanceMode) ext['#eventAttendanceMode'] = [ATTENDANCE_MODE_URI[params.attendanceMode]];
  if (params.educationalLevel) ext['#educationalLevel:id'] = [params.educationalLevel];

  return filter;
}
