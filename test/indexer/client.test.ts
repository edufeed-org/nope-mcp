import { describe, it, expect, vi } from 'vitest';
import { IndexerClient, parseIndexerTimeoutMs } from '../../src/indexer/client.js';

const SPEC = 'wss://relay.edufeed.org=https://indexer.edufeed.org, wss://oersi.edufeed.org=https://indexer.oersi.edufeed.org/';

describe('IndexerClient.fromEnv', () => {
  it('parses relay=endpoint pairs, trimming and stripping trailing slash', () => {
    const c = IndexerClient.fromEnv(SPEC, 'tok');
    expect(c?.forRelay('wss://relay.edufeed.org')).toBe('https://indexer.edufeed.org');
    expect(c?.forRelay('wss://oersi.edufeed.org/')).toBe('https://indexer.oersi.edufeed.org');
    expect(c?.forRelay('wss://unknown.example')).toBeNull();
  });
  it('returns null without spec or any token', () => {
    expect(IndexerClient.fromEnv(undefined, 'tok')).toBeNull();
    expect(IndexerClient.fromEnv(SPEC, undefined)).toBeNull();
    expect(IndexerClient.fromEnv(SPEC, undefined, undefined)).toBeNull();
  });

  it('accepts per-relay tokens without a default token', () => {
    const tokens = 'wss://relay.edufeed.org=tokA, wss://oersi.edufeed.org=tokB';
    const c = IndexerClient.fromEnv(SPEC, undefined, tokens);
    expect(c).not.toBeNull();
    expect(c?.forRelay('wss://relay.edufeed.org')).toBe('https://indexer.edufeed.org');
  });

  it('rejects a mapped endpoint that has neither a per-relay nor a default token', () => {
    const tokens = 'wss://relay.edufeed.org=tokA'; // oersi endpoint left tokenless
    expect(() => IndexerClient.fromEnv(SPEC, undefined, tokens))
      .toThrow(/oersi\.edufeed\.org/);
  });

  it('rejects a malformed INDEXER_API_TOKENS entry', () => {
    expect(() => IndexerClient.fromEnv(SPEC, 'tok', 'not-a-pair'))
      .toThrow(/relay=token/);
  });
});

describe('per-relay bearer tokens', () => {
  const okResponse = () => new Response(JSON.stringify({ hits: [], total: 0 }), { status: 200 });

  it('uses the per-relay token when one is configured, default otherwise', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const c2 = new IndexerClient(
      new Map([['wss://a', 'https://ix-a'], ['wss://b', 'https://ix-b']]),
      'defaultTok',
      fetchImpl as unknown as typeof fetch,
      new Map([['wss://b', 'tokB']]),
    );
    await c2.searchChunks('wss://a', { q: 'q', k: 1, filter: {} });
    await c2.searchChunks('wss://b', { q: 'q', k: 1, filter: {} });
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer defaultTok' });
    expect((fetchImpl.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tokB' });
  });

  it('throws indexer_error when a directly-constructed client has no token for a mapped relay', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const c = new IndexerClient(new Map([['wss://r', 'https://ix']]), '', fetchImpl as unknown as typeof fetch);
    await expect(c.searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('searchChunks', () => {
  it('POSTs with bearer auth and returns hits', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ hits: [{ chunk_id: 'c', event_id: 'e', event_coord: '30142:p:d', chunk_idx: 0, snippet: 's', score: 0.9 }], total: 1 }),
      { status: 200 }
    ));
    const c = new IndexerClient(new Map([['wss://relay.edufeed.org', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    const res = await c.searchChunks('wss://relay.edufeed.org', { q: 'klima', k: 10, filter: { kinds: [30142] } });
    expect(res.total).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ix/search_chunks');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ q: 'klima', k: 10, filter: { kinds: [30142] } });
  });

  it('throws no_indexer for an unmapped relay', async () => {
    const c = new IndexerClient(new Map(), 'tok');
    await expect(c.searchChunks('wss://x', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'no_indexer' });
  });

  it('throws indexer_error on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const c = new IndexerClient(new Map([['wss://r', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    await expect(c.searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });

  it('throws indexer_error on network failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const c = new IndexerClient(new Map([['wss://r', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    await expect(c.searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });

  it('throws indexer_error on invalid JSON response', async () => {
    const fetchImpl = vi.fn(async () => new Response('not-json{', { status: 200 }));
    const c = new IndexerClient(new Map([['wss://r', 'https://ix']]), 'tok', fetchImpl as unknown as typeof fetch);
    await expect(c.searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });
});

describe('response shape validation', () => {
  const client = (body: unknown) => new IndexerClient(
    new Map([['wss://r', 'https://ix']]),
    'tok',
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
  );

  it('throws indexer_error on a 200 JSON body without hits (e.g. an error payload)', async () => {
    await expect(client({ error: 'oops' }).searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error', message: expect.stringContaining('unexpected response shape') });
  });

  it('throws indexer_error when hits is not an array', async () => {
    await expect(client({ hits: 'nope', total: 0 }).searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });

  it('throws indexer_error when a hit lacks event_coord or score', async () => {
    await expect(client({ hits: [{ snippet: 's' }], total: 1 }).searchChunks('wss://r', { q: 'q', k: 1, filter: {} }))
      .rejects.toMatchObject({ code: 'indexer_error' });
  });

  it('passes through real-world hits untouched, extra fields and array section_path included', async () => {
    const hit = {
      chunk_id: 'c:0', event_id: 'e', event_coord: '30142:p:d', chunk_idx: 0,
      snippet: 's', score: 0.7, section_path: ['A', 'B'],
      amb: { name: 'X' }, some_future_field: 42,
    };
    const res = await client({ hits: [hit], total: 1 }).searchChunks('wss://r', { q: 'q', k: 1, filter: {} });
    expect(res.total).toBe(1);
    expect(res.hits[0]).toEqual(hit);
  });

  it('defaults total to hits.length when absent', async () => {
    const res = await client({ hits: [{ event_coord: '30142:p:d', score: 1 }] }).searchChunks('wss://r', { q: 'q', k: 1, filter: {} });
    expect(res.total).toBe(1);
  });
});

describe('parseIndexerTimeoutMs', () => {
  it('defaults to 15000, accepts a positive number, rejects anything else', () => {
    expect(parseIndexerTimeoutMs({})).toBe(15000);
    expect(parseIndexerTimeoutMs({ INDEXER_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(() => parseIndexerTimeoutMs({ INDEXER_TIMEOUT_MS: '-5' })).toThrow(/INDEXER_TIMEOUT_MS/);
    expect(() => parseIndexerTimeoutMs({ INDEXER_TIMEOUT_MS: 'abc' })).toThrow();
  });
});
