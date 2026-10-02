import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import {
  relaysNotSearched, resolveRelaysOrError, newRelayDiagnostics, relayDiagnosticsFields,
} from './relaySelection.js';
import { buildFilter, type SearchParams } from '../relay/filters.js';
import { eventsToAMBResources, toSimplifiedResource, type SimplifiedAMBResource } from '../utils/transform.js';
import { findActorCandidates, type ActorCandidate } from './resolvePublisher.js';
import { READ_ONLY } from './annotations.js';

export interface ResourceSearchResult {
  total: number;
  resources: SimplifiedAMBResource[];
  /** Similar actor spellings found when an exact publisher/creator filter matched nothing. */
  actorCandidates?: ActorCandidate[];
  /** Recovery guidance for the zero-match actor-filter case. */
  hint?: string;
  /** Relays that timed out or were unreachable (an empty result may be incomplete). */
  relaysIncomplete?: string[];
  /** Human/LLM-facing warning when relaysIncomplete is non-empty. */
  warning?: string;
}

/**
 * Execute a resource search. When a publisherName/creatorName filter matches
 * nothing, fall back to a free-text search on that name and suggest the
 * similar actor spellings the corpus actually uses — the filters are exact
 * full-string matches, so a guessed spelling ("Lehreladen" vs the stored
 * "LEHRE LADEN") would otherwise dead-end in a silent empty result.
 */
export async function runResourceSearch(
  client: Pick<AMBRelayClient, 'search' | 'query'>,
  params: SearchParams,
  relays?: string[]
): Promise<ResourceSearchResult> {
  const { filter, search } = buildFilter(params);

  const diag = newRelayDiagnostics();
  const events = search
    ? await client.search(search, filter, relays, diag)
    : await client.query(filter, relays, diag);

  const resources = eventsToAMBResources(events);
  const lang = params.language || 'de';
  const simplified = resources.map((r) => toSimplifiedResource(r, lang));
  const result: ResourceSearchResult = {
    total: simplified.length,
    resources: simplified,
    ...relayDiagnosticsFields(diag),
  };

  const actorName = params.publisherName ?? params.creatorName;
  if (simplified.length === 0 && actorName) {
    const candidates = await findActorCandidates(client, actorName, relays);
    if (candidates.length > 0) {
      result.actorCandidates = candidates;
      result.hint =
        `publisherName/creatorName filters are exact full-string matches; nothing matched ` +
        `"${actorName}". Similar actor names in the corpus: ` +
        candidates.map((c) => `${c.name} (${c.field}, ${c.count} sampled resources)`).join(', ') +
        `. Retry with the exact spelling.`;
    } else {
      result.hint =
        `publisherName/creatorName filters are exact full-string matches and nothing matched ` +
        `"${actorName}"; no similar actor name was found either. The actor may not exist in ` +
        `this corpus — try resolve_publisher, resolve_author, or a free-text query search.`;
    }
  }

  return result;
}

/**
 * Register the search_resources tool
 */
export function registerSearchTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'search_resources',
    {
      title: 'Search Educational Resources',
      description:
        'Search for educational resources (learning materials, courses, videos, etc.) using ' +
        'full-text search and metadata filters. Returns resources matching the query from the ' +
        'AMB relay. NOTE: the metadata filters (publisherName, creatorName, subjectLabel, ' +
        'resourceTypeLabel, educationalLevelLabel) are EXACT full-string matches against the ' +
        'stored metadata (case-insensitive) — not fuzzy or substring searches. A guessed ' +
        'spelling silently returns 0 results; use resolve_publisher to find the canonical ' +
        'actor spelling first. On a zero-match actor filter the response includes ' +
        'actorCandidates with similar spellings to retry with.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free-text search query (e.g., "mathematik", "machine learning")'),
        publisherName: z
          .string()
          .optional()
          .describe(
            'Filter by publisher name — EXACT full-string match (case-insensitive) against ' +
              'the AMB metadata, e.g. "e-teaching.org" or "LEHRE LADEN" (not "Lehreladen"). ' +
              'Unsure of the spelling? Call resolve_publisher first.'
          ),
        creatorName: z
          .string()
          .optional()
          .describe(
            'Filter by creator/author name — EXACT full-string match (case-insensitive) ' +
              'against the AMB metadata. Unsure of the spelling? Call resolve_publisher first.'
          ),
        subjectLabel: z
          .string()
          .optional()
          .describe(
            'Filter by subject/topic label — EXACT label match (e.g., "Mathematik", ' +
              '"Physik"); browse_subjects lists valid labels'
          ),
        resourceTypeLabel: z
          .string()
          .optional()
          .describe(
            'Filter by resource type label — EXACT label match (e.g., "Video", "Kurs", ' +
              '"Arbeitsblatt"); browse_resource_types lists valid labels'
          ),
        educationalLevelLabel: z
          .string()
          .optional()
          .describe(
            'Filter by educational level — EXACT label match (e.g., "Sekundarstufe I", ' +
              '"Hochschule"); browse_educational_levels lists valid labels'
          ),
        language: z
          .string()
          .optional()
          .default('de')
          .describe('Language for label filters (default: "de")'),
        since: z
          .number()
          .optional()
          .describe('Return resources created at or after this Unix timestamp'),
        until: z
          .number()
          .optional()
          .describe('Return resources created at or before this Unix timestamp'),
        authors: z
          .array(z.string())
          .optional()
          .describe('Filter by author pubkeys (hex format)'),
        limit: z
          .number()
          .min(1)
          .max(250)
          .optional()
          .default(20)
          .describe('Maximum number of results (1-250, default: 20)'),
        relays: z
          .array(z.string())
          .optional()
          .describe(
            'Restrict the search to specific relays. Only relays returned by list_relays ' +
              '(default or extra) are accepted, by full URL or short name (e.g. "oersi", "sodix"). ' +
              'Default: the default relay set.'
          ),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      const selection = resolveRelaysOrError(client, params.relays);
      if ('errorPayload' in selection) {
        return { content: [{ type: 'text', text: JSON.stringify(selection.errorPayload) }] };
      }
      const relaysSearched = selection.relays;
      const searchParams: SearchParams = {
        query: params.query,
        publisherName: params.publisherName,
        creatorName: params.creatorName,
        subjectLabel: params.subjectLabel,
        resourceTypeLabel: params.resourceTypeLabel,
        educationalLevelLabel: params.educationalLevelLabel,
        language: params.language,
        since: params.since,
        until: params.until,
        authors: params.authors,
        limit: params.limit,
      };

      const result = await runResourceSearch(client, searchParams, relaysSearched);
      const notSearched = relaysNotSearched(client, relaysSearched);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              relaysSearched,
              ...(notSearched.length > 0 ? { relaysNotSearched: notSearched } : {}),
              ...result,
            }),
          },
        ],
      };
    }
  );
}
