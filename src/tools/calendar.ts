import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { buildCalendarFilter } from '../calendar/filters.js';
import {
  eventsToCalendarEvents,
  eventToCalendarCollection,
  eventToRsvp,
  type CalendarCollection,
  type CalendarRsvp,
} from '../calendar/transform.js';
import { CalendarAuthorCache } from '../calendar/authorInfo.js';
import { getHiddenCalendarSources, partitionHiddenCalendarSources } from '../calendar/hiddenSources.js';
import { getCalendarAuthorDirectory } from '../authors.js';
import { newRelayDiagnostics, relayDiagnosticsFields } from './relaySelection.js';
import { READ_ONLY } from './annotations.js';

/** Relay page size; the over-fetch ceiling when hidden sources are dropped client-side. */
const RELAY_MAX_LIMIT = 250;

/**
 * Register calendar event tools with the MCP server
 */
export function registerCalendarTools(
  server: McpServer,
  calendarClient: AMBRelayClient
): void {
  // Author names + NIP-24 bot flags come from the calendar relay's kind-0
  // index (nope-relay PROFILES_ENABLED); one lookup per author per cache
  // lifetime, misses included.
  const authorCache = new CalendarAuthorCache((pubkeys) =>
    calendarClient.queryEvents({ kinds: [0], authors: pubkeys, limit: pubkeys.length }),
  );

  server.registerTool(
    'search_calendar_events',
    {
      title: 'Search Calendar Events',
      description:
        'Search for NIP-52 calendar events (date-based and time-based). ' +
        'Supports temporal filters (start/end time ranges), geohash location filtering, hashtag filtering, ' +
        'and the edufeed educational attributes (free, registrationRequired, attendanceMode, educationalLevel). ' +
        'Returns events from the configured calendar relay. ' +
        'TIME SEMANTICS (NIP-52): `start`/`end` are the raw tags — `end` is EXCLUSIVE and is omitted for ' +
        'one-day and instantaneous events, so never read a missing `end` as "unknown". Use `effectiveEnd` ' +
        '(Unix seconds when the event is over), `allDay` (31922: whole days, no clock time) and `lastDay` ' +
        '(all-day events: the inclusive last calendar day). Times of 31923 events are in `startTzid`/`endTzid`. ' +
        'ATTRIBUTES: `attributes` carries registration, price (free = amount 0), attendance mode ' +
        '(online/offline/mixed) and Bildungsstufe; a missing field means "no statement", never "no" or "not free". ' +
        'AUTHOR: every event has `author` {name, bot}; `bot: true` marks an automated account such as an event ' +
        'mirror or crawler — group or de-emphasise those unless the user asks for imports. Operators may hide ' +
        'bulk sources by default (see `hiddenSources` in the result); pass includeHiddenSources: true to see them. ' +
        'When presenting an event to the user, render it as a markdown link: prefer the ' +
        'event `url` (the edufeed-app viewer at <base>/<naddr>, which shows fuller details) ' +
        'over `sourcePage` (the original external event page). Never construct an naddr or ' +
        'viewer URL yourself — use the `naddr`/`url` fields as returned.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Free-text topic for the events. Combines with a time range ' +
              '(startAfter/startBefore/endAfter/endBefore) in a single server-side ' +
              'query — e.g. "events about X in the next week" is one call. ' +
              'EXCEPTION: a geohash query forces the relay location index, which ' +
              'ignores this topic; for "events about X near a place" pass the geohash ' +
              'and filter the returned events by topic on the client.'
          ),
        startAfter: z
          .number()
          .optional()
          .describe(
            'Only events starting after this Unix timestamp'
          ),
        startBefore: z
          .number()
          .optional()
          .describe(
            'Only events starting before this Unix timestamp'
          ),
        endAfter: z
          .number()
          .optional()
          .describe(
            'Only events ending after this Unix timestamp'
          ),
        endBefore: z
          .number()
          .optional()
          .describe(
            'Only events ending before this Unix timestamp'
          ),
        geohash: z
          .string()
          .optional()
          .describe('Geohash prefix for location-based search'),
        hashtags: z
          .array(z.string())
          .optional()
          .describe('Filter by hashtags (e.g., ["meetup", "nostr"])'),
        authors: z
          .array(z.string())
          .optional()
          .describe('Filter by author pubkeys (hex format)'),
        community: z
          .string()
          .optional()
          .describe(
            'Return calendar events shared into this community (Communikey). Accepts a hex pubkey ' +
              'or npub; resolve a community name with resolve_author. Combines with a time range ' +
              '(startAfter/startBefore/endAfter/endBefore) in a single server-side query, so ' +
              '"events shared with X next week" is one call. EXCEPTION: a geohash query forces the ' +
              'relay location index, which ignores this community filter; for "shared with X near a ' +
              'place" pass the geohash and filter the returned events by community client-side.',
          ),
        free: z
          .boolean()
          .optional()
          .describe(
            'true: only events tagged free of charge (price 0). Events without a price statement are NOT ' +
              'returned, so leave it unset unless the user insists on free. false adds no filter.'
          ),
        registrationRequired: z
          .boolean()
          .optional()
          .describe('Only events that do (true) or do not (false) require registration; untagged events match neither.'),
        attendanceMode: z
          .enum(['online', 'offline', 'mixed'])
          .optional()
          .describe('Only online, in-person (offline) or hybrid (mixed) events; untagged events match none.'),
        educationalLevel: z
          .string()
          .optional()
          .describe(
            'Only events for this KIM Bildungsstufe concept URI, e.g. https://w3id.org/kim/educationalLevel/level_C ' +
              '(Fortbildung), level_A (Hochschule), level_B (Vorbereitungsdienst), level_1 (Primarbereich).'
          ),
        includeHiddenSources: z
          .boolean()
          .optional()
          .describe(
            'Also return events from operator-hidden bulk sources (event mirrors, imported catalogues). ' +
              'Default false; the result reports how many were hidden.'
          ),
        kinds: z
          .array(z.union([z.literal(31922), z.literal(31923), z.literal(31924), z.literal(31925)]))
          .optional()
          .describe(
            'NIP-52 kinds to query (default: [31922, 31923]). 31922 = date-based event, 31923 = time-based ' +
              'event (both in `events`); 31924 = calendar, a titled list of event coordinates (in `calendars`); ' +
              '31925 = RSVP, one user\'s attendance intention (in `rsvps`). "Who is coming to event X" = ' +
              'kinds [31925] with the event\'s coordinate in `references`; "events in calendar Y" = resolve ' +
              'the calendar\'s eventRefs. Time-range, geohash and attribute filters apply to event kinds only.'
          ),
        references: z
          .array(z.string())
          .optional()
          .describe(
            'Filter by referenced coordinates (`a` tags): with kinds [31925] the event an RSVP answers ' +
              '(`31923:<pubkey>:<d>`); with kinds [31924] calendars listing that event; with event kinds, ' +
              'events requesting inclusion in that calendar (`31924:<pubkey>:<d>`).'
          ),
        participants: z
          .array(z.string())
          .optional()
          .describe('Filter by participant pubkeys (`p` tags, hex): events naming them, or RSVPs to their events.'),
        since: z
          .number()
          .optional()
          .describe('Return events created at or after this Unix timestamp'),
        until: z
          .number()
          .optional()
          .describe('Return events created at or before this Unix timestamp'),
        limit: z
          .number()
          .min(1)
          .max(250)
          .optional()
          .default(20)
          .describe('Maximum number of results (1-250, default: 20)'),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      const hidden = getHiddenCalendarSources();
      // Hidden sources are dropped client-side (a Nostr filter cannot
      // exclude authors), so over-fetch to the relay page size and cut back
      // to the requested limit afterwards.
      const dropHidden = hidden.size > 0 && !params.includeHiddenSources;
      const filter = buildCalendarFilter({
        query: params.query,
        startAfter: params.startAfter,
        startBefore: params.startBefore,
        endAfter: params.endAfter,
        endBefore: params.endBefore,
        geohash: params.geohash,
        hashtags: params.hashtags,
        authors: params.authors,
        community: params.community,
        free: params.free,
        registrationRequired: params.registrationRequired,
        attendanceMode: params.attendanceMode,
        educationalLevel: params.educationalLevel,
        kinds: params.kinds,
        references: params.references,
        participants: params.participants,
        since: params.since,
        until: params.until,
        limit: dropHidden ? RELAY_MAX_LIMIT : params.limit,
      });

      const diag = newRelayDiagnostics();
      const raw = await calendarClient.queryEvents(filter, undefined, { diag });
      const calendars: CalendarCollection[] = [];
      const rsvps: CalendarRsvp[] = [];
      for (const e of raw) {
        if (e.kind === 31924) {
          const c = eventToCalendarCollection(e);
          if (c) calendars.push(c);
        } else if (e.kind === 31925) {
          const r = eventToRsvp(e);
          if (r) rsvps.push(r);
        }
      }
      const partition = partitionHiddenCalendarSources(eventsToCalendarEvents(raw), hidden, {
        showHidden: !dropHidden,
      });
      const calendarEvents = dropHidden ? partition.shown.slice(0, params.limit) : partition.shown;

      const directory = getCalendarAuthorDirectory();
      const authors = await authorCache.lookup(calendarEvents.map((e) => e.nostr.pubkey));
      for (const event of calendarEvents) {
        const info = authors.get(event.nostr.pubkey) ?? { pubkey: event.nostr.pubkey, bot: false };
        const fromDirectory = directory?.authors.find((a) => a.pubkey === event.nostr.pubkey)?.name;
        event.author = info.name || !fromDirectory ? info : { ...info, name: fromDirectory };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: calendarEvents.length,
              events: calendarEvents,
              ...(calendars.length > 0 ? { calendars } : {}),
              ...(rsvps.length > 0 ? { rsvps } : {}),
              ...(hidden.size > 0
                ? {
                    hiddenSources: {
                      hidden: partition.hidden,
                      included: !dropHidden,
                      note: dropHidden
                        ? 'Events from operator-hidden bulk sources (event mirrors, imported catalogues) were left out of one relay page of 250, so fewer than `limit` may remain; pass includeHiddenSources: true to see them.'
                        : 'Events from operator-hidden bulk sources are included; their author.bot flag marks automated accounts.',
                    },
                  }
                : {}),
              ...relayDiagnosticsFields(diag),
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    'list_calendar_authors',
    {
      title: 'List Calendar Authors',
      description:
        'List known calendar event authors loaded from configured follow sets (NIP-51 kind 30000). ' +
        'Returns author names, pubkeys, and NIP-05 identifiers. Use the returned pubkeys with ' +
        'search_calendar_events(authors: [...]) to filter events by author.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const directory = getCalendarAuthorDirectory();

      if (!directory) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'not_configured',
                message:
                  'No calendar author sets configured. Set the CALENDAR_AUTHOR_SETS environment variable to a comma-separated list of naddr identifiers for kind 30000 follow sets.',
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              totalAuthors: directory.authors.length,
              totalSets: directory.sets.length,
              authors: directory.authors.map((a) => ({
                pubkey: a.pubkey,
                name: a.name,
                nip05: a.nip05,
                about: a.about,
                sets: a.sets,
              })),
              sets: directory.sets,
            }),
          },
        ],
      };
    }
  );
}
