import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { buildCalendarFilter } from '../calendar/filters.js';
import { eventsToCalendarEvents } from '../calendar/transform.js';
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
  server.registerTool(
    'search_calendar_events',
    {
      title: 'Search Calendar Events',
      description:
        'Search for NIP-52 calendar events (date-based and time-based). ' +
        'Supports temporal filters (start/end time ranges), geohash location filtering, and hashtag filtering. ' +
        'Returns events from the configured calendar relay. ' +
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
        kinds: z
          .array(z.number())
          .optional()
          .describe(
            'Event kinds to query (default: [31922, 31923]). 31922 = date-based, 31923 = time-based.'
          ),
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
        kinds: params.kinds,
        since: params.since,
        until: params.until,
        limit: params.limit,
      });

      const diag = newRelayDiagnostics();
      const events = await calendarClient.queryEvents(filter, undefined, { diag });
      const calendarEvents = eventsToCalendarEvents(events);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: calendarEvents.length,
              events: calendarEvents,
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
