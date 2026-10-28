import { nip19, type NostrEvent } from 'nostr-tools';
import type { AmbLearningResourceBase, LocalizedString } from 'amb-nostr-converter';
import type { AMBResourceWithMetadata } from '../types/amb.js';
import { getLabel } from '../skos/parser.js';
import { classifyLicense, accessLevelFor, type AccessLevel, type LicenseInfo } from '../license/classify.js';

/**
 * Base URL of the edufeed-app frontend. When set, `toSimplifiedResource`
 * emits a `url` field per resource so LLMs (and other MCP clients) can
 * link users directly to the resource page.
 *
 * The trailing slash is stripped so we can always join with `/<naddr>`.
 */
const EDUFEED_APP_BASE_URL = process.env.EDUFEED_APP_BASE_URL?.replace(/\/+$/, '') || undefined;

/**
 * Encode a NIP-19 naddr for an addressable event and, when
 * EDUFEED_APP_BASE_URL is configured, a frontend URL pointing at it.
 * Both fields are omitted on encoding failure (malformed pubkey, etc.).
 */
export function encodeNaddrAndUrl(
  kind: number,
  pubkey: string,
  dTag: string
): { naddr?: string; url?: string } {
  try {
    const naddr = nip19.naddrEncode({ kind, pubkey, identifier: dTag, relays: [] });
    const url = EDUFEED_APP_BASE_URL ? `${EDUFEED_APP_BASE_URL}/${naddr}` : undefined;
    return { naddr, url };
  } catch {
    return {};
  }
}

/**
 * Get a tag value by name
 */
function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(t => t[0] === name)?.[1];
}

/**
 * Get all tag values by name
 */
function getTags(event: NostrEvent, name: string): string[] {
  return event.tags.filter(t => t[0] === name).map(t => t[1]).filter(Boolean) as string[];
}

/**
 * Extract localized labels from colon-delimited tags
 * e.g., ["about:prefLabel:de", "Mathematik"] -> { de: "Mathematik" }
 */
