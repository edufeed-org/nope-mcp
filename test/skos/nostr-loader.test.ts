import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import type { Filter, NostrEvent } from 'nostr-tools';
import { canonicalNostrUri } from '../../src/lib/conceptId.js';
import {
  loadVocabularyFromNaddr,
  type RelayQuery
} from '../../src/skos/nostr-loader.js';

// 32-byte hex pubkey fixture (deterministic, not a real key).
const PUB = 'a4d113c5e83b57dd4a9ed1332b5a99c5524e0853870f74903469378f57399849';
const D = 'hcrt';
const SCHEME_COORD = `39737:${PUB}:${D}`;

const NADDR = nip19.naddrEncode({
  kind: 39737,
  pubkey: PUB,
  identifier: D,
  relays: ['wss://amb-relay.test']
});

function ev(partial: Partial<NostrEvent> & { kind: number; tags: string[][] }): NostrEvent {
  return {
    id: 'f'.repeat(64),
    kind: partial.kind,
    pubkey: PUB,
    created_at: 1000,
    content: '',
    sig: '',
    tags: partial.tags,
    ...partial
  } as NostrEvent;
}

const SCHEME_EVENT = ev({
  id: 'a'.repeat(64),
  kind: 39737,
  tags: [
    ['d', D],
    ['prefLabel', 'Lernressourcentyp', 'de'],
    ['prefLabel', 'Learning Resource Type', 'en'],
    ['description', 'Beschreibt den Typ', 'de'],
    ['published_at', '1000']
  ]
});

const TEXT_CONCEPT = ev({
  id: 'b'.repeat(64),
  kind: 39738,
  tags: [
    ['d', 'text'],
    ['prefLabel', 'Text', 'de'],
    ['prefLabel', 'Text', 'en'],
    ['altLabel', 'Lesetext', 'de'],
    ['a', SCHEME_COORD, '', 'inScheme'],
    ['i', 'https://w3id.org/kim/hcrt/text']
  ]
});

const VIDEO_CONCEPT = ev({
  id: 'c'.repeat(64),
  kind: 39738,
  tags: [
    ['d', 'video'],
    ['prefLabel', 'Video', 'de'],
    ['a', SCHEME_COORD, '', 'inScheme']
  ]
});

const CUSTOM_CONCEPT = ev({
  id: 'd'.repeat(64),
  kind: 39738,
  tags: [
    ['d', 'custom'],
    ['prefLabel', 'Eigen', 'de'],
    ['a', SCHEME_COORD, '', 'inScheme']
    // No 'i' tag — id falls back to Nostr coord.
  ]
});

class FakeRelay implements RelayQuery {
  calls: Filter[] = [];
  constructor(private events: NostrEvent[]) {}
  async queryEvents(filter: Filter): Promise<NostrEvent[]> {
    this.calls.push(filter);
    return this.events.filter((e) => {
      if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
      if (filter.authors && !filter.authors.includes(e.pubkey)) return false;
      const dFilter = (filter as Record<string, unknown>)['#d'] as string[] | undefined;
      if (dFilter) {
        const dTag = e.tags.find((t) => t[0] === 'd')?.[1];
        if (!dTag || !dFilter.includes(dTag)) return false;
      }
      const aFilter = (filter as Record<string, unknown>)['#a'] as string[] | undefined;
      if (aFilter) {
        const aTags = e.tags.filter((t) => t[0] === 'a').map((t) => t[1]);
        if (!aTags.some((a) => aFilter.includes(a))) return false;
      }
      return true;
    });
  }
}

