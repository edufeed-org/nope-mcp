import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { canonicalConceptId, conceptAlias } from '../../src/lib/conceptId.js';

const PUB = 'd2689e2f41dabfba953da26655a94ce2aa4e029c383ee921c6a4deafab99a612';
const NADDR = nip19.naddrEncode({ kind: 39738, pubkey: PUB, identifier: 'theologisieren', relays: [] });

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
