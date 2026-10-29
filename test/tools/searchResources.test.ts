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

describe('runResourceSearch with licenseFilter open', () => {
  const BY = 'https://creativecommons.org/licenses/by/4.0/';
  const NC = 'https://creativecommons.org/licenses/by-nc/4.0/';

  it('free text: no relay license filter, post-filters and trims to limit in relay order', async () => {
    const client = fakeClient([
      resourceEvent('r1', undefined, BY),
      resourceEvent('r2', undefined, NC),
      resourceEvent('r3'),
      resourceEvent('r4', undefined, BY),
      resourceEvent('r5', undefined, BY),
    ]);
    const out = await runResourceSearch(client, { query: 'mathe', limit: 2, licenseFilter: 'open' });
    expect(client.searches).toEqual(['mathe']);
    expect(out.total).toBe(2);
    expect(out.resources.map((r) => r.id)).toEqual(['d-r1', 'd-r4']);
  });

  it('pure field filters: relay license filter plus the safety-net post-filter', async () => {
    const client = fakeClient([resourceEvent('r1', 'X', BY), resourceEvent('r2', 'X', NC)]);
    const out = await runResourceSearch(client, { publisherName: 'X', licenseFilter: 'open' });
    expect(client.searches[0]).toMatch(/^publisher\.name:X license\.id:/);
    expect(client.searches[0]).toContain(`license.id:${BY}`);
    expect(out.resources.map((r) => r.id)).toEqual(['d-r1']);
  });

  it('searches (never plain-queries) a filterless browse so the license filter applies', async () => {
    let queried = false;
    const client = { ...fakeClient([resourceEvent('r1', undefined, BY)]), query: async () => { queried = true; return []; } };
    const out = await runResourceSearch(client, { licenseFilter: 'open' });
    expect(queried).toBe(false);
    expect(client.searches[0]).toMatch(/^license\.id:/);
    expect(out.total).toBe(1);
  });

  it('says in the zero-match hint which licenses were searched (genuinely zero, actor unknown)', async () => {
    // First call (field filter + license tokens): nothing. Second call (the
    // license-only-zero probe, licenseFilter widened to any): also nothing —
    // so this is a genuine zero-match, not a license-caused one, and the
    // existing actor fallback runs (no 3rd call programmed: findActorCandidates
    // gets the same `fallback` as the probe, i.e. also empty).
    const client = fakeClient([]);
    const out = await runResourceSearch(client, { publisherName: 'Lehreladen', licenseFilter: 'open' });
    expect(out.total).toBe(0);
    expect(out.actorCandidates).toBeUndefined();
    expect(out.hint).toContain(
      " Only resources under CC0, Public Domain, CC BY, CC BY-SA licenses were searched (licenseFilter: open); " +
        'resources under other licenses or without a license are left out.'
    );
  });

  it('names Creative Commons in the zero-match hint under cc-any (genuinely zero)', async () => {
    const client = fakeClient([]);
    const out = await runResourceSearch(client, { publisherName: 'Lehreladen', licenseFilter: 'cc-any' });
    expect(out.hint).toContain(
      ' Only resources under Creative Commons or Public Domain licenses were searched (licenseFilter: cc-any);'
    );
  });

  it('adds no license sentence to the zero-match hint under any', async () => {
    const client = fakeClient([], [resourceEvent('r1', 'LEHRE LADEN', NC)]);
    const out = await runResourceSearch(client, { publisherName: 'Lehreladen' });
    expect(out.hint).not.toContain('Only resources under');
  });

  it('keeps non-open resources under any', async () => {
    const client = fakeClient([resourceEvent('r1', undefined, NC), resourceEvent('r2')]);
    const out = await runResourceSearch(client, { query: 'mathe', licenseFilter: 'any' });
    expect(client.searches).toEqual(['mathe']);
    expect(out.total).toBe(2);
  });
});

