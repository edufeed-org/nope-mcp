import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import {
  findCommunities,
  _resetCommunityCacheForTests,
  registerFindCommunityTool,
} from '../../src/tools/findCommunity.js';
import { registerSearchTool } from '../../src/tools/search.js';
import { registerSearchContentTool } from '../../src/tools/searchContent.js';
import { buildSessionServer } from '../../src/session.js';
import { AMBRelayClient } from '../../src/relay/client.js';
import { makeEventCollector } from '../../src/relay/provenance.js';

function communityEvent(pubkey: string, tags: string[][]): NostrEvent {
  return {
    id: `ev-${pubkey.slice(0, 8)}`,
    pubkey,
    created_at: 1700000000,
    kind: 10222,
    tags,
    content: '',
    sig: 's',
  };
}

function descEvent(pubkey: string, description: string): NostrEvent {
  return communityEvent(pubkey, [['description', description]]);
}

function profileEvent(pubkey: string, content: Record<string, unknown>): NostrEvent {
  return {
    id: `profile-${pubkey.slice(0, 8)}`,
    pubkey,
    created_at: 1700000000,
    kind: 0,
    tags: [],
    content: JSON.stringify(content),
    sig: 's',
  };
}

/** Dual-kind fake: answers the kind-10222 query and the kind-0 profile batch separately, deduped by the real collector, as the real client does. */
function fakeClient(communityEvents: NostrEvent[], profileEvents: NostrEvent[] = []) {
  const calls: Array<{ kinds?: number[]; authors?: string[]; limit?: number }> = [];
  return {
    calls,
    queryEvents: async (filter: { kinds?: number[] }) => {
      calls.push(filter as { kinds?: number[]; authors?: string[]; limit?: number });
      const collector = makeEventCollector();
      for (const e of filter.kinds?.[0] === 0 ? profileEvents : communityEvents) collector.onevent(e, undefined);
      return collector.events;
    },
  };
}

const ETEACHING = descEvent(
  'a'.repeat(64),
  'e-teaching.org bietet wissenschaftlich fundierte Informationen zu digitalen Medien in der Lehre.'
);
const RELIGION = descEvent('b'.repeat(64), 'Die Community für religionsbezogene Bildung');
const UNRELATED = descEvent('c'.repeat(64), 'Kanban-Boards für Projektmanagement');

beforeEach(() => {
  _resetCommunityCacheForTests();
});

