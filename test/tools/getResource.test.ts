import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { naddrToLookup, runGetResource } from '../../src/tools/get.js';

function pk(n: number): string {
  return n.toString(16).padStart(64, '0');
}

describe('naddrToLookup', () => {
  it('decodes a valid naddr into identifier + author + kind', () => {
    const naddr = nip19.naddrEncode({
      kind: 30142,
      pubkey: pk(7),
      identifier: 'https://example.org/material/peace/',
      relays: [],
    });
    expect(naddrToLookup(naddr)).toEqual({
      identifier: 'https://example.org/material/peace/',
      author: pk(7),
      kind: 30142,
    });
  });

  it('returns null for a malformed or non-naddr value', () => {
    expect(naddrToLookup('not-an-naddr')).toBeNull();
    expect(naddrToLookup(nip19.npubEncode(pk(7)))).toBeNull();
  });
});

function fakeGetClient(event: any) {
  const calls: any[] = [];
  return {
    calls,
    getByDTag: async (d: string, author?: string, kinds?: number[]) => {
      calls.push({ d, author, kinds });
      return event;
    },
    getById: async () => event,
  };
}

describe('runGetResource kind dispatch', () => {
  const author = 'a'.repeat(64);

  it('fetches a publication naddr with its own kind and returns the publication shape', async () => {
    const event = {
      id: 'e1', pubkey: author, created_at: 1700000000, kind: 30040, sig: 's', content: '',
      tags: [['d', 'tk-p1-pub2'], ['title', 'Paper'], ['type', 'academic'], ['i', 'doi:10.1/x']],
    };
    const client = fakeGetClient(event);
    const naddr = nip19.naddrEncode({ kind: 30040, pubkey: author, identifier: 'tk-p1-pub2', relays: [] });
    const out = await runGetResource(client, { naddr });
    expect(client.calls[0].kinds).toEqual([30040]);
    expect(out.resource.type).toBe('publication');
    expect(out.resource.doi).toBe('10.1/x');
  });

  it('fetches a projekt naddr (transferkiosk fixed for free)', async () => {
    const event = {
      id: 'e2', pubkey: author, created_at: 1700000000, kind: 30143, sig: 's', content: '',
      tags: [['d', 'https://transferkiosk.net/p/1'], ['name', 'Projekt X']],
    };
    const client = fakeGetClient(event);
    const naddr = nip19.naddrEncode({ kind: 30143, pubkey: author, identifier: 'https://transferkiosk.net/p/1', relays: [] });
    const out = await runGetResource(client, { naddr });
    expect(client.calls[0].kinds).toEqual([30143]);
    expect(out.resource.type).toBe('project');
  });

  it('errors clearly on an unregistered kind', async () => {
    const client = fakeGetClient(null);
    const naddr = nip19.naddrEncode({ kind: 31337, pubkey: author, identifier: 'x', relays: [] });
    const out = await runGetResource(client, { naddr });
    expect(out.error).toMatch(/kind 31337/);
    expect(client.calls.length).toBe(0);
  });

  it('threads the per-call relay selection to getByDTag and getById', async () => {
    const seen: Array<string[] | undefined> = [];
    const client = {
      getById: async (_id: string, _kinds?: number[], relays?: string[]) => {
        seen.push(relays);
        return null;
      },
      getByDTag: async (
        _d: string,
        _author?: string,
        _kinds?: number[],
        relays?: string[]
      ) => {
        seen.push(relays);
        return null;
      },
    };
    const relays = ['wss://oersi.example'];
    await runGetResource(client, { eventId: 'e'.repeat(64), relays });
    const naddr = nip19.naddrEncode({ kind: 30142, pubkey: author, identifier: 'x', relays: [] });
    await runGetResource(client, { naddr, relays });
    await runGetResource(client, { identifier: 'x', relays });
    expect(seen).toEqual([relays, relays, relays]);
  });

  it('prefers eventId over naddr when both are supplied (pre-refactor behavior)', async () => {
    const event = {
      id: 'byid', pubkey: author, created_at: 1700000000, kind: 30142, sig: 's', content: '{}',
      tags: [['d', 'https://example.org/r']],
    };
    const calls: any[] = [];
    const client = {
      calls,
      getById: async () => { calls.push('getById'); return event; },
      getByDTag: async () => { calls.push('getByDTag'); return null; },
    };
    const naddr = nip19.naddrEncode({ kind: 30040, pubkey: author, identifier: 'x', relays: [] });
    await runGetResource(client, { eventId: 'byid', naddr });
    expect(calls).toEqual(['getById']);
  });
});

describe('runGetResource openLicense flag', () => {
  const author = 'a'.repeat(64);
  const resource = (license?: string) => ({
    id: 'e'.repeat(64), pubkey: author, created_at: 1, kind: 30142, sig: 's', content: '',
    tags: [['d', 'r1'], ['name', 'Arbeitsblatt'], ...(license ? [['license:id', license]] : [])],
  });

  it('marks an openly licensed resource', async () => {
    const out = await runGetResource(fakeGetClient(resource('https://creativecommons.org/licenses/by-sa/4.0/')), { identifier: 'r1' });
    expect(out.openLicense).toBe(true);
    expect(out.resource).toBeTruthy();
  });

  it('still returns a non-open or unlicensed resource, flagged false', async () => {
    const nc = await runGetResource(fakeGetClient(resource('https://creativecommons.org/licenses/by-nc/4.0/')), { eventId: 'x' });
    expect(nc.resource).toBeTruthy();
    expect(nc.openLicense).toBe(false);
    const none = await runGetResource(
      fakeGetClient(resource()),
      { naddr: nip19.naddrEncode({ kind: 30142, pubkey: author, identifier: 'r1', relays: [] }) }
    );
    expect(none.resource).toBeTruthy();
    expect(none.openLicense).toBe(false);
  });

  it('leaves non-resource kinds and misses without the flag', async () => {
    const miss = await runGetResource(fakeGetClient(null), { identifier: 'r1' });
    expect(miss).not.toHaveProperty('openLicense');
  });
});
