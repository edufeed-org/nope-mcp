import type { Filter } from 'nostr-tools';
import type { ContentType } from '../content/types.js';
import { SNIPPET_KIND } from '../content/snippet.js';
import { normalizeCommunityPubkey } from '../utils/community.js';
import { OPEN_LICENSE_URIS } from '../license/open.js';

/**
 * Parameters for searching AMB resources
 */
export interface SearchParams {
  /** Free-text search query */
  query?: string;
  /** Filter by publisher name */
  publisherName?: string;
  /** Filter by creator name */
  creatorName?: string;
  /** Filter by subject/topic label */
  subjectLabel?: string;
  /** Filter by learning resource type label */
  resourceTypeLabel?: string;
  /** Filter by educational level label */
  educationalLevelLabel?: string;
  /** Language for label filters (default: 'de') */
  language?: string;
  /** Events created at or after this timestamp */
  since?: number;
  /** Events created at or before this timestamp */
  until?: number;
  /** Filter by author pubkeys */
  authors?: string[];
  /** Maximum number of results (1-250, default: 20) */
  limit?: number;
  /**
   * Restrict to openly licensed resources. Without free text (a pure
   * field-filter or browse search) this appends one `license.id:<uri>` filter
   * per OPEN_LICENSE_URIS entry — the relay ORs repeated filters on the same
   * base field ("license") and ANDs them with every other field filter. With
   * free text no license filter is added, because any field filter disables
   * amb-relay's chunk rerank; the filter limit is over-fetched instead and the
   * caller post-filters and trims to `limit`.
   */
  openLicensesOnly?: boolean;
}

export interface BuildFilterResult {
  /** NIP-01 filter object */
  filter: Filter;
  /** NIP-50 search string (may be empty) */
  search: string;
  /** Results the caller wants; filter.limit may exceed it when over-fetching for a post-filter. */
  limit: number;
}

/** Over-fetch for a free-text open-licenses-only search, post-filtered client-side. */
export const RESOURCE_LICENSE_OVERFETCH_FACTOR = 3;

/**
 * Port of the relay's NIP-50 tokenizer (nostrlib typesense30142
 * tokenizeSearch): split on spaces, a standalone "quoted phrase" is one
 * unquoted token, embedded "quoted" segments stay inside their token.
 */
function tokenizeSearch(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end >= 0) {
        tokens.push(s.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    const start = i;
    while (i < s.length && s[i] !== ' ') {
      if (s[i] === '"') {
        const end = s.indexOf('"', i + 1);
        if (end >= 0) {
          i = end + 1;
          continue;
        }
      }
      i++;
    }
    tokens.push(s.slice(start, i));
  }
  return tokens;
}

/** Relay parseFieldFilter: `field:value` with a non-empty field and a non-empty (unquoted) value. */
function isFieldFilterToken(token: string): boolean {
  const colon = token.indexOf(':');
  return colon > 0 && token.slice(colon + 1).replace(/^"+|"+$/g, '') !== '';
}

/**
 * Mirror of amb-relay `searchHasFreeText`: at least one raw term remains after
 * removing field:value tokens (a `sort:` directive is field-shaped too). Only
 * searches with free text are eligible for the relay's chunk rerank.
 */
export function searchHasFreeText(search: string): boolean {
  return tokenizeSearch(search).some((t) => !isFieldFilterToken(t));
}

/**
 * Build a Nostr filter and NIP-50 search string from search parameters.
 *
 * Field filters use the format: `field.path:value`
 * Multiple values for the same field are OR'd together.
 * Different fields are AND'd together.
 *
 * @see https://git.edufeed.org/edufeed/nostrlib/src/branch/main/eventstore/typesense30142/README.md
 */