describe('runResourceSearch license tiers', () => {
  const NCSA = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
  const BY = 'https://creativecommons.org/licenses/by/4.0/';
  const events = () => [
    resourceEvent('ncsa', undefined, NCSA),
    resourceEvent('by', undefined, BY),
    resourceEvent('none'),
  ];

  it('any returns every tier, each carrying license and accessLevel', async () => {
    const out = await runResourceSearch(fakeClient(events()), { query: 'mathe', licenseFilter: 'any' });
    expect(out.total).toBe(3);
    expect(out.licenseFilter).toBe('any');
    expect(out.licenseFilterClamped).toBeUndefined();
    const byId = new Map(out.resources.map((r) => [r.id, r]));
    expect(byId.get('d-ncsa')).toMatchObject({
      license: { id: NCSA, label: 'CC BY-NC-SA 4.0' },
      accessLevel: 'full',
    });
    expect(byId.get('d-by')).toMatchObject({ license: { id: BY, label: 'CC BY 4.0' }, accessLevel: 'full' });
    expect(byId.get('d-none')!.license).toBeNull();
    expect(byId.get('d-none')!.accessLevel).toBe('metadata-only');
  });

  it('classifies a plain-license-tag resource as full CC BY (amb-indexer parity)', async () => {
    const event = resourceEvent('plain-license');
    event.tags.push(['license', BY]); // plain `license` tag, no `license:id`
    const out = await runResourceSearch(fakeClient([event]), { query: 'mathe', licenseFilter: 'any' });
    expect(out.resources[0]).toMatchObject({
      license: { id: BY, label: 'CC BY 4.0' },
      accessLevel: 'full',
    });
  });

  it('open returns only the open-tier resource', async () => {
    const out = await runResourceSearch(fakeClient(events()), { query: 'mathe', licenseFilter: 'open' });
    expect(out.resources.map((r) => r.id)).toEqual(['d-by']);
    expect(out.licenseFilter).toBe('open');
  });

  it('cc-any returns the CC resources but not the unlicensed one', async () => {
    const out = await runResourceSearch(fakeClient(events()), { query: 'mathe', licenseFilter: 'cc-any' });
    expect(out.resources.map((r) => r.id)).toEqual(['d-ncsa', 'd-by']);
  });

  it('clamps a wider request to the operator ceiling and says so', async () => {
    const out = await runResourceSearch(
      fakeClient(events()),
      { query: 'mathe', licenseFilter: 'any' },
      undefined,
      { licenseFilterMax: 'open' }
    );
    expect(out.total).toBe(1);
    expect(out.licenseFilter).toBe('open');
    expect(out.licenseFilterClamped).toBe(true);
  });

  it('uses the ceiling as the default when no filter is requested, unclamped', async () => {
    const out = await runResourceSearch(fakeClient(events()), { query: 'mathe' }, undefined, {
      licenseFilterMax: 'cc-any',
    });
    expect(out.total).toBe(2);
    expect(out.licenseFilter).toBe('cc-any');
    expect(out.licenseFilterClamped).toBeUndefined();
  });

  it('Gendering MINT regression: a creatorName search over 10 BY-NC-SA resources returns all 10 by default', async () => {
    const creator = 'Projekt Gendering MINT didaktisch-digital';
    const gendering = Array.from({ length: 10 }, (_, i) => {
      const e = resourceEvent(`g${i}`, undefined, NCSA);
      e.tags.push(['creator:name', creator], ['creator:type', 'Organization']);
      return e;
    });
    const client = fakeClient(gendering);
    const out = await runResourceSearch(client, { creatorName: creator });
    expect(client.searches[0]).not.toContain('license.id:');
    expect(out.total).toBe(10);
    expect(out.resources.every((r) => r.accessLevel === 'full')).toBe(true);
  });
});

describe('runResourceSearch license-only zero-match hint (Gendering MINT bug)', () => {
  const NCSA = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
  const creator = 'Projekt Gendering MINT didaktisch-digital';
  const gendering = () =>
    Array.from({ length: 10 }, (_, i) => {
      const e = resourceEvent(`g${i}`, undefined, NCSA);
      e.tags.push(['creator:name', creator], ['creator:type', 'Organization']);
      return e;
    });

  it('says N resources match under other licenses and suggests widening, with no spelling hint', async () => {
    // 1st call: the relay query itself carries license.id:open tokens plus
    // creator.name — nothing matches server-side (all 10 are BY-NC-SA).
    // 2nd call: the zero-hint probe (same filters, no license tokens) finds
    // all 10 — proving the creator name was exact and only the license
    // filter excluded them.
    const client = fakeClient([], gendering());
    const out = await runResourceSearch(client, { creatorName: creator, licenseFilter: 'open' });

    expect(out.total).toBe(0);
    expect(out.actorCandidates).toBeUndefined();
    expect(out.hint).toBeDefined();
    expect(out.hint).toContain('10');
    expect(out.hint).toContain('CC BY-NC-SA 4.0');
    expect(out.hint).toContain('licenseFilter: "any"');
    expect(out.hint).not.toContain('exact full-string');
    expect(out.hint).not.toContain('spelling');
  });

  it('says the matches are under licenses this server does not return when the ceiling forbids widening', async () => {
    const client = fakeClient([], gendering());
    const out = await runResourceSearch(
      client,
      { creatorName: creator, licenseFilter: 'open' },
      undefined,
      { licenseFilterMax: 'open' }
    );

    expect(out.total).toBe(0);
    expect(out.hint).toContain('10');
    expect(out.hint).toContain("doesn't return");
    expect(out.hint).not.toContain('retry with licenseFilter');
  });

  it('still shows the spelling hint when the actor name truly matches nothing, regardless of license', async () => {
    // Both the primary search and the license-widened probe come back
    // empty, so this is a genuine zero-match and the actor-candidate flow
    // (3rd call) should run as before.
    const client = fakeClient([], []);
    const out = await runResourceSearch(client, { creatorName: 'Does Not Exist', licenseFilter: 'open' });

    expect(out.total).toBe(0);
    expect(out.hint).toContain('exact full-string');
    expect(out.hint).toContain('Only resources under');
  });
});

describe('search_resources description', () => {
  async function description(licenseFilterMax: 'open' | 'cc-any' | 'any'): Promise<string> {
    const { buildSessionServer } = await import('../../src/session.js');
    const session = buildSessionServer(['wss://relay.edufeed.org'], ['wss://relay.edufeed.org'], undefined, {
      licenseFilterMax,
    });
    const registry = (
      session.server as unknown as { _registeredTools: Record<string, { description?: string }> }
    )._registeredTools;
    const text = registry['search_resources'].description ?? '';
    session.dispose();
    return text;
  }

  it('describes the tiers and names no ceiling under any', async () => {
    const text = await description('any');
    expect(text).toContain('Every learning resource is returned by default');
    expect(text).toContain('accessLevel');
    expect(text).not.toContain('This server limits results');
  });

  it('names the ceiling when it is below any', async () => {
    expect(await description('cc-any')).toContain("This server limits results to licenseFilter 'cc-any'.");
  });
});
