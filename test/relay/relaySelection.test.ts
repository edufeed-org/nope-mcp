import { describe, it, expect } from 'vitest';
import type { Filter, NostrEvent } from 'nostr-tools';
import { AMBRelayClient, UnknownRelayError } from '../../src/relay/client.js';

const DEFAULT = 'wss://amb-relay.example';
const EXTRA = 'wss://oersi.example';

function makeClient(): AMBRelayClient {
  return new AMBRelayClient([DEFAULT], { extraRelays: [EXTRA] });
}

/** Swap the pool's subscribeManyEose (the queryRelays path) for a recorder so no IO happens. */
function stubQuerySync(client: AMBRelayClient): () => string[][] {
  const calls: string[][] = [];
  (client as unknown as {
    pool: {
      subscribeManyEose: (
        relays: string[],
        filter: Filter,
        params: { onevent: (e: NostrEvent) => void; onclose: () => void }
      ) => { close(reason?: string): void };
    };
  }).pool.subscribeManyEose = (relays, _filter, params) => {
    calls.push(relays);
    queueMicrotask(() => params.onclose());
    return { close: () => {} };
  };
  return () => calls;
}

describe('relay selection', () => {
  it('keeps extra relays out of the default set but selectable', () => {
    const client = makeClient();
    expect(client.getRelays()).toEqual([DEFAULT]);
    expect(client.getExtraRelays()).toEqual([EXTRA]);
    expect(client.getSelectableRelays()).toEqual([DEFAULT, EXTRA]);
  });

  it('works without extra relays (back-compat constructor)', () => {
    const client = new AMBRelayClient(DEFAULT);
    expect(client.getRelays()).toEqual([DEFAULT]);
    expect(client.getExtraRelays()).toEqual([]);
    expect(client.getSelectableRelays()).toEqual([DEFAULT]);
  });

  it('resolveRelays falls back to the default set when nothing is requested', () => {
    const client = makeClient();
    expect(client.resolveRelays()).toEqual([DEFAULT]);
    expect(client.resolveRelays([])).toEqual([DEFAULT]);
  });

  it('resolveRelays accepts default and extra relays, preserving request order', () => {
    const client = makeClient();
    expect(client.resolveRelays([EXTRA])).toEqual([EXTRA]);
    expect(client.resolveRelays([EXTRA, DEFAULT])).toEqual([EXTRA, DEFAULT]);
  });

  it('resolveRelays matches modulo URL normalization and returns the configured form', () => {
    const client = makeClient();
    expect(client.resolveRelays(['wss://oersi.example/'])).toEqual([EXTRA]);
  });

  it('resolveRelays dedupes repeated requests for the same relay', () => {
    expect(makeClient().resolveRelays([EXTRA, `${EXTRA}/`])).toEqual([EXTRA]);
  });

  it('resolveRelays throws UnknownRelayError for relays outside the allowlist', () => {
    const client = makeClient();
    let caught: unknown;
    try {
      client.resolveRelays(['wss://evil.example', EXTRA]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownRelayError);
    const err = caught as UnknownRelayError;
    expect(err.unknownRelays).toEqual(['wss://evil.example']);
    expect(err.selectableRelays).toEqual([DEFAULT, EXTRA]);
  });

  it('treats unparseable relay URLs as unknown, not as a crash', () => {
    const client = makeClient();
    let caught: unknown;
    try {
      client.resolveRelays(['not a url']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownRelayError);
    expect((caught as UnknownRelayError).unknownRelays).toEqual(['not a url']);
  });

  it('resolveRelays accepts the short hostname label (same rule as the ?relays= connector param)', () => {
    const client = makeClient();
    expect(client.resolveRelays(['oersi'])).toEqual([EXTRA]);
    expect(client.resolveRelays(['OERSI'])).toEqual([EXTRA]); // case-insensitive
    expect(client.resolveRelays(['amb-relay'])).toEqual([DEFAULT]);
  });

  it('resolveRelays accepts the bare hostname', () => {
    const client = makeClient();
    expect(client.resolveRelays(['oersi.example'])).toEqual([EXTRA]);
  });

  it('resolveRelays resolves a mix of full URL, hostname, and label together', () => {
    const client = makeClient();
    expect(client.resolveRelays(['oersi', DEFAULT])).toEqual([EXTRA, DEFAULT]);
  });

  it('resolveRelays still rejects an unknown label', () => {
    const client = makeClient();
    let caught: unknown;
    try {
      client.resolveRelays(['sodix']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownRelayError);
    expect((caught as UnknownRelayError).unknownRelays).toEqual(['sodix']);
  });

  it('does not resolve a short label claimed by two relays (ambiguous → longer forms only)', () => {
    // Two relays sharing the first label "relay" — the label is ambiguous.
    const client = new AMBRelayClient(['wss://relay.a.example'], {
      extraRelays: ['wss://relay.b.example'],
    });
    let caught: unknown;
    try {
      client.resolveRelays(['relay']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownRelayError);
    // But the full URLs still reach both.
    expect(client.resolveRelays(['wss://relay.a.example'])).toEqual(['wss://relay.a.example']);
    expect(client.resolveRelays(['wss://relay.b.example'])).toEqual(['wss://relay.b.example']);
  });
});

describe('runtime relay mutation vs extras', () => {
  it('addRelay of an extra relay moves it to the default set (no dual membership)', () => {
    const client = makeClient();
    client.addRelay(`${EXTRA}/`);
    expect(client.getRelays()).toEqual([DEFAULT, `${EXTRA}/`]);
    expect(client.getExtraRelays()).toEqual([]);
    expect(client.getSelectableRelays()).toEqual([DEFAULT, `${EXTRA}/`]);
  });

  it('dedupes normalization-duplicate extras at construction', () => {
    const client = new AMBRelayClient([DEFAULT], {
      extraRelays: [EXTRA, `${EXTRA}/`],
    });
    expect(client.getExtraRelays()).toEqual([EXTRA]);
  });
});

describe('getRelayInfo coverage', () => {
  it('fetches NIP-11 info for default AND extra relays', async () => {
    const client = makeClient();
    const fetched: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      fetched.push(String(url));
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch;
    try {
      await client.getRelayInfo();
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(fetched.sort()).toEqual([
      'https://amb-relay.example',
      'https://oersi.example',
    ]);
  });
});

describe('query routing with a relays override', () => {
  it('query() hits the default relays when no override is given', async () => {
    const client = makeClient();
    const calls = stubQuerySync(client);
    await client.query({});
    expect(calls()).toEqual([[DEFAULT]]);
  });

  it('query() with an override hits only the requested relays', async () => {
    const client = makeClient();
    const calls = stubQuerySync(client);
    await client.query({}, [EXTRA]);
    expect(calls()).toEqual([[EXTRA]]);
  });

  it('search() with an override hits only the requested relays', async () => {
    const client = makeClient();
    const calls = stubQuerySync(client);
    await client.search('mathematik', {}, [EXTRA, DEFAULT]);
    expect(calls()).toEqual([[EXTRA, DEFAULT]]);
  });

  it('getById() and getByDTag() route the override through', async () => {
    const client = makeClient();
    const calls = stubQuerySync(client);
    await client.getById('e'.repeat(64), [30142], [EXTRA]);
    await client.getByDTag('some-d-tag', undefined, [30142], [EXTRA]);
    expect(calls()).toEqual([[EXTRA], [EXTRA]]);
  });

  it('query() rejects with UnknownRelayError for a relay outside the allowlist', async () => {
    const client = makeClient();
    stubQuerySync(client);
    await expect(client.query({}, ['wss://evil.example'])).rejects.toBeInstanceOf(
      UnknownRelayError
    );
  });

  it('queryEvents() routes the override to the subscription path', async () => {
    const client = makeClient();
    const seen = new Set<string>();
    (client as unknown as {
      pool: { ensureRelay: (url: string) => Promise<unknown> };
    }).pool.ensureRelay = async (url: string) => {
      seen.add(url);
      return {
        prepareSubscription(
          _filters: Filter[],
          handlers: { oneose: () => void }
        ) {
          return {
            close() {},
            fire() {
              queueMicrotask(() => handlers.oneose());
            },
            filters: [] as Filter[],
          };
        },
      };
    };

    await client.queryEvents({ kinds: [30142] }, [EXTRA]);
    expect([...seen]).toEqual([EXTRA]);
  });
});
