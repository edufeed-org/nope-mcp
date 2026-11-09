import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { parseCommunity } from '../../src/community/parse.js';
import { setEventRelay } from '../../src/relay/provenance.js';

function communityEvent(tags: string[][], pubkey = 'a'.repeat(64)): NostrEvent {
  return { id: 'ev1', pubkey, created_at: 1700000000, kind: 10222, tags, content: '', sig: 's' };
}

function profileEvent(pubkey: string, content: Record<string, unknown>): NostrEvent {
  return {
    id: 'profile1',
    pubkey,
    created_at: 1700000000,
    kind: 0,
    tags: [],
    content: JSON.stringify(content),
    sig: 's',
  };
}

describe('parseCommunity', () => {
  it('takes name/picture from the kind-0 profile and description from the 10222 override', () => {
    const pubkey = 'b'.repeat(64);
    const event = communityEvent([['description', 'Override description'], ['r', 'wss://relay.edufeed.org']], pubkey);
    setEventRelay(event, 'wss://relay.edufeed.org');
    const profile = profileEvent(pubkey, {
      display_name: 'e-teaching.org',
      about: 'Profile about text',
      picture: 'https://example.com/pic.png',
    });

    expect(parseCommunity(event, profile)).toEqual({
      pubkey,
      npub: nip19.npubEncode(pubkey),
      name: 'e-teaching.org',
      description: 'Override description',
      picture: 'https://example.com/pic.png',
      relay: 'wss://relay.edufeed.org',
    });
  });

  it('falls back to the kind-0 `name` when no `display_name` is set', () => {
    const pubkey = 'd'.repeat(64);
    const event = communityEvent([], pubkey);
    const profile = profileEvent(pubkey, { name: 'Religionspädagogik' });

    expect(parseCommunity(event, profile).name).toBe('Religionspädagogik');
  });

  it('falls back to the kind-0 `about` when the 10222 has no description override', () => {
    const pubkey = 'e'.repeat(64);
    const event = communityEvent([], pubkey);
    const profile = profileEvent(pubkey, { about: 'About text from the profile' });

    expect(parseCommunity(event, profile).description).toBe('About text from the profile');
  });

  it('falls back to a npub-derived name and empty description when there is no profile at all', () => {
    const pubkey = 'c'.repeat(64);
    const event = communityEvent([], pubkey);
    const npub = nip19.npubEncode(pubkey);

    const parsed = parseCommunity(event);
    expect(parsed.name).toBe(`${npub.slice(0, 12)}…`);
    expect(parsed.description).toBe('');
    expect(parsed.picture).toBeUndefined();
    expect(parsed.relay).toBeUndefined();
  });

  it('keeps a long description override verbatim (no truncation)', () => {
    const long =
      'e-teaching.org bietet wissenschaftlich fundierte und aktuelle Informationen zu ' +
      'didaktischen, technischen und organisatorischen Aspekten der Lehre und des Lernens ' +
      'mit digitalen Medien und richtet sich in erster Linie an Verantwortliche in den ' +
      'entsprechenden Service-Einrichtungen und Lehrende an Hochschulen im deutschsprachigen Raum.';
    const event = communityEvent([['description', long]]);

    expect(parseCommunity(event).description).toBe(long);
  });
});