describe('loadVocabularyFromNaddr', () => {
  it('decodes the naddr and returns scheme + concepts', async () => {
    const fake = new FakeRelay([SCHEME_EVENT, TEXT_CONCEPT, VIDEO_CONCEPT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: fake });
    expect(vocab.scheme.id).toBe(canonicalNostrUri(39737, PUB, D));
    expect(vocab.concepts.size).toBe(2);
  });

  it('queries scheme by kind+authors+#d, then concepts by kind+#a', async () => {
    const fake = new FakeRelay([SCHEME_EVENT, TEXT_CONCEPT]);
    await loadVocabularyFromNaddr(NADDR, { relayClient: fake });
    const schemeCall = fake.calls.find((c) => c.kinds?.includes(39737));
    const conceptCall = fake.calls.find((c) => c.kinds?.includes(39738));
    expect(schemeCall?.authors).toEqual([PUB]);
    expect((schemeCall as Record<string, unknown>)['#d']).toEqual([D]);
    expect((conceptCall as Record<string, unknown>)['#a']).toEqual([SCHEME_COORD]);
  });

  it('builds the scheme with a multilingual title', async () => {
    const fake = new FakeRelay([SCHEME_EVENT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: fake });
    expect(vocab.scheme.title).toEqual({
      de: 'Lernressourcentyp',
      en: 'Learning Resource Type'
    });
  });

  it('uses the externalUri (i tag) as concept id when present', async () => {
    const fake = new FakeRelay([SCHEME_EVENT, TEXT_CONCEPT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: fake });
    expect([...vocab.concepts.keys()]).toContain('https://w3id.org/kim/hcrt/text');
  });

  it('falls back to the canonical nostr:naddr when no externalUri', async () => {
    const fake = new FakeRelay([SCHEME_EVENT, CUSTOM_CONCEPT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: fake });
    expect([...vocab.concepts.keys()]).toContain(
      canonicalNostrUri(39738, PUB, 'custom')
    );
  });

  it('builds prefLabel as a LocalizedString map', async () => {
    const fake = new FakeRelay([SCHEME_EVENT, TEXT_CONCEPT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: fake });
    const text = vocab.concepts.get('https://w3id.org/kim/hcrt/text');
    expect(text?.prefLabel).toEqual({ de: 'Text', en: 'Text' });
  });

  it('builds altLabel as a LocalizedString[]', async () => {
    const fake = new FakeRelay([SCHEME_EVENT, TEXT_CONCEPT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: fake });
    const text = vocab.concepts.get('https://w3id.org/kim/hcrt/text');
    expect(text?.altLabel).toEqual([{ de: 'Lesetext' }]);
  });

  it('throws when the scheme event is not found', async () => {
    const fake = new FakeRelay([TEXT_CONCEPT]); // no scheme event
    await expect(loadVocabularyFromNaddr(NADDR, { relayClient: fake })).rejects.toThrow();
  });
});

describe('loadVocabularyFromNaddr — canonical identifiers (NIP-VOCAB)', () => {
  it('identifies a concept without an i tag by its relay-less nostr:naddr and keeps d as notation', async () => {
    const relay = new FakeRelay([SCHEME_EVENT, TEXT_CONCEPT, VIDEO_CONCEPT, CUSTOM_CONCEPT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: relay });
    const expected = canonicalNostrUri(39738, PUB, 'custom');
    const custom = vocab.concepts.get(expected);
    expect(custom).toBeDefined();
    expect(custom?.notation).toEqual(['custom']);
    expect([...vocab.concepts.keys()].some((k) => k.startsWith('39738:'))).toBe(false);
    const decoded = nip19.decode(expected.slice('nostr:'.length));
    expect(decoded.type).toBe('naddr');
    expect((decoded.data as { relays?: string[] }).relays ?? []).toEqual([]);
  });
  it('keeps the i URI as id for concepts that have one, with d as notation', async () => {
    const relay = new FakeRelay([SCHEME_EVENT, TEXT_CONCEPT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: relay });
    const text = vocab.concepts.get('https://w3id.org/kim/hcrt/text');
    expect(text?.notation).toEqual(['text']);
  });
  it('identifies the scheme by its relay-less nostr:naddr', async () => {
    const relay = new FakeRelay([SCHEME_EVENT, TEXT_CONCEPT]);
    const vocab = await loadVocabularyFromNaddr(NADDR, { relayClient: relay });
    expect(vocab.scheme.id).toBe(canonicalNostrUri(39737, PUB, D));
  });
});

