import { describe, it, expect } from 'vitest';
import { runResourceSearch } from '../../src/tools/search.js';
import type { NostrEvent } from 'nostr-tools';

function resourceEvent(id: string, publisher?: string, license?: string): NostrEvent {
  const tags: string[][] = [
    ['d', `d-${id}`],
    ['name', `Resource ${id}`],
  ];
  if (license) tags.push(['license:id', license]);
  if (publisher) {
    tags.push(['publisher:name', publisher], ['publisher:type', 'Organization']);
  }
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 1700000000,
    kind: 30142,
    tags,
    content: '',
    sig: 's',
  };
}

/** Fake client: first search call gets `first`, later calls get `fallback`. */
function fakeClient(first: NostrEvent[], fallback: NostrEvent[] = []) {
  const searches: string[] = [];
  return {
    searches,
    search: async (s: string) => {
      searches.push(s);
      return searches.length === 1 ? first : fallback;
    },
    query: async () => first,
  };
}

describe('runResourceSearch did-you-mean fallback', () => {
  it('suggests similar actor spellings when a publisherName filter matches nothing', async () => {
    const client = fakeClient(
      [],
      [resourceEvent('r1', 'LEHRE LADEN'), resourceEvent('r2', 'LEHRE LADEN')]
    );

    const out = await runResourceSearch(client, { publisherName: 'Lehreladen' });

    expect(out.total).toBe(0);
    expect(client.searches).toEqual(['publisher.name:Lehreladen', 'Lehreladen']);
    expect(out.actorCandidates).toEqual([{ name: 'LEHRE LADEN', field: 'publisher', count: 2 }]);
    expect(out.hint).toContain('LEHRE LADEN');
  });

  it('does not run the fallback when no actor filter was set', async () => {
    const client = fakeClient([]);
    const out = await runResourceSearch(client, { query: 'nichtexistent' });
    expect(out.total).toBe(0);
    expect(client.searches).toEqual(['nichtexistent']);
    expect(out.actorCandidates).toBeUndefined();
    expect(out.hint).toBeUndefined();
  });

  it('does not run the fallback when the filter matched resources', async () => {
    const client = fakeClient([resourceEvent('r1', 'e-teaching.org')]);
    const out = await runResourceSearch(client, { publisherName: 'e-teaching.org' });
    expect(out.total).toBe(1);
    expect(client.searches).toEqual(['publisher.name:e-teaching.org']);
    expect(out.actorCandidates).toBeUndefined();
  });

  it('omits candidates but keeps a hint when the fallback finds nothing similar', async () => {
    const client = fakeClient([], [resourceEvent('r1', 'e-teaching.org')]);
    const out = await runResourceSearch(client, { publisherName: 'Lehreladen' });
    expect(out.total).toBe(0);
    expect(out.actorCandidates).toBeUndefined();
    expect(out.hint).toContain('exact');
  });
});

describe('runResourceSearch with openLicensesOnly', () => {
  const BY = 'https://creativecommons.org/licenses/by/4.0/';
  const NC = 'https://creativecommons.org/licenses/by-nc/4.0/';

  it('asks the relay for open licenses only and drops non-open stragglers', async () => {
    const client = fakeClient([
      resourceEvent('r1', undefined, BY),
      resourceEvent('r2', undefined, NC),
      resourceEvent('r3'),
    ]);
    const out = await runResourceSearch(client, { query: 'mathe', openLicensesOnly: true });
    expect(client.searches[0]).toMatch(/^mathe license\.id:/);
    expect(client.searches[0]).toContain(`license.id:${BY}`);
    expect(out.total).toBe(1);
    expect(out.resources.map((r) => r.id)).toEqual(['d-r1']);
  });

  it('searches (never plain-queries) a filterless browse so the license filter applies', async () => {
    let queried = false;
    const client = { ...fakeClient([resourceEvent('r1', undefined, BY)]), query: async () => { queried = true; return []; } };
    const out = await runResourceSearch(client, { openLicensesOnly: true });
    expect(queried).toBe(false);
    expect(client.searches[0]).toMatch(/^license\.id:/);
    expect(out.total).toBe(1);
  });

  it('says in the zero-match hint that only open resources are searched', async () => {
    const client = fakeClient([], [resourceEvent('r1', 'LEHRE LADEN', NC)]);
    const out = await runResourceSearch(client, { publisherName: 'Lehreladen', openLicensesOnly: true });
    expect(out.total).toBe(0);
    expect(out.hint).toContain('openly licensed');
  });

  it('keeps non-open resources when the switch is off', async () => {
    const client = fakeClient([resourceEvent('r1', undefined, NC), resourceEvent('r2')]);
    const out = await runResourceSearch(client, { query: 'mathe', openLicensesOnly: false });
    expect(client.searches).toEqual(['mathe']);
    expect(out.total).toBe(2);
  });
});
