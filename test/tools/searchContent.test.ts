import { describe, it, expect } from 'vitest';
import { runContentSearch } from '../../src/tools/searchContent.js';
import type { NostrEvent, Filter } from 'nostr-tools';
import type { ResourceResult, ArticleResult } from '../../src/content/types.js';
import { nip19 } from 'nostr-tools';
import { setEventRelay } from '../../src/relay/provenance.js';

function evt(kind: number, id: string, tags: string[][], content = ''): NostrEvent {
  return { id, pubkey: 'a'.repeat(64), created_at: 1700000000, kind, tags, content, sig: 's' };
}

// A fake client that returns a fixed, ordered event stream (content interleaved
// with the 21142 snippet that follows each result), exactly as the relay emits.
function fakeClient(events: NostrEvent[]) {
  return { queryEvents: async () => events };
}

describe('runContentSearch', () => {
  it('returns typed, ranked results with snippets attached and 21142 excluded', async () => {
    const article = evt(30023, 'art1', [['d', 'a'], ['title', 'Aufmerksamkeit']], 'body a');
    const artSnip = evt(21142, 'snip-art1', [['e', 'art1'], ['k', '30023'], ['score', '0.81']], 'passage A');
    const wiki = evt(30818, 'wiki1', [['d', 'w'], ['title', 'Seminar']], 'body w');
    const wikiSnip = evt(21142, 'snip-wiki1', [['e', 'wiki1'], ['k', '30818'], ['score', '0.66']], 'passage W');
    const resource = evt(30142, 'res1', [['d', 'r'], ['name', 'Video zur Aufmerksamkeit']]);

    const out = await runContentSearch(
      fakeClient([article, artSnip, wiki, wikiSnip, resource]),
      { query: 'aufmerksamkeit', language: 'de' }
    );

    expect(out.total).toBe(3);
    // Ranked by score + lexical: article 0.81+1, resource 0+1, wiki 0.66+0.
    expect(out.results.map((r) => r.type)).toEqual(['article', 'resource', 'wiki']);
    expect(out.results[0].snippet).toBe('passage A');
    expect(out.results[0].score).toBeCloseTo(0.81);
    expect(out.results[2].snippet).toBe('passage W');
    expect(out.results[1].snippet).toBeUndefined(); // no snippet for the resource
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

  it('carries the source relay and hints it in the naddr', async () => {
    const article = evt(30023, 'art1', [['d', 'a'], ['title', 'Aufmerksamkeit']], 'body a');
    const resource = evt(30142, 'res1', [['d', 'r'], ['name', 'Video zur Aufmerksamkeit']]);
    const bare = evt(30818, 'wiki1', [['d', 'w'], ['title', 'Seminar']]);
    setEventRelay(article, 'wss://a.example');
    setEventRelay(resource, 'wss://b.example');

    const out = await runContentSearch(fakeClient([article, resource, bare]), { query: 'x' });

    expect(out.results.map((r) => r.relay)).toEqual(['wss://a.example', 'wss://b.example', undefined]);
    const decoded = out.results.map((r) => (nip19.decode(r.naddr!).data as { relays?: string[] }).relays);
    expect(decoded).toEqual([['wss://a.example'], ['wss://b.example'], []]);
  });

  it('returns an empty result set when the relay returns nothing', async () => {
    const out = await runContentSearch(fakeClient([]), { query: 'x' });
    expect(out).toEqual({ total: 0, results: [], licenseFilter: 'any' });
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
    const section = evt(30041, 'sec1', [['d', 'ch-1'], ['title', 'Kapitel 1: Prüfungen']], 'section body text');
    const out = await runContentSearch(fakeClient([pub, pubSnip, section]), { query: 'prüfungen' });
    expect(out.total).toBe(2);
    expect(out.results.map((r) => r.kind)).toEqual([30040, 30041]);
    expect(out.results[0].type).toBe('publication');
    expect(out.results[0].snippet).toBe('passage P');
  });
});

describe('runContentSearch with licenseFilter', () => {
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

  it('over-fetches without any field filter, drops resources outside the filter, keeps other kinds in relay order', async () => {
    const article = evt(30023, 'art1', [['d', 'a'], ['title', 'Artikel']], 'body');
    const client = recordingClient([
      res('nc', NC), snip('nc', 30142, 'passage NC'),
      article, snip('art1', 30023, 'passage A'),
      res('none'),
      res('by', BY), snip('by', 30142, 'passage BY'),
    ]);
    const out = await runContentSearch(client, { query: 'klima', limit: 20, licenseFilter: 'open' });

    expect(client.filters[0].limit).toBe(60);
    expect(client.filters[0].search).toBe('klima');
    expect(out.results.map((r) => (r as { type: string }).type)).toEqual(['article', 'resource']);
    expect(out.results[0].snippet).toBe('passage A');
    expect(out.results[1].snippet).toBe('passage BY');
    expect(out.total).toBe(2);
    expect(out.licenseFilter).toBe('open');
  });

  it('trims the filtered list back to limit', async () => {
    const client = recordingClient([res('a', BY), res('b', NC), res('c', BY), res('d', BY)]);
    const out = await runContentSearch(client, { limit: 2, types: ['resource'], licenseFilter: 'open' });
    expect(client.filters[0].limit).toBe(6);
    expect(out.results.map((r) => (r as { title?: string }).title)).toEqual(['R a', 'R c']);
    expect(out.total).toBe(2);
  });

  it('post-filters over ALL license:id tags (KIM attribution + nonCommercial is not open)', async () => {
    const KIM = (t: string) => `https://w3id.org/kim/license/${t}`;
    const kimEvt = (id: string, terms: string[]) =>
      evt(30142, id, [['d', id], ['name', `R ${id}`], ...terms.map((t) => ['license:id', KIM(t)])]);
    const client = recordingClient([
      kimEvt('bysa', ['attribution', 'shareAlike']),
      kimEvt('bync', ['attribution', 'nonCommercial']),
    ]);
    const open = await runContentSearch(client, { types: ['resource'], licenseFilter: 'open' });
    expect(open.results.map((r) => (r as { title?: string }).title)).toEqual(['R bysa']);
    const ccAny = await runContentSearch(client, { types: ['resource'], licenseFilter: 'cc-any' });
    expect(ccAny.results.map((r) => (r as { license?: unknown }).license)).toEqual([
      { id: KIM('attribution'), label: 'BY-SA (KIM)' },
      { id: KIM('attribution'), label: 'BY-NC (KIM)' },
    ]);
  });

  it('caps the over-fetch at the relay maximum of 250', async () => {
    const client = recordingClient([]);
    await runContentSearch(client, { limit: 200, licenseFilter: 'open' });
    expect(client.filters[0].limit).toBe(250);
  });

  it('does not over-fetch when resources are not among the requested types', async () => {
    const client = recordingClient([]);
    await runContentSearch(client, { limit: 10, types: ['article', 'wiki'], licenseFilter: 'open' });
    expect(client.filters[0].limit).toBe(10);
  });

  it('returns resources outside the filter when licenseFilter is any', async () => {
    const client = recordingClient([res('nc', NC), res('none')]);
    const out = await runContentSearch(client, { limit: 10, licenseFilter: 'any' });
    expect(client.filters[0].limit).toBe(10);
    expect(out.total).toBe(2);
  });

  it('clamps a request wider than the server ceiling and reports it', async () => {
    const client = recordingClient([res('nc', NC), res('by', BY)]);
    const out = await runContentSearch(
      client,
      { limit: 10, licenseFilter: 'any' },
      { licenseFilterMax: 'open' }
    );
    expect(out.licenseFilter).toBe('open');
    expect(out.licenseFilterClamped).toBe(true);
    expect(out.total).toBe(1);
  });
});

describe('runContentSearch license tiers on search_content results (B3)', () => {
  const BY_NC_ND = 'https://creativecommons.org/licenses/by-nc-nd/4.0/';

  function scenario(): NostrEvent[] {
    const article = evt(30023, 'art1', [['d', 'a'], ['title', 'Artikel']], 'body');
    const ncnd = evt(30142, 'ncnd1', [['d', 'ncnd1'], ['name', 'NC-ND Resource'], ['license:id', BY_NC_ND]]);
    const ncndSnip = evt(
      21142,
      'snip-ncnd1',
      [['e', 'ncnd1'], ['k', '30142'], ['score', '0.7'], ['page', '3'], ['heading', 'Intro'], ['source_url', 'https://ex.org/ncnd']],
      'passage NCND'
    );
    const unlicensed = evt(30142, 'none1', [['d', 'none1'], ['name', 'Unlicensed Resource']]);
    const unlicensedSnip = evt(
      21142,
      'snip-none1',
      [['e', 'none1'], ['k', '30142'], ['score', '0.6'], ['page', '1'], ['heading', 'Kapitel'], ['source_url', 'https://ex.org/none']],
      'passage NONE'
    );
    return [article, ncnd, ncndSnip, unlicensed, unlicensedSnip];
  }

  it('licenseFilter "any" returns all three; metadata-only loses its fulltext, the cc resource keeps it', async () => {
    const out = await runContentSearch(fakeClient(scenario()), { query: 'x', licenseFilter: 'any' });
    expect(out.total).toBe(3);
    expect(out.licenseFilter).toBe('any');

    const article = out.results.find((r) => r.type === 'article') as ArticleResult;
    const ncnd = out.results.find((r) => r.type === 'resource' && r.title === 'NC-ND Resource') as ResourceResult;
    const unlicensed = out.results.find(
      (r) => r.type === 'resource' && r.title === 'Unlicensed Resource'
    ) as ResourceResult;

    expect(article).toBeTruthy();

    expect(unlicensed.accessLevel).toBe('metadata-only');
    expect(unlicensed.license).toBeNull();
    expect(unlicensed.snippet).toBeUndefined();
    expect(unlicensed.page).toBeUndefined();
    expect(unlicensed.heading).toBeUndefined();
    expect(unlicensed.score).toBeUndefined();
    expect(unlicensed.sourceUrl).toBeUndefined();

    expect(ncnd.accessLevel).toBe('full');
    expect(ncnd.license?.label).toBe('CC BY-NC-ND 4.0');
    expect(ncnd.snippet).toBe('passage NCND');
    expect(ncnd.page).toBe(3);
    expect(ncnd.heading).toBe('Intro');
    expect(ncnd.score).toBe(0.7);
    expect(ncnd.sourceUrl).toBe('https://ex.org/ncnd');
  });

  it('licenseFilter "open" returns only the article — other kinds are never filtered', async () => {
    const out = await runContentSearch(fakeClient(scenario()), { query: 'x', licenseFilter: 'open' });
    expect(out.results.map((r) => r.type)).toEqual(['article']);
    expect(out.licenseFilter).toBe('open');
  });
});

describe('runContentSearch license-only zero-match hint (Gendering MINT bug, analog)', () => {
  const NCSA = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
  const gendering = () =>
    Array.from({ length: 10 }, (_, i) =>
      evt(30142, `g${i}`, [['d', `g${i}`], ['name', `Resource ${i}`], ['license:id', NCSA]])
    );

  it('says N resources match under other licenses and suggests widening', async () => {
    const client = fakeClient(gendering());
    const out = await runContentSearch(client, { query: 'gendering', types: ['resource'], licenseFilter: 'open' });

    expect(out.total).toBe(0);
    expect(out.hint).toBeDefined();
    expect(out.hint).toContain('10');
    expect(out.hint).toContain('CC BY-NC-SA 4.0');
    expect(out.hint).toContain('licenseFilter: "any"');
  });

  it('says the matches are under licenses this server does not return when the ceiling forbids widening', async () => {
    const client = fakeClient(gendering());
    const out = await runContentSearch(
      client,
      { query: 'gendering', types: ['resource'], licenseFilter: 'open' },
      { licenseFilterMax: 'open' }
    );

    expect(out.total).toBe(0);
    expect(out.hint).toContain('10');
    expect(out.hint).toContain("doesn't return");
    expect(out.hint).not.toContain('retry with licenseFilter');
  });

  it('adds no hint when results are genuinely empty', async () => {
    const out = await runContentSearch(fakeClient([]), { query: 'x', types: ['resource'], licenseFilter: 'open' });
    expect(out.total).toBe(0);
    expect(out.hint).toBeUndefined();
  });

  it('adds no hint when licenseFilter is any', async () => {
    const out = await runContentSearch(fakeClient([]), { query: 'x', licenseFilter: 'any' });
    expect(out.total).toBe(0);
    expect(out.hint).toBeUndefined();
  });
});

describe('runContentSearch cross-relay ranking', () => {
  const cookie = evt(30023, 'cookie', [['d', 'c'], ['title', 'Cookie Policy (EU)']], 'body');
  const cookieSnip = evt(21142, 'snip-c', [['e', 'cookie'], ['k', '30023'], ['score', '0.7']], 'cookies');
  const vorkurs = evt(30142, 'vk', [
    ['d', 'v'], ['name', 'Vorkurs Mathematik "11 Stochastik"'], ['description', 'Grundlagen der Statistik'],
  ]);
  const other = evt(30142, 'oth', [['d', 'o'], ['name', 'Kekse backen']]);

  it('ranks the exact title above a higher-snippet unrelated hit and applies limit after the sort', async () => {
    const out = await runContentSearch(fakeClient([cookie, cookieSnip, other, vorkurs]), {
      query: 'Statistik Vorkurs',
      limit: 1,
    });
    expect(out.results.map((r) => r.title)).toEqual(['Vorkurs Mathematik "11 Stochastik"']);
    expect(out.results[0].lexical).toBe(0.75);
    expect(out.total).toBe(1);
  });

  it('sorts zero-match hits last instead of dropping them', async () => {
    const out = await runContentSearch(fakeClient([cookie, cookieSnip, other, vorkurs]), {
      query: 'Statistik Vorkurs',
    });
    expect(out.results.map((r) => r.title)).toEqual([
      'Vorkurs Mathematik "11 Stochastik"', 'Cookie Policy (EU)', 'Kekse backen',
    ]);
  });

  it('field-only search keeps arrival order and drops nothing', async () => {
    const out = await runContentSearch(fakeClient([cookie, cookieSnip, other, vorkurs]), {
      types: ['article', 'resource'],
    });
    expect(out.results.map((r) => r.title)).toEqual([
      'Cookie Policy (EU)', 'Kekse backen', 'Vorkurs Mathematik "11 Stochastik"',
    ]);
    expect(out.results[0].lexical).toBeUndefined();
  });
});

describe('runContentSearch interprets the question', () => {
  const L2 = 'https://w3id.org/kim/isced-1997/level2';
  const L1 = 'https://w3id.org/kim/isced-1997/level1';
  function capturing(events: NostrEvent[]) {
    const seen: Filter[] = [];
    return { seen, client: { queryEvents: async (f: Filter) => (seen.push(f), events) } };
  }

  it('sends the cleaned text with prefer hints and reports the interpretation', async () => {
    const { seen, client } = capturing([]);
    const out = await runContentSearch(client, { query: 'Bruchrechnung Klasse 6' });
    expect(seen[0].search).toBe(
      `Bruchrechnung prefer.level:${L2} prefer.level:https://w3id.org/kim/educationalLevel/level_2 prefer.grade:6`
    );
    expect(out.interpretation).toEqual({
      text: 'Bruchrechnung',
      levels: [L2, 'https://w3id.org/kim/educationalLevel/level_2'],
      grade: '6',
      types: [],
    });
  });

  it('leaves a question without such words alone', async () => {
    const { seen, client } = capturing([]);
    const out = await runContentSearch(client, { query: 'Fotosynthese' });
    expect(seen[0].search).toBe('Fotosynthese');
    expect(out.interpretation).toBeUndefined();
  });

  it('keeps the community scope behind the hints', async () => {
    const { seen, client } = capturing([]);
    await runContentSearch(client, { query: 'Bruchrechnung Grundschule', community: 'a'.repeat(64) });
    expect(seen[0].search).toMatch(/^Bruchrechnung prefer\.level:.* community:a{64}$/);
  });

  it('orders by level fit from the events own tags', async () => {
    const wrong = evt(30142, 'wrong', [['d', '1'], ['name', 'Bruchrechnung A'], ['educationalLevel:id', L1]]);
    const none = evt(30142, 'none', [['d', '2'], ['name', 'Bruchrechnung B']]);
    const right = evt(30142, 'right', [['d', '3'], ['name', 'Bruchrechnung C'], ['educationalLevel:id', L2]]);
    const { client } = capturing([wrong, none, right]);
    const out = await runContentSearch(client, { query: 'Bruchrechnung Klasse 6' });
    expect(out.results.map((r) => (r as { title?: string; name?: string }).title ?? (r as { name?: string }).name)).toEqual(['Bruchrechnung C', 'Bruchrechnung B', 'Bruchrechnung A']);
  });
});

describe('runContentSearch with extra relays', () => {
  function recording() {
    const calls: { filter: Filter; opts?: { extraRelays?: string[]; searchFor?: (url: string) => string | undefined } }[] = [];
    return { calls, client: { queryEvents: async (filter: Filter, _sel?: string[], opts?: any) => (calls.push({ filter, opts }), []) } };
  }
  const noHints = (async () => new Response('{}')) as unknown as typeof fetch;
  const hints = (async () => new Response(JSON.stringify({ nip50: ['ext prefer.level'] }))) as unknown as typeof fetch;

  it('sends plain text to an extra relay without hint support and hints to one with', async () => {
    const { calls, client } = recording();
    await runContentSearch(client, { query: 'Bruchrechnung Klasse 6', extraRelays: ['wss://plain.example.org', 'wss://smart.example.org'] },
      { fetchFn: (async (url: string) => (String(url).includes('smart') ? hints(url) : noHints(url))) as unknown as typeof fetch });
    const { filter, opts } = calls[0];
    expect(opts?.extraRelays).toEqual(['wss://plain.example.org', 'wss://smart.example.org']);
    expect(opts?.searchFor?.('wss://plain.example.org')).toBe('Bruchrechnung');
    expect(opts?.searchFor?.('wss://smart.example.org')).toBeUndefined(); // gets the filter's own (hinted) search
    expect(opts?.searchFor?.('wss://amb-relay.edufeed.org')).toBeUndefined(); // configured relays are nope-relays
    expect(filter.search).toContain('prefer.grade:6');
  });

  it('rejects more than 3 extra relays and non-public URLs', async () => {
    const { client } = recording();
    await expect(runContentSearch(client, { query: 'x', extraRelays: ['wss://a.example.org', 'wss://b.example.org', 'wss://c.example.org', 'wss://d.example.org'] })).rejects.toThrow(/3/);
    await expect(runContentSearch(client, { query: 'x', extraRelays: ['wss://10.0.0.1'] })).rejects.toThrow();
  });
});