function extractLocalizedLabels(event: NostrEvent, prefix: string): LocalizedString | undefined {
  const labels: LocalizedString = {};
  for (const tag of event.tags) {
    if (tag[0]?.startsWith(`${prefix}:prefLabel:`)) {
      const lang = tag[0].split(':')[2];
      if (lang && tag[1]) {
        labels[lang] = tag[1];
      }
    }
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

/**
 * Extract concepts from tags (about, learningResourceType, etc.)
 */
function extractConcepts(event: NostrEvent, prefix: string): Array<{ id: string; prefLabel?: LocalizedString }> {
  const concepts: Array<{ id: string; prefLabel?: LocalizedString }> = [];
  const ids = new Set<string>();

  for (const tag of event.tags) {
    if (tag[0] === `${prefix}:id` && tag[1]) {
      ids.add(tag[1]);
    }
  }

  for (const id of ids) {
    const prefLabel = extractLocalizedLabels(event, prefix);
    concepts.push({ id, prefLabel });
  }

  return concepts;
}

/**
 * Extract entities (creator, publisher) from tags
 */
function extractEntities(event: NostrEvent, prefix: string): Array<{ type: string; name: string; id?: string }> {
  const entities: Array<{ type: string; name: string; id?: string }> = [];

  // Get all names for this entity type
  const names = getTags(event, `${prefix}:name`);
  const types = getTags(event, `${prefix}:type`);
  const entityIds = getTags(event, `${prefix}:id`);

  for (let i = 0; i < names.length; i++) {
    entities.push({
      type: types[i] || 'Person',
      name: names[i],
      id: entityIds[i],
    });
  }

  return entities;
}

/**
 * Transform a Nostr event (kind 30142) to an AMB resource with metadata.
 *
 * AMB events store metadata in tags, not JSON content.
 */
export function eventToAMBResource(event: NostrEvent): AMBResourceWithMetadata | null {
  try {
    // Extract d-tag
    const dTag = getTag(event, 'd');
    if (!dTag) {
      console.warn(`Event ${event.id} missing d-tag`);
      return null;
    }

    // Build resource from tags
    const name = getTag(event, 'name');
    if (!name) {
      console.warn(`Event ${event.id} missing name tag`);
      return null;
    }

    // The `r` tag mirrors mainEntityOfPage.id — the resource's original source
    // page. Keep only http(s) values; a resource may carry several.
    const mainEntityOfPage = getTags(event, 'r')
      .filter((r) => /^https?:\/\//.test(r))
      .map((id) => ({ id }));

    const resource: AmbLearningResourceBase = {
      '@context': ['https://schema.org/'],
      id: dTag,
      type: getTags(event, 'type').length > 0 ? getTags(event, 'type') : ['LearningResource'],
      name,
      description: getTag(event, 'description'),
      image: getTag(event, 'image'),
      inLanguage: getTags(event, 'inLanguage'),

      // Educational metadata
      about: extractConcepts(event, 'about'),
      learningResourceType: extractConcepts(event, 'learningResourceType'),
      educationalLevel: extractConcepts(event, 'educationalLevel'),
      audience: extractConcepts(event, 'audience'),

      // Entities (cast to satisfy type requirements)
      creator: extractEntities(event, 'creator') as AmbLearningResourceBase['creator'],
      publisher: extractEntities(event, 'publisher') as AmbLearningResourceBase['publisher'],

      // License
      license: getTag(event, 'license:id') ? {
        id: getTag(event, 'license:id')!,
        name: getTag(event, 'license:name'),
      } : undefined,
      isAccessibleForFree: getTag(event, 'isAccessibleForFree') === 'true',

      // Dates
      datePublished: getTag(event, 'datePublished'),
      dateCreated: getTag(event, 'dateCreated'),
      dateModified: getTag(event, 'dateModified'),

      // Original source page(s), from the event's `r` tag(s)
      mainEntityOfPage: mainEntityOfPage.length ? mainEntityOfPage : undefined,
    };

    return {
      resource,
      nostr: {
        eventId: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
        createdAt: event.created_at,
        dTag,
        sig: event.sig,
      },
    };
  } catch (error) {
    console.error(`Failed to parse event ${event.id}:`, error);
    return null;
  }
}

/**
 * Transform multiple events to AMB resources, filtering out invalid ones.
 */
export function eventsToAMBResources(events: NostrEvent[]): AMBResourceWithMetadata[] {
  return events
    .map(eventToAMBResource)
    .filter((r): r is AMBResourceWithMetadata => r !== null);
}

/**
 * Resolve a concept's label to a single string in the preferred language.
 */
function resolveLabel(prefLabel: LocalizedString | undefined, language: string): string | undefined {
  return getLabel(prefLabel, language);
}

/**
 * Extract a simplified resource representation for MCP tool responses.
 * Resolves all localized labels to a single language to reduce token usage.
 */
export function toSimplifiedResource(ambResource: AMBResourceWithMetadata, language: string = 'de'): SimplifiedAMBResource {
  const { resource, nostr } = ambResource;

  // Encode the addressable Nostr identifier (naddr) and a frontend URL when
  // EDUFEED_APP_BASE_URL is configured. Both are optional in the response —
  // if encoding fails or the env var is unset, callers still get a usable
  // result without the link fields.
  const { naddr, url } = encodeNaddrAndUrl(nostr.kind, nostr.pubkey, nostr.dTag);

  // The resource's original source page: the first http(s) mainEntityOfPage
  // (from the event's `r` tag), falling back to an http(s) d-tag id.
  const sourcePage =
    resource.mainEntityOfPage?.find((m) => /^https?:\/\//.test(m.id))?.id ??
    (/^https?:\/\//.test(resource.id) ? resource.id : undefined);

  const { group: licenseGroup, license } = classifyLicense(resource.license?.id);

  return {
    id: resource.id,
    identifier: resource.id,
    type: resource.type,
    name: resource.name,
    description: resource.description,
    url,
    sourcePage,

    // Educational metadata — resolved to single-language strings
    learningResourceType: resource.learningResourceType
      ?.map(t => resolveLabel(t.prefLabel, language) || t.id)
      .filter((v, i, a) => a.indexOf(v) === i),
    educationalLevel: resource.educationalLevel
      ?.map(l => resolveLabel(l.prefLabel, language) || l.id)
      .filter((v, i, a) => a.indexOf(v) === i),
    about: resource.about
      ?.map(s => resolveLabel(s.prefLabel, language) || s.id)
      .filter((v, i, a) => a.indexOf(v) === i),

    // Authorship — name + type pairs
    creator: resource.creator?.map(c => ({ name: c.name, type: c.type })),
    publisher: resource.publisher?.map(p => ({ name: p.name, type: p.type })),

    // Access — license tier from the event's license:id (see license/classify.ts)
    license,
    accessLevel: accessLevelFor(licenseGroup),
    isAccessibleForFree: resource.isAccessibleForFree,

    // Language
    inLanguage: resource.inLanguage,

    // Dates
    datePublished: resource.datePublished,

    // Nostr metadata
    nostr: {
      eventId: nostr.eventId,
      pubkey: nostr.pubkey,
      createdAt: nostr.createdAt,
      naddr,
    },
  };
}

/**
 * Simplified resource representation for MCP responses.
 * Labels are resolved to single strings, authorship to name arrays.
 */
export interface SimplifiedAMBResource {
  id: string;
  identifier: string;
  type: string[];
  name: string;
  description?: string;

  /**
   * Direct link to the resource on the edufeed-app frontend.
   * Present only when `EDUFEED_APP_BASE_URL` is configured on the server.
   * LLMs should cite this as a markdown link when recommending the resource.
   */
  url?: string;

  /**
   * Direct link to the resource's original source page, derived from the
   * event's `r` tag (mainEntityOfPage), falling back to an http(s) d-tag id.
   * LLMs should prefer this over `url` (the edufeed viewer) when citing.
   */
  sourcePage?: string;

  learningResourceType?: string[];
  educationalLevel?: string[];
  about?: string[];

  creator?: Array<{ name: string; type: string }>;
  publisher?: Array<{ name: string; type: string }>;

  /** Classified `license:id`; null when the resource carries no license. */
  license: LicenseInfo | null;
  /** `full` for CC/PD licenses, `metadata-only` for any other or no license. */
  accessLevel: AccessLevel;
  isAccessibleForFree?: boolean;

  inLanguage?: string[];
  datePublished?: string;

  nostr: {
    eventId: string;
    pubkey: string;
    createdAt: number;
    /**
     * NIP-19 naddr (addressable identifier) for this kind 30142 event.
     * Useful for non-web Nostr clients that want to fetch the event directly.
     */
    naddr?: string;
  };
}
