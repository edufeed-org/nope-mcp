import { nip19, type NostrEvent } from 'nostr-tools';
import {
  eventToAMBResource,
  toSimplifiedResource,
  encodeNaddrAndUrl,
} from '../utils/transform.js';
import type {
  SimplifiedContentResult,
  ResourceResult,
  ArticleResult,
  WikiResult,
  ProjectResult,
  MeasureResult,
  PublicationResult,
} from './types.js';

const EXCERPT_MAX = 300;

function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name).map((t) => t[1]).filter(Boolean);
}

/** Collapse whitespace and cap to EXCERPT_MAX chars, appending an ellipsis. */
function excerpt(content: string): string | undefined {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) + '…' : text;
}

/** Build the event-signer descriptor; npub is omitted if the pubkey can't be encoded. */
function eventAuthor(pubkey: string): { pubkey: string; npub?: string } {
  try {
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  } catch {
    return { pubkey };
  }
}

function resourceToContentResult(event: NostrEvent, language: string): ResourceResult | null {
  const amb = eventToAMBResource(event);
  if (!amb) return null;
  const s = toSimplifiedResource(amb, language);
  const result: ResourceResult = {
    type: 'resource',
    kind: 30142,
    title: s.name,
    description: s.description,
    url: s.url,
    naddr: s.nostr.naddr,
    about: s.about,
    learningResourceType: s.learningResourceType,
    educationalLevel: s.educationalLevel,
    creator: s.creator,
    publisher: s.publisher,
    license: s.license,
    accessLevel: s.accessLevel,
    eventAuthor: eventAuthor(event.pubkey),
    createdAt: event.created_at,
  };
  // Original source page: the event's `r` tag (mainEntityOfPage), with an
  // http(s) d-tag id as fallback — computed once in toSimplifiedResource.
  if (s.sourcePage) result.sourcePage = s.sourcePage;
  return result;
}

function articleToContentResult(event: NostrEvent): ArticleResult | null {
  const d = tag(event, 'd');
  const title = tag(event, 'title');
  if (!d || !title) return null;
  const { naddr, url } = encodeNaddrAndUrl(event.kind, event.pubkey, d);
  const publishedAtRaw = tag(event, 'published_at');
  const topics = tagValues(event, 't');
  const result: ArticleResult = {
    type: 'article',
    kind: 30023,
    title,
    naddr,
    url,
    eventAuthor: eventAuthor(event.pubkey),
    createdAt: event.created_at,
  };
  const summary = tag(event, 'summary');
  if (summary) result.summary = summary;
  const image = tag(event, 'image');
  if (image) result.image = image;
  if (publishedAtRaw && /^\d+$/.test(publishedAtRaw)) result.publishedAt = Number(publishedAtRaw);
  if (topics.length) result.topics = topics;
  const ex = excerpt(event.content);
  if (ex) result.excerpt = ex;
  return result;
}

function wikiToContentResult(event: NostrEvent): WikiResult | null {
  const d = tag(event, 'd');
  // The relay accepts wiki events with only a `d` tag (title is optional),
  // so we must not drop title-less wikis — only the d tag is required here.
  if (!d) return null;
  // Fall back to summary, then d-tag value so title is always non-empty.
  const title = tag(event, 'title') ?? tag(event, 'summary') ?? d;
  const { naddr, url } = encodeNaddrAndUrl(event.kind, event.pubkey, d);
  const topics = tagValues(event, 't');
  const result: WikiResult = {
    type: 'wiki',
    kind: 30818,
    title,
    naddr,
    url,
    eventAuthor: eventAuthor(event.pubkey),
    createdAt: event.created_at,
  };
  const summary = tag(event, 'summary');
  if (summary) result.summary = summary;
  if (topics.length) result.topics = topics;
  const ex = excerpt(event.content);
  if (ex) result.excerpt = ex;
  return result;
}

/**
 * Project the two NIP-DIDACTIC transferkiosk kinds (30143/30144). The relay
 * requires both `d` and `name`, so a missing either drops the event.
 * `partOf` carries the parent project coord from an `a` tag marked
 * `isPartOf` (measures).
 */
