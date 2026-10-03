import { describe, it, expect } from 'vitest';
import { buildFilter, buildContentFilter, searchHasFreeText } from '../../src/relay/filters.js';
import { OPEN_LICENSE_URIS } from '../../src/license/open.js';

/**
 * Port of the relay's NIP-50 field-filter handling
 * (nostrlib/eventstore/typesense30142/query.go: tokenizeSearch,
 * parseFieldFilter, BuildTypesenseQuery): tokens split on spaces (quoted
 * segments kept), field = text before the first colon, filters grouped by the
 * base name before the first dot — OR inside a group, AND across groups.
 */
function relayFilterGroups(search: string): { raw: string[]; groups: Map<string, string[]> } {
  const tokens = search.match(/"[^"]*"|(?:[^\s"]|"[^"]*")+/g) ?? [];
  const raw: string[] = [];
  const groups = new Map<string, string[]>();
  for (const t of tokens) {
    const i = t.indexOf(':');
    const value = i > 0 ? t.slice(i + 1).replace(/^"|"$/g, '') : '';
    if (i <= 0 || !value) {
      raw.push(t.replace(/^"|"$/g, ''));
      continue;
    }
    const field = t.slice(0, i);
    const base = field.split('.')[0];
    groups.set(base, [...(groups.get(base) ?? []), `${field}:=${value}`]);
  }
  return { raw, groups };
}

describe('searchHasFreeText (mirror of amb-relay searchHasFreeText)', () => {
  it.each([
    ['mathematik', true],
    ['bruchrechnung publisher.name:"LEHRE LADEN"', true],
    ['"multi word phrase"', true],
    ['', false],
    ['   ', false],
    ['publisher.name:"LEHRE LADEN"', false],
    ['type:academic sort:created_at:desc', false],
    ['"doi:10.1/x"', false], // a standalone quoted token is still parsed as a filter
    ['field:', true], // empty value → not a filter → raw term
    [':value', true],
  ])('%s → %s', (search, expected) => {
    expect(searchHasFreeText(search)).toBe(expected);
  });
});

describe('buildFilter with openLicensesOnly', () => {
  it('adds no license filter to a free-text search (keeps relay chunk rerank) and over-fetches', () => {
    const { filter, search, limit } = buildFilter({ query: 'mathematik', limit: 20, openLicensesOnly: true });
    expect(search).toBe('mathematik');
    expect(filter.limit).toBe(60);
    expect(limit).toBe(20);
  });

  it('caps the free-text over-fetch at 250', () => {
    expect(buildFilter({ query: 'x', limit: 200, openLicensesOnly: true }).filter.limit).toBe(250);
  });

  it('treats free text next to caller field filters as free text', () => {
    const { search } = buildFilter({ query: 'bruchrechnung', publisherName: 'LEHRE LADEN', openLicensesOnly: true });
    expect(search).toBe('bruchrechnung publisher.name:"LEHRE LADEN"');
  });

  it('adds license.id filters to a pure field-filter search, ANDed with the caller filters', () => {
    const { filter, search, limit } = buildFilter({
      publisherName: 'LEHRE LADEN',
      subjectLabel: 'Mathematik',
      limit: 20,
      openLicensesOnly: true,
    });
    const { raw, groups } = relayFilterGroups(search);
    expect(raw).toEqual([]);
    expect(groups.get('publisher')).toEqual(['publisher.name:=LEHRE LADEN']);
    expect(groups.get('about')).toEqual(['about.prefLabel.de:=Mathematik']);
    expect(groups.get('license')).toEqual(OPEN_LICENSE_URIS.map((u) => `license.id:=${u}`));
    expect([...groups.keys()].sort()).toEqual(['about', 'license', 'publisher']);
    expect(filter.limit).toBe(20);
    expect(limit).toBe(20);
  });

  it('treats a field-filter-only query string as no free text', () => {
    const { search } = buildFilter({ query: 'type:academic', openLicensesOnly: true });
    expect(relayFilterGroups(search).groups.has('license')).toBe(true);
  });

  it('turns a filterless browse into a license-only search', () => {
    const { search } = buildFilter({ openLicensesOnly: true });
    const { raw, groups } = relayFilterGroups(search);
    expect(raw).toEqual([]);
    expect([...groups.keys()]).toEqual(['license']);
  });

  it('adds nothing and keeps the limit when the switch is off or absent', () => {
    expect(buildFilter({ query: 'x', openLicensesOnly: false })).toMatchObject({ search: 'x', filter: { limit: 20 } });
    expect(buildFilter({ publisherName: 'X' }).search).toBe('publisher.name:X');
  });
});

describe('buildContentFilter', () => {
  it('never carries a license field filter (it would disable chunk rerank)', () => {
    const f = buildContentFilter({ query: 'klima', types: ['resource'] });
    expect(f.search).toBe('klima');
  });
});
