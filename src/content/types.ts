import type { AccessLevel, LicenseInfo } from '../license/classify.js';

/** Discriminant for the unified content result. */
export type ContentType =
  | 'resource'
  | 'article'
  | 'wiki'
  | 'project'
  | 'measure'
  | 'publication';

interface ContentResultBase {
  type: ContentType;
  kind: number;
  title: string;
  /** Frontend URL — present only when EDUFEED_APP_BASE_URL is configured. */
  url?: string;
  /** NIP-19 addressable identifier. */
  naddr?: string;
  /** The Nostr event signer (uploader/aggregator) — NOT necessarily the resource's creator/publisher. */
  eventAuthor: { pubkey: string; npub?: string };
  createdAt: number;
  /** Canonical external source page (the resource's own URL, transferkiosk.net, etc.) — a direct link to the material, distinct from the edufeed viewer `url`. */
  sourcePage?: string;
  /** Best matching passage from a kind-21142 snippet, when available. */
  snippet?: string;
  /** Chunk score from the snippet, when available. */
  score?: number;
  /** Locators from the snippet, when known. */
  page?: number;
  heading?: string;
  sourceUrl?: string;
}

export interface ResourceResult extends ContentResultBase {
  type: 'resource';
  kind: 30142;
  description?: string;
  about?: string[];
  learningResourceType?: string[];
  educationalLevel?: string[];
  /** Resource creator(s) from AMB metadata — who made the resource. */
  creator?: Array<{ name: string; type: string }>;
  /** Resource publisher(s) from AMB metadata — who published it. Distinct from eventAuthor. */
  publisher?: Array<{ name: string; type: string }>;
  /** Classified `license:id`; null when the resource carries no license. */
  license: LicenseInfo | null;
  /** `full` for CC/PD licenses, `metadata-only` for any other or no license — only `full` resources carry a snippet/page/heading. */
  accessLevel: AccessLevel;
}

export interface ArticleResult extends ContentResultBase {
  type: 'article';
  kind: 30023;
  summary?: string;
  excerpt?: string;
  topics?: string[];
  image?: string;
  publishedAt?: number;
}

export interface WikiResult extends ContentResultBase {
  type: 'wiki';
  kind: 30818;
  summary?: string;
  excerpt?: string;
  topics?: string[];
}

/**
 * NIP-DIDACTIC transferkiosk content (kinds 30143 Projekt / 30144 Maßnahme).
 * `partOf` carries the parent project coord (`30143:<pub>:<d>`) for measures
 * and is absent on root projects. Publikationen migrated to NKBIP-01 kind
 * 30040 (see PublicationResult).
 */
interface TransferkioskResultBase extends ContentResultBase {
  description?: string;
  summary?: string;
  excerpt?: string;
  /** Parent project coord `30143:<pub>:<d>` (measures only). */
  partOf?: string;
}

export interface ProjectResult extends TransferkioskResultBase {
  type: 'project';
  kind: 30143;
}

export interface MeasureResult extends TransferkioskResultBase {
  type: 'measure';
  kind: 30144;
}

/**
 * NKBIP-01 curated publication: kind 30040 (index — bibliographic metadata
 * in tags) or 30041 (section — chapter body in content). Sparse: section
 * results carry title + excerpt; index results carry the metadata fields.
 */
export interface PublicationResult extends ContentResultBase {
  type: 'publication';
  kind: 30040 | 30041;
  summary?: string;
  excerpt?: string;
  /** Plain author display names (`author` tags). */
  authors?: string[];
  /** Bare DOI code, `doi:` prefix stripped from the `i` tag. */
  doi?: string;
  /** Raw external identifier (`i` tag) — doi:/isbn:/URN as published. */
  identifier?: string;
  /** NKBIP-01 display type: academic, book, magazine, … (`type` tag). */
  publicationType?: string;
  /** schema.org type extension tag (ScholarlyArticle, Book, Chapter). */
  additionalType?: string;
  publishedOn?: string;
  publishedBy?: string;
  keywords?: string[];
  language?: string;
  license?: string;
  /** Coords of a-tags marked isPartOf/isOutputOf (e.g. parent project). Note: array-valued here (a publication can be output of several projects); Project/Measure partOf is a single string. */
  partOf?: string[];
  /** Coords of the publication's parts (bare or event-id-hinted a-tags). */
  sections?: string[];
}

export type SimplifiedContentResult =
  | ResourceResult
  | ArticleResult
  | WikiResult
  | ProjectResult
  | MeasureResult
  | PublicationResult;
