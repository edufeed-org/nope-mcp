import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { CalendarAuthorCache, parseAuthorProfile } from '../../src/calendar/authorInfo.js';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function profile(pubkey: string, content: Record<string, unknown>, created_at = 1): NostrEvent {
  return { id: 'p' + pubkey.slice(0, 4), pubkey, created_at, kind: 0, tags: [], content: JSON.stringify(content), sig: 's' };
}

describe('parseAuthorProfile', () => {
  it('reads display name, name fallback and the NIP-24 bot flag', () => {
    expect(parseAuthorProfile(profile(HEX_A, { name: 'dbs', display_name: 'Deutscher Bildungsserver Test-Mirror', bot: true }))).toEqual({
      pubkey: HEX_A,
      name: 'Deutscher Bildungsserver Test-Mirror',
      bot: true,
    });
    expect(parseAuthorProfile(profile(HEX_B, { name: 'relilab' }))).toEqual({ pubkey: HEX_B, name: 'relilab', bot: false });
  });

  it('tolerates unparseable content', () => {
    expect(parseAuthorProfile({ ...profile(HEX_A, {}), content: '{nope' })).toEqual({ pubkey: HEX_A, bot: false });
  });
});

describe('CalendarAuthorCache', () => {
  it('fetches unknown pubkeys once, keeps the newest profile, and answers misses with a bare entry', async () => {
    const calls: string[][] = [];
    const cache = new CalendarAuthorCache(async (pubkeys) => {
      calls.push([...pubkeys]);
      return [profile(HEX_A, { name: 'old', bot: true }, 1), profile(HEX_A, { name: 'new', bot: true }, 2)];
    });

    const first = await cache.lookup([HEX_A, HEX_B, HEX_A]);
    expect(first.get(HEX_A)).toEqual({ pubkey: HEX_A, name: 'new', bot: true });
    expect(first.get(HEX_B)).toEqual({ pubkey: HEX_B, bot: false });
    expect(calls).toEqual([[HEX_A, HEX_B]]);

    const second = await cache.lookup([HEX_A, HEX_B]);
    expect(second.get(HEX_A)?.name).toBe('new');
    expect(calls).toHaveLength(1); // both pubkeys cached, the miss too
  });

  it('survives a failing fetcher by returning bare entries', async () => {
    const cache = new CalendarAuthorCache(async () => {
      throw new Error('relay down');
    });
    const got = await cache.lookup([HEX_A]);
    expect(got.get(HEX_A)).toEqual({ pubkey: HEX_A, bot: false });
  });
});
