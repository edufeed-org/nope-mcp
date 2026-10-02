import { describe, it, expect } from 'vitest';
import { runContentSearch } from '../../src/tools/searchContent.js';
import type { NostrEvent, Filter } from 'nostr-tools';

function evt(kind: number, id: string, tags: string[][], content = ''): NostrEvent {
  return { id, pubkey: 'a'.repeat(64), created_at: 1700000000, kind, tags, content, sig: 's' };
}

// A fake client that returns a fixed, ordered event stream (content interleaved
// with the 21142 snippet that follows each result), exactly as the relay emits.
function fakeClient(events: NostrEvent[]) {
  return { queryEvents: async () => events };
}

describe('runContentSearch', () => {
  it('returns typed, relay-ordered results with snippets attached and 21142 excluded', async () => {
    const article = evt(30023, 'art1', [['d', 'a'], ['title', 'Aufmerksamkeit']], 'body a');
    const artSnip = evt(21142, 'snip-art1', [['e', 'art1'], ['k', '30023'], ['score', '0.81']], 'passage A');
    const wiki = evt(30818, 'wiki1', [['d', 'w'], ['title', 'Seminar']], 'body w');
    const wikiSnip = evt(21142, 'snip-wiki1', [['e', 'wiki1'], ['k', '30818'], ['score', '0.66']], 'passage W');
    const resource = evt(30142, 'res1', [['d', 'r'], ['name', 'Video']]);

    const out = await runContentSearch(
      fakeClient([article, artSnip, wiki, wikiSnip, resource]),
      { query: 'aufmerksamkeit', language: 'de' }
    );

    expect(out.total).toBe(3);
    expect(out.results.map((r) => r.type)).toEqual(['article', 'wiki', 'resource']);
    expect(out.results[0].snippet).toBe('passage A');
    expect(out.results[0].score).toBeCloseTo(0.81);
    expect(out.results[1].snippet).toBe('passage W');
    expect(out.results[2].snippet).toBeUndefined(); // no snippet for the resource
    // No 21142 leaks into results
    expect(out.results.some((r) => (r as { kind: number }).kind === 21142)).toBe(false);
  });

  it('keeps result↔snippet alignment when an invalid content event is dropped mid-list', async () => {
    // A name-less 30142 is skipped by the transform. The parallel-array
    // attachment must still pair the trailing wiki with its own snippet, not
    // shift onto the dropped event's index.
    const article = evt(30023, 'art1', [['d', 'a'], ['title', 'Aufmerksamkeit']], 'body a');
    const artSnip = evt(21142, 'snip-art1', [['e', 'art1'], ['k', '30023'], ['score', '0.81']], 'passage A');
    const badResource = evt(30142, 'bad1', [['d', 'r']]); // missing name → dropped
    const wiki = evt(30818, 'wiki1', [['d', 'w'], ['title', 'Seminar']], 'body w');
    const wikiSnip = evt(21142, 'snip-wiki1', [['e', 'wiki1'], ['k', '30818'], ['score', '0.66']], 'passage W');

    const out = await runContentSearch(
      fakeClient([article, artSnip, badResource, wiki, wikiSnip]),
      { query: 'aufmerksamkeit', language: 'de' }
    );

    expect(out.total).toBe(2);
    expect(out.results.map((r) => r.type)).toEqual(['article', 'wiki']);
    expect(out.results[0].snippet).toBe('passage A');
    expect(out.results[1].snippet).toBe('passage W');
  });

  it('returns an empty result set when the relay returns nothing', async () => {
    const out = await runContentSearch(fakeClient([]), { query: 'x' });
    expect(out).toEqual({ total: 0, results: [] });
  });

  it('passes the per-call relay selection through to queryEvents', async () => {
    let seenRelays: string[] | undefined;
    const client = {
      queryEvents: async (_f: unknown, relays?: string[]) => {
        seenRelays = relays;
        return [] as NostrEvent[];
      },
    };
    await runContentSearch(client, { query: 'x', relays: ['wss://oersi.example'] });
    expect(seenRelays).toEqual(['wss://oersi.example']);
  });

  it('surfaces publication indices and sections with their snippets', async () => {
    const pub = evt(30040, 'pub1', [
      ['d', 'tk-p1-pub2'],
      ['title', 'Digitale Prüfungen'],
      ['type', 'academic'],
      ['i', 'doi:10.1/x'],
    ]);
    const pubSnip = evt(21142, 'snip-pub1', [['e', 'pub1'], ['k', '30040'], ['score', '0.9']], 'passage P');
    const section = evt(30041, 'sec1', [['d', 'ch-1'], ['title', 'Kapitel 1']], 'section body text');
    const out = await runContentSearch(fakeClient([pub, pubSnip, section]), { query: 'prüfungen' });
    expect(out.total).toBe(2);
    expect(out.results.map((r) => r.kind)).toEqual([30040, 30041]);
    expect(out.results[0].type).toBe('publication');
    expect(out.results[0].snippet).toBe('passage P');
  });
});

