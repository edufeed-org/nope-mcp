import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { eventToAMBResource, eventsToAMBResources, toSimplifiedResource } from '../../src/utils/transform.js';
import type { NostrEvent } from 'nostr-tools';

// Valid 32-byte hex pubkey so nip19.naddrEncode() succeeds in tests.
const VALID_PUBKEY = '0'.repeat(63) + '1';

const createMockEvent = (tags: string[][], dTag: string): NostrEvent => ({
  id: 'event123',
  pubkey: VALID_PUBKEY,
  created_at: 1700000000,
  kind: 30142,
  tags: [['d', dTag], ...tags],
  content: 'Some description text',
  sig: 'sig123',
});

describe('eventToAMBResource', () => {
  it('transforms a valid event to AMBResource', () => {
    const tags = [
      ['name', 'Introduction to Math'],
      ['description', 'A video about mathematics'],
      ['type', 'LearningResource'],
      ['type', 'VideoObject'],
      ['inLanguage', 'de'],
      ['creator:name', 'Dr. Example'],
      ['creator:type', 'Person'],
      ['publisher:name', 'Example University'],
      ['publisher:type', 'Organization'],
    ];

    const event = createMockEvent(tags, 'resource-1');
    const result = eventToAMBResource(event);

    expect(result).not.toBeNull();
    expect(result!.resource.name).toBe('Introduction to Math');
    expect(result!.resource.type).toEqual(['LearningResource', 'VideoObject']);
    expect(result!.resource.creator).toHaveLength(1);
    expect(result!.resource.creator![0].name).toBe('Dr. Example');
    expect(result!.resource.publisher).toHaveLength(1);
    expect(result!.resource.publisher![0].name).toBe('Example University');
    expect(result!.nostr.eventId).toBe('event123');
    expect(result!.nostr.pubkey).toBe(VALID_PUBKEY);
    expect(result!.nostr.kind).toBe(30142);
    expect(result!.nostr.dTag).toBe('resource-1');
  });

  it('returns null for event without d-tag', () => {
    const event: NostrEvent = {
      id: 'event123',
      pubkey: 'pubkey123',
      created_at: 1700000000,
      kind: 30142,
      tags: [['name', 'Test']],
      content: 'content',
      sig: 'sig123',
    };

    const result = eventToAMBResource(event);
    expect(result).toBeNull();
  });

  it('returns null for event without name tag', () => {
    const event: NostrEvent = {
      id: 'event123',
      pubkey: 'pubkey123',
      created_at: 1700000000,
      kind: 30142,
      tags: [['d', 'resource-1']],
      content: 'content',
      sig: 'sig123',
    };

    const result = eventToAMBResource(event);
    expect(result).toBeNull();
  });

  it('extracts educational metadata from tags', () => {
    const tags = [
      ['name', 'Test Resource'],
      ['about:id', 'https://example.org/subject/math'],
      ['about:prefLabel:de', 'Mathematik'],
      ['learningResourceType:id', 'https://example.org/type/video'],
      ['learningResourceType:prefLabel:de', 'Video'],
      ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
      ['isAccessibleForFree', 'true'],
      ['datePublished', '2024-01-15'],
    ];

    const event = createMockEvent(tags, 'resource-1');
    const result = eventToAMBResource(event);

    expect(result).not.toBeNull();
    expect(result!.resource.about).toHaveLength(1);
    expect(result!.resource.about![0].id).toBe('https://example.org/subject/math');
    expect(result!.resource.learningResourceType).toHaveLength(1);
    expect(result!.resource.license?.id).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(result!.resource.isAccessibleForFree).toBe(true);
    expect(result!.resource.datePublished).toBe('2024-01-15');
  });

  it('falls back to the plain license tag (amb-indexer parity: worker.go readLicenseTag)', () => {
    const event = createMockEvent(
      [['name', 'Test Resource'], ['license', 'https://creativecommons.org/licenses/by/4.0/']],
      'resource-1'
    );
    const result = eventToAMBResource(event);
    expect(result!.resource.license?.id).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('prefers license:id over license when both are present', () => {
    const event = createMockEvent(
      [
        ['name', 'Test Resource'],
        ['license', 'https://creativecommons.org/licenses/by-nc/4.0/'],
        ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
      ],
      'resource-1'
    );
    const result = eventToAMBResource(event);
    expect(result!.resource.license?.id).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('extracts mainEntityOfPage from http r tags', () => {
    const event = createMockEvent(
      [
        ['name', 'Ein Erfahrungsbericht'],
        ['r', 'https://www.e-teaching.org/praxis/foo'],
      ],
      'resource-1'
    );
    const result = eventToAMBResource(event);
    expect(result!.resource.mainEntityOfPage).toEqual([
      { id: 'https://www.e-teaching.org/praxis/foo' },
    ]);
  });
});

describe('eventsToAMBResources', () => {
  it('transforms multiple events and filters invalid ones', () => {
    const validEvent = createMockEvent(
      [['name', 'Resource 1']],
      'resource-1'
    );
    const invalidEvent: NostrEvent = {
      id: 'event2',
      pubkey: 'pubkey2',
      created_at: 1700000000,
      kind: 30142,
      tags: [], // Missing d-tag and name
      content: 'content',
      sig: 'sig2',
    };

    const results = eventsToAMBResources([validEvent, invalidEvent]);
    expect(results).toHaveLength(1);
    expect(results[0].resource.name).toBe('Resource 1');
  });
});

describe('toSimplifiedResource', () => {
  it('extracts key fields for MCP response', () => {
    const tags = [
      ['name', 'Introduction to Math'],
      ['description', 'A video about mathematics'],
      ['type', 'LearningResource'],
      ['type', 'VideoObject'],
      ['inLanguage', 'de'],
      ['inLanguage', 'en'],
      ['learningResourceType:id', 'https://w3id.org/kim/hcrt/video'],
      ['learningResourceType:prefLabel:de', 'Video'],
      ['about:id', 'https://w3id.org/kim/schulfaecher/s1017'],
      ['about:prefLabel:de', 'Mathematik'],
      ['creator:name', 'Dr. Example'],
      ['creator:type', 'Person'],
      ['publisher:name', 'Example University'],
      ['publisher:type', 'Organization'],
      ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
      ['isAccessibleForFree', 'true'],
      ['datePublished', '2024-01-15'],
    ];

    const event = createMockEvent(tags, 'resource-1');
    const ambResource = eventToAMBResource(event)!;
    const simplified = toSimplifiedResource(ambResource);

    expect(simplified.id).toBe('resource-1');
    expect(simplified.identifier).toBe('resource-1');
    expect(simplified.name).toBe('Introduction to Math');
    expect(simplified.type).toEqual(['LearningResource', 'VideoObject']);
    expect(simplified.inLanguage).toEqual(['de', 'en']);
    expect(simplified.learningResourceType).toHaveLength(1);
    expect(simplified.about).toHaveLength(1);
    expect(simplified.creator).toHaveLength(1);
    expect(simplified.creator![0].name).toBe('Dr. Example');
    expect(simplified.publisher).toHaveLength(1);
    expect(simplified.publisher![0].name).toBe('Example University');
    expect(simplified.license?.id).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(simplified.isAccessibleForFree).toBe(true);
    expect(simplified.datePublished).toBe('2024-01-15');
    expect(simplified.nostr.eventId).toBe('event123');
  });

  it('classifies a plain-license-tag resource as fully-licensed CC BY (amb-indexer parity)', () => {
    const event = createMockEvent(
      [['name', 'Ein Erfahrungsbericht'], ['license', 'https://creativecommons.org/licenses/by/4.0/']],
      'resource-1'
    );
    const simplified = toSimplifiedResource(eventToAMBResource(event)!);
    expect(simplified.license).toEqual({
      id: 'https://creativecommons.org/licenses/by/4.0/',
      label: 'CC BY 4.0',
    });
    expect(simplified.accessLevel).toBe('full');
  });

  it('exposes sourcePage from the r tag', () => {
    const event = createMockEvent(
      [
        ['name', 'Ein Erfahrungsbericht'],
        ['r', 'https://www.e-teaching.org/praxis/foo'],
      ],
      '46d54fe5-21b2-41d3-8253-f8824f025864'
    );
    const simplified = toSimplifiedResource(eventToAMBResource(event)!);
    expect(simplified.sourcePage).toBe('https://www.e-teaching.org/praxis/foo');
  });

  it('falls back to an http-shaped d-tag id for sourcePage when r is absent', () => {
    const event = createMockEvent(
      [['name', 'Ein Erfahrungsbericht']],
      'https://www.e-teaching.org/praxis/foo'
    );
    const simplified = toSimplifiedResource(eventToAMBResource(event)!);
    expect(simplified.sourcePage).toBe('https://www.e-teaching.org/praxis/foo');
  });

  it('leaves sourcePage undefined when there is no r tag and the id is not a URL', () => {
    const event = createMockEvent(
      [['name', 'UUID-identified resource']],
      '46d54fe5-21b2-41d3-8253-f8824f025864'
    );
    const simplified = toSimplifiedResource(eventToAMBResource(event)!);
    expect(simplified.sourcePage).toBeUndefined();
  });

  it('emits naddr for the resource', () => {
    const event = createMockEvent([['name', 'Test']], 'resource-1');
    const ambResource = eventToAMBResource(event)!;
    const simplified = toSimplifiedResource(ambResource);

    expect(simplified.nostr.naddr).toBeDefined();
    const decoded = nip19.decode(simplified.nostr.naddr!);
    expect(decoded.type).toBe('naddr');
    const data = decoded.data as { kind: number; pubkey: string; identifier: string };
    expect(data.kind).toBe(30142);
    expect(data.pubkey).toBe(VALID_PUBKEY);
    expect(data.identifier).toBe('resource-1');
  });

  it('omits url when EDUFEED_APP_BASE_URL is unset', () => {
    // Tests run without the env var set (vitest config does not inject it).
    // The transform module reads the env var at import time, so this asserts
    // the default unset behavior.
    const event = createMockEvent([['name', 'Test']], 'resource-1');
    const ambResource = eventToAMBResource(event)!;
    const simplified = toSimplifiedResource(ambResource);

    // url is undefined when not configured; naddr is still emitted.
    expect(simplified.url).toBeUndefined();
    expect(simplified.nostr.naddr).toBeDefined();
  });
});