export function buildFilter(params: SearchParams): BuildFilterResult {
  const language = params.language || 'de';
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 250);

  // Build NIP-01 filter
  const filter: Filter = {
    kinds: [30142],
    limit,
  };

  if (params.since !== undefined) {
    filter.since = params.since;
  }
  if (params.until !== undefined) {
    filter.until = params.until;
  }
  if (params.authors?.length) {
    filter.authors = params.authors;
  }

  // Build NIP-50 search string with field filters
  const searchParts: string[] = [];

  // Free-text query
  if (params.query?.trim()) {
    searchParts.push(params.query.trim());
  }

  // Field-specific filters
  if (params.publisherName) {
    searchParts.push(`publisher.name:${escapeSearchValue(params.publisherName)}`);
  }
  if (params.creatorName) {
    searchParts.push(`creator.name:${escapeSearchValue(params.creatorName)}`);
  }
  if (params.subjectLabel) {
    searchParts.push(
      `about.prefLabel.${language}:${escapeSearchValue(params.subjectLabel)}`
    );
  }
  if (params.resourceTypeLabel) {
    searchParts.push(
      `learningResourceType.prefLabel.${language}:${escapeSearchValue(params.resourceTypeLabel)}`
    );
  }
  if (params.educationalLevelLabel) {
    searchParts.push(
      `educationalLevel.prefLabel.${language}:${escapeSearchValue(params.educationalLevelLabel)}`
    );
  }
  if (params.openLicensesOnly) {
    if (searchHasFreeText(searchParts.join(' '))) {
      filter.limit = Math.min(limit * RESOURCE_LICENSE_OVERFETCH_FACTOR, 250);
    } else {
      for (const uri of OPEN_LICENSE_URIS) searchParts.push(`license.id:${uri}`);
    }
  }

  return {
    filter,
    search: searchParts.join(' '),
    limit,
  };
}

/**
 * Build a filter for fetching a single resource by identifier
 */
export function buildGetFilter(
  identifier: string,
  author?: string
): Filter {
  const filter: Filter = {
    kinds: [30142],
    '#d': [identifier],
    limit: 1,
  };
  if (author) {
    filter.authors = [author];
  }
  return filter;
}

/**
 * Escape a field-filter value for the relay's NIP-50 tokenizer.
 *
 * The tokenizer splits on spaces, so an unquoted spaced value degenerates
 * into a filter on its first word plus stray free-text terms — which the
 * relay then answers with unrelated results. It supports `field:"quoted
 * value"`, so spaced values are wrapped in double quotes. Embedded double
 * quotes are stripped: the tokenizer has no escape syntax for them.
 */
function escapeSearchValue(value: string): string {
  const cleaned = value.replace(/"/g, '');
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

const CONTENT_TYPE_KINDS: Record<ContentType, number[]> = {
  resource: [30142],
  article: [30023],
  wiki: [30818],
  project: [30143],
  measure: [30144],
  publication: [30040, 30041],
};

export interface ContentSearchParams {
  /** Free-text topic (NIP-50 search). */
  query?: string;
  /** Content types to include; defaults to all. */
  types?: ContentType[];
  since?: number;
  until?: number;
  authors?: string[];
  limit?: number;
  /** Community hex pubkey or npub; appends NIP-50 community:<hex> to the search. */
  community?: string;
}

/**
 * Build a multi-kind NIP-50 filter for cross-content search. The 21142
 * snippet kind is always added so the relay attaches matched passages; the
 * tool partitions those out of the result stream.
 */
export function buildContentFilter(params: ContentSearchParams): Filter {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 250);
  const types: ContentType[] = params.types?.length
    ? params.types
    : (['resource', 'article', 'wiki', 'project', 'measure', 'publication'] as ContentType[]);
  const kinds = types.flatMap((t) => CONTENT_TYPE_KINDS[t]);
  kinds.push(SNIPPET_KIND);

  const filter: Filter = { kinds, limit };
  const searchTerms: string[] = [];
  if (params.query?.trim()) searchTerms.push(params.query.trim());
  if (params.community) searchTerms.push(`community:${normalizeCommunityPubkey(params.community)}`);
  if (searchTerms.length) filter.search = searchTerms.join(' ');
  if (params.since !== undefined) filter.since = params.since;
  if (params.until !== undefined) filter.until = params.until;
  if (params.authors?.length) filter.authors = params.authors;
  return filter;
}
