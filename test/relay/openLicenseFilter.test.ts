import { describe, it, expect } from 'vitest';
import { buildFilter, buildContentFilter } from '../../src/relay/filters.js';
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

describe('buildFilter with openLicensesOnly', () => {
  it('appends one license.id filter per open URI', () => {
    const { search } = buildFilter({ query: 'mathematik', openLicensesOnly: true });
    const { raw, groups } = relayFilterGroups(search);
    expect(raw).toEqual(['mathematik']);
    expect(groups.get('license')).toEqual(OPEN_LICENSE_URIS.map((u) => `license.id:=${u}`));
  });

  it('keeps caller field filters in their own AND group, ORing only the licenses', () => {
    const { search } = buildFilter({
      query: 'bruchrechnung',
      publisherName: 'LEHRE LADEN',
      subjectLabel: 'Mathematik',
      openLicensesOnly: true,
    });
    const { raw, groups } = relayFilterGroups(search);
    expect(raw).toEqual(['bruchrechnung']);
    expect(groups.get('publisher')).toEqual(['publisher.name:=LEHRE LADEN']);
    expect(groups.get('about')).toEqual(['about.prefLabel.de:=Mathematik']);
    expect(groups.get('license')).toHaveLength(OPEN_LICENSE_URIS.length);
    expect([...groups.keys()].sort()).toEqual(['about', 'license', 'publisher']);
  });

  it('turns a filterless browse into a license-only search', () => {
    const { search } = buildFilter({ openLicensesOnly: true });
    const { raw, groups } = relayFilterGroups(search);
    expect(raw).toEqual([]);
    expect([...groups.keys()]).toEqual(['license']);
  });

  it('adds nothing when the switch is off or absent', () => {
    expect(buildFilter({ query: 'x', openLicensesOnly: false }).search).toBe('x');
    expect(buildFilter({ query: 'x' }).search).toBe('x');
  });
});

describe('buildContentFilter', () => {
  it('never carries a license field filter (it would disable chunk rerank)', () => {
    const f = buildContentFilter({ query: 'klima', types: ['resource'] });
    expect(f.search).toBe('klima');
  });
});
