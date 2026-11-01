/**
 * Re-export AMB types from amb-nostr-converter
 */
export type {
  AmbLearningResource,
  AmbLearningResourceBase,
  AmbCourse,
  AmbVideo,
  AmbPresentation,
  AmbImage,
  AmbWorksheet,
  AmbLearningResourceReference,
  Concept,
  LocalizedString,
  Person,
  Organization,
  License,
  MediaObject,
  FundingScheme,
  MainEntityOfPage,
} from 'amb-nostr-converter';

export {
  isAmbLearningResource,
  getResourceType,
  isResourceType,
} from 'amb-nostr-converter';

export type {
  NostrEvent,
  NostrEducationalEvent,
  NostrEducationalKind,
} from 'amb-nostr-converter';

export {
  getTagValue,
  getTagValues,
  findTags,
  isValidNostrEvent,
  isEducationalEvent,
} from 'amb-nostr-converter';

/**
 * Extended AMB resource with Nostr event metadata
 */
export interface AMBResourceWithMetadata {
  /** The AMB learning resource data */
  resource: import('amb-nostr-converter').AmbLearningResourceBase;
  /** Nostr event metadata */
  nostr: {
    eventId: string;
    kind: number;
    pubkey: string;
    createdAt: number;
    dTag: string;
    sig: string;
  };
  /**
   * ALL license values of the event (licenseTagValues: every `license:id`,
   * else the plain `license` tag), classified together by
   * toSimplifiedResource. Absent → falls back to `resource.license.id`.
   */
  licenseValues?: string[];
}
