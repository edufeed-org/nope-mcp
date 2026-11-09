import { describe, it, expect } from 'vitest';
import { nip19, type NostrEvent } from 'nostr-tools';
import { transformProfileEvent } from '../../src/profiles/transform.js';

const PUBKEY = 'a'.repeat(64);

function profileEvent(content: string, kind = 0): NostrEvent {
  return {
    id: 'id',
    pubkey: PUBKEY,
    created_at: 1700000000,
    kind,
    tags: [],
    content,
    sig: 's',
  };
}

describe('transformProfileEvent', () => {
  it('maps a full kind-0 profile, preferring display_name for name', () => {
    const ev = profileEvent(
      JSON.stringify({
        name: 'jlohrer',
        display_name: 'Jörg Lohrer',
        about: 'Mediendidaktiker',
        nip05: 'joerg@edufeed.org',
      })
    );
    const r = transformProfileEvent(ev);
    expect(r).toEqual({
      pubkey: PUBKEY,
      npub: nip19.npubEncode(PUBKEY),
      name: 'Jörg Lohrer',
      about: 'Mediendidaktiker',
      nip05: 'joerg@edufeed.org',
    });
  });

  it('falls back to name when display_name is absent', () => {
    const r = transformProfileEvent(profileEvent(JSON.stringify({ name: 'e-teaching' })));
    expect(r?.name).toBe('e-teaching');
  });

  it('omits optional fields that are absent', () => {
    const r = transformProfileEvent(profileEvent(JSON.stringify({ name: 'x' })));
    expect(r).toEqual({ pubkey: PUBKEY, npub: nip19.npubEncode(PUBKEY), name: 'x' });
    expect(r).not.toHaveProperty('about');
    expect(r).not.toHaveProperty('nip05');
  });

  it('returns null for malformed content', () => {
    expect(transformProfileEvent(profileEvent('not json'))).toBeNull();
  });

  it('returns null for a non-kind-0 event', () => {
    expect(transformProfileEvent(profileEvent(JSON.stringify({ name: 'x' }), 1))).toBeNull();
  });

  it('includes picture when it is a non-empty string', () => {
    const ev = profileEvent(
      JSON.stringify({
        name: 'test',
        picture: 'https://example.com/pic.jpg',
      })
    );
    const r = transformProfileEvent(ev);
    expect(r?.picture).toBe('https://example.com/pic.jpg');
  });

  it('omits a non-string picture', () => {
    const r = transformProfileEvent(profileEvent(JSON.stringify({ name: 'x', picture: 7 })));
    expect(r).not.toHaveProperty('picture');
  });

  it('omits picture when it is absent', () => {
    const r = transformProfileEvent(profileEvent(JSON.stringify({ name: 'test' })));
    expect(r).not.toHaveProperty('picture');
  });

  it('omits picture when it is an empty string', () => {
    const r = transformProfileEvent(profileEvent(JSON.stringify({ name: 'test', picture: '' })));
    expect(r).not.toHaveProperty('picture');
  });
});