function transferkioskToContentResult(
  event: NostrEvent,
  type: 'project' | 'measure',
  kind: 30143 | 30144
): ProjectResult | MeasureResult | null {
  const d = tag(event, 'd');
  const name = tag(event, 'name');
  if (!d || !name) return null;
  const { naddr, url } = encodeNaddrAndUrl(event.kind, event.pubkey, d);
  const result = {
    type,
    kind,
    title: name,
    naddr,
    url,
    eventAuthor: eventAuthor(event.pubkey),
    createdAt: event.created_at,
  } as ProjectResult | MeasureResult;
  const description = tag(event, 'description');
  if (description) result.description = description;
  const summary = tag(event, 'summary');
  if (summary) result.summary = summary;
  const partOf = event.tags.find(
    (t) => t[0] === 'a' && (t[3] === 'isPartOf' || t[3] === 'isOutputOf')
  )?.[1];
  if (partOf) result.partOf = partOf;
  const sourcePage =
    tagValues(event, 'r').find((r) => /^https?:\/\//.test(r)) ??
    (/^https?:\/\//.test(d) ? d : undefined);
  if (sourcePage) result.sourcePage = sourcePage;
  const ex = excerpt(event.content);
  if (ex) result.excerpt = ex;
  return result;
}

/** 64-char hex — the shape of an NKBIP-01 optional event-id hint in an a-tag's 4th position. */
function isHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

/**
 * NKBIP-01 publication: kind 30040 (index) or 30041 (section). Mirrors the
 * relay's a-tag marker rule: isPartOf/isOutputOf → partOf; absent/empty/
 * 64-hex 4th element → sections; any other word marker (vocab concept refs)
 * → neither.
 */
function publicationToContentResult(event: NostrEvent): PublicationResult | null {
  const d = tag(event, 'd');
  const title = tag(event, 'title');
  if (!d || !title) return null;
  const { naddr, url } = encodeNaddrAndUrl(event.kind, event.pubkey, d);
  const result: PublicationResult = {
    type: 'publication',
    kind: event.kind as 30040 | 30041,
    title,
    naddr,
    url,
    eventAuthor: eventAuthor(event.pubkey),
    createdAt: event.created_at,
  };

  if (event.kind === 30041) {
    const ex = excerpt(event.content);
    if (ex) result.excerpt = ex;
    return result;
  }

  const summary = tag(event, 'summary');
  if (summary) result.summary = summary;
  const authors = tagValues(event, 'author');
  if (authors.length) result.authors = authors;
  const identifier = tag(event, 'i');
  if (identifier) {
    result.identifier = identifier;
    if (identifier.startsWith('doi:')) result.doi = identifier.slice(4);
  }
  const publicationType = tag(event, 'type');
  if (publicationType) result.publicationType = publicationType;
  const additionalType = tag(event, 'additionalType');
  if (additionalType) result.additionalType = additionalType;
  const publishedOn = tag(event, 'published_on');
  if (publishedOn) result.publishedOn = publishedOn;
  const publishedBy = tag(event, 'published_by');
  if (publishedBy) result.publishedBy = publishedBy;
  const source = tag(event, 'source');
  if (source && /^https?:\/\//.test(source)) result.sourcePage = source;
  const keywords = tagValues(event, 't');
  if (keywords.length) result.keywords = keywords;
  const language = tag(event, 'inLanguage');
  if (language) result.language = language;
  const license = tag(event, 'license:id');
  if (license) result.license = license;

  const partOf: string[] = [];
  const sections: string[] = [];
  for (const t of event.tags) {
    if (t[0] !== 'a' || !t[1]) continue;
    const marker = t[3] ?? '';
    if (marker === 'isPartOf' || marker === 'isOutputOf') partOf.push(t[1]);
    else if (marker === '' || isHex64(marker)) sections.push(t[1]);
    // other word markers (vocab concept refs) → neither
  }
  if (partOf.length) result.partOf = partOf;
  if (sections.length) result.sections = sections;
  return result;
}

/**
 * Kind → transform registry. Adding a future content type (e.g. a forum
 * kind) is a one-line addition here plus its transform function.
 */
const CONTENT_TRANSFORMS: Record<
  number,
  (event: NostrEvent, language: string) => SimplifiedContentResult | null
> = {
  30142: (event, language) => resourceToContentResult(event, language),
  30023: (event) => articleToContentResult(event),
  30818: (event) => wikiToContentResult(event),
  30143: (event) => transferkioskToContentResult(event, 'project', 30143),
  30144: (event) => transferkioskToContentResult(event, 'measure', 30144),
  30040: (event) => publicationToContentResult(event),
  30041: (event) => publicationToContentResult(event),
};

/** True when transformContentEvent can format this kind (get_resource dispatch). */
export function hasContentTransform(kind: number): boolean {
  return kind in CONTENT_TRANSFORMS;
}

export function transformContentEvent(
  event: NostrEvent,
  language = 'de'
): SimplifiedContentResult | null {
  const fn = CONTENT_TRANSFORMS[event.kind];
  return fn ? fn(event, language) : null;
}

export function transformContentEvents(
  events: NostrEvent[],
  language = 'de'
): SimplifiedContentResult[] {
  const out: SimplifiedContentResult[] = [];
  for (const e of events) {
    const r = transformContentEvent(e, language);
    if (r) out.push(r);
  }
  return out;
}