describe('runContentSearch with openLicensesOnly', () => {
  const BY = 'https://creativecommons.org/licenses/by/4.0/';
  const NC = 'https://creativecommons.org/licenses/by-nc/4.0/';
  const res = (id: string, license?: string) =>
    evt(30142, id, [['d', id], ['name', `R ${id}`], ...(license ? [['license:id', license]] : [])]);
  const snip = (parent: string, kind: number, text: string) =>
    evt(21142, `snip-${parent}`, [['e', parent], ['k', String(kind)], ['score', '0.5']], text);

  function recordingClient(events: NostrEvent[]) {
    const filters: Filter[] = [];
    return { filters, queryEvents: async (f: Filter) => { filters.push(f); return events; } };
  }

  it('over-fetches without any field filter, drops non-open resources, keeps other kinds in relay order', async () => {
    const article = evt(30023, 'art1', [['d', 'a'], ['title', 'Artikel']], 'body');
    const client = recordingClient([
      res('nc', NC), snip('nc', 30142, 'passage NC'),
      article, snip('art1', 30023, 'passage A'),
      res('none'),
      res('by', BY), snip('by', 30142, 'passage BY'),
    ]);
    const out = await runContentSearch(client, { query: 'klima', limit: 20, openLicensesOnly: true });

    expect(client.filters[0].limit).toBe(60);
    expect(client.filters[0].search).toBe('klima');
    expect(out.results.map((r) => (r as { type: string }).type)).toEqual(['article', 'resource']);
    expect(out.results[0].snippet).toBe('passage A');
    expect(out.results[1].snippet).toBe('passage BY');
    expect(out.total).toBe(2);
  });

  it('trims the filtered list back to limit', async () => {
    const client = recordingClient([res('a', BY), res('b', NC), res('c', BY), res('d', BY)]);
    const out = await runContentSearch(client, { limit: 2, types: ['resource'], openLicensesOnly: true });
    expect(client.filters[0].limit).toBe(6);
    expect(out.results.map((r) => (r as { title?: string }).title)).toEqual(['R a', 'R c']);
    expect(out.total).toBe(2);
  });

  it('caps the over-fetch at the relay maximum of 250', async () => {
    const client = recordingClient([]);
    await runContentSearch(client, { limit: 200, openLicensesOnly: true });
    expect(client.filters[0].limit).toBe(250);
  });

  it('does not over-fetch when resources are not among the requested types', async () => {
    const client = recordingClient([]);
    await runContentSearch(client, { limit: 10, types: ['article', 'wiki'], openLicensesOnly: true });
    expect(client.filters[0].limit).toBe(10);
  });

  it('returns non-open resources when the switch is off', async () => {
    const client = recordingClient([res('nc', NC), res('none')]);
    const out = await runContentSearch(client, { limit: 10, openLicensesOnly: false });
    expect(client.filters[0].limit).toBe(10);
    expect(out.total).toBe(2);
  });
});
