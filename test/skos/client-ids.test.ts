import { describe, it, expect, beforeEach } from 'vitest';
import { nip19 } from 'nostr-tools';
import { getVocabulary, getConcept } from '../../src/skos/client.js';
import { canonicalNostrUri } from '../../src/lib/conceptId.js';
import { vocabularyCache } from '../../src/skos/cache.js';
import type { ParsedVocabulary } from '../../src/skos/types.js';

const PUB = 'd2689e2f41dabfba953da26655a94ce2aa4e029c383ee921c6a4deafab99a612';
const NADDR = canonicalNostrUri(39737, PUB, 'ekw-fach').slice('nostr:'.length);
const HINTED = nip19.naddrEncode({ kind: 39737, pubkey: PUB, identifier: 'ekw-fach', relays: ['wss://relay.edufeed.org'] });
const vocab: ParsedVocabulary = {
  scheme: { id: 'nostr:' + NADDR, type: 'ConceptScheme', title: { de: 'Fach' }, hasTopConcept: [] },
  concepts: new Map()
};

describe('getVocabulary — canonical scheme identifiers', () => {
  beforeEach(() => {
    vocabularyCache.clear();
    vocabularyCache.set(NADDR, vocab);
  });
  it('accepts the canonical nostr:naddr the loader emits as scheme.id', async () => {
    expect(await getVocabulary('nostr:' + NADDR)).toBe(vocab);
  });
  it('shares the cache between hinted and relay-less naddrs of the same scheme', async () => {
    expect(await getVocabulary(HINTED)).toBe(vocab);
  });
});

describe('getConcept — Nostr concept ids', () => {
  it('returns undefined for a nostr:naddr concept id instead of trying to fetch it', async () => {
    const cid = canonicalNostrUri(39738, PUB, 'religion');
    expect(await getConcept(cid)).toBeUndefined();
  });
});
