import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { canonicalConceptId, canonicalNostrUri, conceptAlias } from '../../src/lib/conceptId.js';

const PUB = 'd2689e2f41dabfba953da26655a94ce2aa4e029c383ee921c6a4deafab99a612';
const NADDR = canonicalNostrUri(39738, PUB, 'theologisieren').slice('nostr:'.length);

describe('canonicalConceptId', () => {
  it('turns a raw coordinate into the canonical relay-less nostr:naddr', () => {
    expect(canonicalConceptId(`39738:${PUB}:theologisieren`)).toBe(`nostr:${NADDR}`);
  });
  it('turns the legacy nostr:<kind>:<pubkey>:<d> form into the canonical naddr', () => {
    expect(canonicalConceptId(`nostr:39738:${PUB}:theologisieren`)).toBe(`nostr:${NADDR}`);
  });
  it('strips relay hints from an naddr', () => {
    const hinted = nip19.naddrEncode({ kind: 39738, pubkey: PUB, identifier: 'theologisieren', relays: ['wss://relay.edufeed.org'] });
    expect(canonicalConceptId(`nostr:${hinted}`)).toBe(`nostr:${NADDR}`);
    expect(canonicalConceptId(hinted)).toBe(`nostr:${NADDR}`);
  });
  it('leaves http(s) URIs and garbage unchanged', () => {
    expect(canonicalConceptId('https://w3id.org/kim/hcrt/video')).toBe('https://w3id.org/kim/hcrt/video');
    expect(canonicalConceptId('nostr:naddr1garbage')).toBe('nostr:naddr1garbage');
    expect(canonicalConceptId('39738:nothex:x')).toBe('39738:nothex:x');
  });
  it('conceptAlias is the d of a Nostr concept and undefined for URIs', () => {
    expect(conceptAlias(`nostr:${NADDR}`)).toBe('theologisieren');
    expect(conceptAlias('https://w3id.org/kim/hcrt/video')).toBeUndefined();
  });
});

describe('canonicalNostrUri — byte-exact canonical form (NIP-VOCAB test vectors)', () => {
  // nostr-tools 2.2x writes the kind TLV first; the canonical form is TLV 0 (d), 2 (author), 3 (kind)
  // — the string every other edufeed component (nostr-vocab-core, go-nostr, nostrlib) produces.
  it('matches the VOCAB.md vector for 39738:…:5-6', () => {
    expect(canonicalNostrUri(39738, PUB, '5-6')).toBe(
      'nostr:naddr1qqpn2tfkqgsdy6y79aqa40a6j576yej449xw92jwq2wrs0hfy8r2fh404wv6vysrqsqqpxe6vja26r'
    );
  });
  it('matches nostr-vocab-core / go-nostr for 39738:…:1', () => {
    expect(canonicalNostrUri(39738, PUB, '1')).toBe(
      'nostr:naddr1qqqnzq3q6f5fut6pm2lm49fa5fn9t22vu24yuq5u8qlwjgwx5n02l2ue5cfqxpqqqzdn5g5cpeq'
    );
  });
  it('re-encodes a kind-first naddr (nostr-tools order) into the canonical byte order', () => {
    const kindFirst = nip19.naddrEncode({ kind: 39738, pubkey: PUB, identifier: '1', relays: [] });
    expect(canonicalConceptId('nostr:' + kindFirst)).toBe(canonicalNostrUri(39738, PUB, '1'));
  });
  it('still decodes with nostr-tools', () => {
    const d = nip19.decode(canonicalNostrUri(39738, PUB, 'theologisieren').slice('nostr:'.length));
    expect(d.type).toBe('naddr');
    expect(d.data).toMatchObject({ kind: 39738, pubkey: PUB, identifier: 'theologisieren' });
  });
});

