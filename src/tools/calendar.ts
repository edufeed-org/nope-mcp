import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AMBRelayClient } from '../relay/client.js';
import { CalendarAuthorCache } from '../calendar/authorInfo.js';
import { getHiddenCalendarSources } from '../calendar/hiddenSources.js';
import { searchCalendarEvents } from '../calendar/search.js';
import { getCalendarAuthorDirectory } from '../authors.js';
import { newRelayDiagnostics, relayDiagnosticsFields } from './relaySelection.js';
import { READ_ONLY } from './annotations.js';

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
              'query — e.g. "events about X in the next week" is one call. With a ' +
              'geohash, the relay runs the topic search and filters one page of 250 hits ' +
              'by location, so "events about X near a place" works but may return fewer than limit.'
          ),
        startAfter: z
          .number()
          .optional()
          .describe('Only events starting at or after this Unix timestamp (inclusive)'),
        startBefore: z
          .number()
          .optional()
          .describe('Only events starting at or before this Unix timestamp (inclusive)'),
        endAfter: z
          .number()
          .optional()
          .describe(
            'Only events still running after this Unix timestamp (strict: NIP-52 `end` is exclusive, so an ' +
              'event ending exactly then is over). "Ongoing or upcoming" = endAfter: now; one-day and ' +
              'instantaneous events are included via their effective end.'
          ),
        endBefore: z
          .number()
          .optional()
          .describe('Only events over by this Unix timestamp (inclusive: an event ending exactly then counts)'),
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
              '"events shared with X next week" is one call. With a geohash the relay applies the ' +
              'community filter in its topic search and post-filters one page of 250 hits by location.',
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
              'the calendar\'s eventRefs. Time-range, geohash and attribute filters match event kinds only, so ' +
              'combining them with 31924/31925 returns no calendars or RSVPs.'
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
      const diag = newRelayDiagnostics();
      const result = await searchCalendarEvents(calendarClient, params, {
        authorCache,
        hidden: getHiddenCalendarSources(),
        directory: getCalendarAuthorDirectory(),
        diag,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...result, ...relayDiagnosticsFields(diag) }),
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
      inputSchema: z.object({}),
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