describe('findCommunities', () => {
  it('ranks the e-teaching.org community first for an "e-teaching" query', async () => {
    const client = fakeClient([ETEACHING, RELIGION, UNRELATED]);
    const result = await findCommunities(client, { query: 'e-teaching' });

    expect(result.communities[0].pubkey).toBe(ETEACHING.pubkey);
    expect(result.total).toBe(result.communities.length);
  });

  it('queries kind 10222 (limit 500) then batches a kind-0 profile query for the community pubkeys', async () => {
    const client = fakeClient([ETEACHING]);
    await findCommunities(client, { query: 'e-teaching' });
    expect(client.calls[0]).toEqual({ kinds: [10222], limit: 500 });
    expect(client.calls[1]).toEqual({ kinds: [0], authors: [ETEACHING.pubkey], limit: 1 });
  });

  it('takes name/picture from the kind-0 profile, description from the 10222 override', async () => {
    const pubkey = ETEACHING.pubkey;
    const profile = profileEvent(pubkey, {
      display_name: 'e-teaching.org',
      about: 'Profile about text (should be shadowed by the override)',
      picture: 'https://example.com/pic.png',
    });
    const client = fakeClient([ETEACHING], [profile]);
    const result = await findCommunities(client, { query: 'e-teaching' });

    expect(result.communities[0].name).toBe('e-teaching.org');
    expect(result.communities[0].picture).toBe('https://example.com/pic.png');
    expect(result.communities[0].description).toBe(
      'e-teaching.org bietet wissenschaftlich fundierte Informationen zu digitalen Medien in der Lehre.'
    );
  });

  it('falls back to the kind-0 `about` when the 10222 has no description override', async () => {
    const pubkey = 'f'.repeat(64);
    const noOverride = communityEvent(pubkey, []);
    const profile = profileEvent(pubkey, { display_name: 'No Override Inc', about: 'e-teaching fallback about' });
    const client = fakeClient([noOverride], [profile]);
    const result = await findCommunities(client, { query: 'e-teaching' });

    expect(result.communities[0].description).toBe('e-teaching fallback about');
  });

  it('keeps the npub fallback name for a community with no kind-0 profile', async () => {
    const pubkey = 'd'.repeat(64);
    const noProfile = descEvent(pubkey, 'e-teaching style community with no profile');
    const client = fakeClient([noProfile], []); // kind-0 query answers empty
    const result = await findCommunities(client, { query: 'e-teaching' });

    expect(result.communities[0].name).toBe(`${result.communities[0].npub.slice(0, 12)}…`);
  });

  it('respects the limit parameter; total counts matches before the slice', async () => {
    const client = fakeClient([ETEACHING, RELIGION]);
    const result = await findCommunities(client, { query: 'bildung lehre', limit: 1 });
    expect(result.communities.length).toBe(1);
    expect(result.total).toBe(2); // both ETEACHING ("Lehre") and RELIGION ("Bildung") match
  });

  it('survives a malformed kind-0 (non-string name): npub fallback name, later queries still answer', async () => {
    const pubkey = ETEACHING.pubkey;
    const bad = profileEvent(pubkey, { name: 42, display_name: ['x'], picture: 7, about: {} });
    const client = fakeClient([ETEACHING, RELIGION], [bad]);
    const result = await findCommunities(client, { query: 'e-teaching' });
    expect(result.communities[0].name).toBe(`${result.communities[0].npub.slice(0, 12)}…`);
    expect(result.communities[0].picture).toBeUndefined();
    const again = await findCommunities(client, { query: 'religionsbezogene' });
    expect(again.communities[0].pubkey).toBe(RELIGION.pubkey);
  });

  it('matches a 2-letter acronym written in capitals ("KI")', async () => {
    const ki = descEvent('e'.repeat(64), 'Austausch zu KI in der Schule');
    const client = fakeClient([ki, UNRELATED]);
    const result = await findCommunities(client, { query: 'KI' });
    expect(result.communities.map((c) => c.pubkey)).toEqual([ki.pubkey]);
  });

  it('reports relaysIncomplete when a relay did not finish the community query', async () => {
    const client = {
      queryEvents: async (filter: { kinds?: number[] }, _sel?: string[], opts?: { diag?: { unreachable: string[]; timedOut: string[] } }) => {
        if (opts?.diag && filter.kinds?.[0] === 10222) opts.diag.timedOut = ['wss://slow.example'];
        return filter.kinds?.[0] === 0 ? [] : [ETEACHING];
      },
    };
    const result = await findCommunities(client, { query: 'e-teaching' });
    expect(result.communities.length).toBe(1);
    expect(result.relaysIncomplete).toEqual(['wss://slow.example']);
  });

  it('drops zero-score communities', async () => {
    const client = fakeClient([ETEACHING, UNRELATED]);
    const result = await findCommunities(client, { query: 'e-teaching' });
    expect(result.communities.map((c) => c.pubkey)).not.toContain(UNRELATED.pubkey);
  });

  it('caches the community+profile list: a second call within 5 min makes no further queryEvents calls', async () => {
    const client = fakeClient([ETEACHING, RELIGION]);
    await findCommunities(client, { query: 'e-teaching' });
    await findCommunities(client, { query: 'religion' });
    expect(client.calls.length).toBe(2); // exactly one 10222 + one kind-0 query per refresh, never per find call
  });

  it('dedupes kind-10222 (replaceable): two versions of one community produce one result with the newer description', async () => {
    const pubkey = ETEACHING.pubkey;
    const older = { ...descEvent(pubkey, 'e-teaching old description'), created_at: 1000 };
    const newer = { ...descEvent(pubkey, 'e-teaching new description'), created_at: 2000 };
    const client = fakeClient([older, newer]);
    const result = await findCommunities(client, { query: 'e-teaching' });

    expect(result.communities.length).toBe(1);
    expect(result.communities[0].description).toBe('e-teaching new description');
  });

  it('does not cache an empty first fetch: the next call retries from scratch', async () => {
    const calls: unknown[] = [];
    let communityEvents: NostrEvent[] = [];
    const client = {
      calls,
      queryEvents: async (filter: { kinds?: number[] }) => {
        calls.push(filter);
        return filter.kinds?.[0] === 0 ? [] : communityEvents;
      },
    };

    const first = await findCommunities(client, { query: 'e-teaching' });
    expect(first.communities).toEqual([]);
    expect(calls.length).toBe(1); // no pubkeys found, so no kind-0 batch query either

    communityEvents = [ETEACHING];
    const second = await findCommunities(client, { query: 'e-teaching' });
    expect(second.communities.length).toBe(1); // retried synchronously, not stuck on the empty "cache"
    expect(calls.length).toBe(3); // first empty 10222 call + the retry's 10222 + its kind-0 batch
  });

  it('keeps serving the old list when a stale background refresh comes back empty (relays down)', async () => {
    const calls: unknown[] = [];
    let communityEvents: NostrEvent[] = [ETEACHING, RELIGION];
    const client = {
      calls,
      queryEvents: async (filter: { kinds?: number[] }) => {
        calls.push(filter);
        return filter.kinds?.[0] === 0 ? [] : communityEvents;
      },
    };

    const first = await findCommunities(client, { query: 'e-teaching' });
    expect(first.communities.length).toBe(1);

    communityEvents = []; // simulate every relay down on the refresh
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000); // past the 5-min TTL
    try {
      const second = await findCommunities(client, { query: 'e-teaching' });
      expect(second.communities.length).toBe(1); // stale-while-revalidate: old list served immediately

      await new Promise(setImmediate); // let the background refresh (and its failure) settle

      const third = await findCommunities(client, { query: 'e-teaching' });
      expect(third.communities.length).toBe(1); // the empty refresh must NOT have blanked the good cache
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps the old list when a background refresh is partial (a relay did not answer)', async () => {
    let partial = false;
    const client = {
      queryEvents: async (filter: { kinds?: number[] }, _sel?: string[], opts?: { diag?: { unreachable: string[]; timedOut: string[] } }) => {
        if (filter.kinds?.[0] === 0) return [];
        if (partial && opts?.diag) opts.diag.timedOut = ['wss://slow.example'];
        return partial ? [ETEACHING] : [ETEACHING, RELIGION];
      },
    };
    await findCommunities(client, { query: 'religionsbezogene' });
    partial = true;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      await findCommunities(client, { query: 'religionsbezogene' }); // triggers the background refresh
      await new Promise(setImmediate);
      const after = await findCommunities(client, { query: 'religionsbezogene' });
      expect(after.communities.map((c) => c.pubkey)).toEqual([RELIGION.pubkey]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

function registeredToolNames(server: unknown): string[] {
  return Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools);
}

describe('find_community tool registration (COMMUNITY_RELAYS)', () => {
  it('is absent when no communityClient is configured (COMMUNITY_RELAYS unset)', () => {
    const s = buildSessionServer(['wss://relay.edufeed.org'], ['wss://relay.edufeed.org']);
    expect(registeredToolNames(s.server)).not.toContain('find_community');
    s.dispose();
  });

  it('is registered when a communityClient is configured', () => {
    const communityClient = new AMBRelayClient(['wss://relay.edufeed.org']);
    const s = buildSessionServer(['wss://relay.edufeed.org'], ['wss://relay.edufeed.org'], undefined, {
      communityClient,
    });
    expect(registeredToolNames(s.server)).toContain('find_community');
    s.dispose();
    communityClient.close();
  });
});

describe('query length cap', () => {
  it('find_community, search_content and search_resources reject a query over 500 chars', () => {
    const schemas: Record<string, Record<string, { safeParse(v: unknown): { success: boolean } }>> = {};
    const server = { registerTool: (name: string, def: { inputSchema: never }) => (schemas[name] = def.inputSchema) };
    const client = new AMBRelayClient(['wss://relay.edufeed.org']);
    registerFindCommunityTool(server as never, client);
    registerSearchContentTool(server as never, client);
    registerSearchTool(server as never, client);
    client.close();
    for (const name of ['find_community', 'search_content', 'search_resources']) {
      expect(schemas[name].query.safeParse('x'.repeat(500)).success).toBe(true);
      expect(schemas[name].query.safeParse('x'.repeat(501)).success).toBe(false);
    }
  });
});
