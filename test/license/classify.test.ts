import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NostrEvent } from 'nostr-tools';
import {
  classifyLicense, classifyLicenses, accessLevelFor, matchesLicenseFilter, eventLicense,
  CC_LICENSE_URIS, licenseValuesOf,
  parseLicenseFilterMax, clampLicenseFilter,
} from '../../src/license/classify.js';
import { OPEN_LICENSE_URIS } from '../../src/license/open.js';

interface Fixture { licenseIds: { id: string; count: number }[] }
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/license-ids.json', import.meta.url), 'utf8')
) as Fixture;
const fixtureIds = fixture.licenseIds.map((l) => l.id);

describe('classifyLicense', () => {
  it.each([
    ['https://creativecommons.org/licenses/by-nc-sa/4.0/', 'cc', 'CC BY-NC-SA 4.0'],
    ['https://creativecommons.org/licenses/by-sa/3.0/de/deed.de', 'open', 'CC BY-SA 3.0 DE'],
    ['http://creativecommons.org/licenses/by-sa/4.0/legalcode.de', 'open', 'CC BY-SA 4.0'],
    ['https://creativecommons.org/publicdomain/zero/1.0/', 'open', 'CC0 1.0'],
    ['https://creativecommons.org/publicdomain/mark/1.0/', 'open', 'PDM 1.0'],
    ['https://creativecommons.org/licenses/by-nc/3.0/', 'cc', 'CC BY-NC 3.0'],
    ['https://creativecommons.org/licenses/by-nd/4.0/', 'cc', 'CC BY-ND 4.0'],
  ] as const)('classifies %s as %s with label %s', (uri, group, label) => {
    const result = classifyLicense(uri);
    expect(result.group).toBe(group);
    expect(result.license).toEqual({ id: uri, label });
  });

  it('classifies an unrecognised URI as other with label unknown', () => {
    const uri = 'https://example.org/my-license';
    expect(classifyLicense(uri)).toEqual({ group: 'other', license: { id: uri, label: 'unknown' } });
  });

  it('is classifyLicenses with one value', () => {
    for (const uri of ['https://w3id.org/kim/license/attribution', 'https://www.gnu.org/licenses/gpl-3.0', undefined]) {
      expect(classifyLicense(uri)).toEqual(classifyLicenses([uri]));
    }
  });

  it.each([undefined, ''])('classifies %s as none', (uri) => {
    expect(classifyLicense(uri)).toEqual({ group: 'none', license: null });
  });

  it('does not read a trailing license-element token as a port', () => {
    // Mirrors the OPEN_PATTERNS guard in open.ts: nc/nd/sa are not
    // jurisdictions, so this must not read as a ported "by" license.
    const uri = 'https://creativecommons.org/licenses/by/4.0/nc';
    expect(classifyLicense(uri)).toEqual({ group: 'other', license: { id: uri, label: 'unknown' } });
  });
});

const KIM = (t: string) => `https://w3id.org/kim/license/${t}`;
const BY_NC_4 = 'https://creativecommons.org/licenses/by-nc/4.0/';

describe('classifyLicenses (2026-11-01 contract examples, shared with amb-indexer)', () => {
  it.each([
    [[KIM('attribution'), KIM('shareAlike')], 'open', 'BY-SA (KIM)', KIM('attribution')],
    [[KIM('attribution')], 'open', 'BY (KIM)', KIM('attribution')],
    [[KIM('attribution'), KIM('nonCommercial')], 'cc', 'BY-NC (KIM)', KIM('attribution')],
    [[KIM('nonCommercial-noDerivatives')], 'cc', 'BY-NC-ND (KIM)', KIM('nonCommercial-noDerivatives')],
    [[KIM('shareAlike'), KIM('noDerivatives')], 'other', 'unknown', KIM('shareAlike')],
    [[KIM('noLicense')], 'other', 'Keine Lizenz (KIM)', KIM('noLicense')],
    [[KIM('publicDomain')], 'open', 'Public Domain (KIM)', KIM('publicDomain')],
    [[KIM('attribution'), BY_NC_4], 'cc', 'CC BY-NC 4.0', BY_NC_4],
    [['https://www.gnu.org/licenses/gpl-3.0-standalone.html'], 'open', 'GPL-3.0', null],
    [['http://www.gnu.org/licenses/gpl-3.0'], 'open', 'GPL-3.0', null],
    [['https://www.gnu.org/licenses/fdl-1.3.html'], 'open', 'GFDL-1.3', null],
    [['https://opensource.org/license/mit'], 'open', 'MIT', null],
    [['https://www.apache.org/licenses/LICENSE-2.0'], 'open', 'Apache-2.0', null],
    [['https://opensource.org/license/bsd-3-clause'], 'open', 'BSD-3-Clause', null],
    [['https://de.wikipedia.org/wiki/Urheberrecht_(Deutschland)'], 'other', 'Alle Rechte vorbehalten', null],
    [['https://creativecommons.org/licenses/by-nc-sa/4.0//by/4.0'], 'other', 'unknown', null],
    [['https://example.org/my-license'], 'other', 'unknown', null],
  ] as const)('%j -> %s %s', (values, group, label, id) => {
    expect(classifyLicenses(values)).toEqual({ group, license: { id: id ?? values[0], label } });
  });

  it('returns none for no (or only blank) values', () => {
    expect(classifyLicenses([])).toEqual({ group: 'none', license: null });
    expect(classifyLicenses(['', '  ', undefined])).toEqual({ group: 'none', license: null });
  });

  it('lets the FIRST CC/PD value decide, wherever it sits', () => {
    const by = 'https://creativecommons.org/licenses/by/4.0/';
    expect(classifyLicenses(['https://example.org/x', by, BY_NC_4]).license).toEqual({ id: by, label: 'CC BY 4.0' });
  });

  it('composes KIM terms as a set (order and duplicates do not matter, terms case-insensitive)', () => {
    expect(classifyLicenses([KIM('shareAlike'), KIM('nonCommercial'), KIM('shareAlike')]))
      .toEqual({ group: 'cc', license: { id: KIM('shareAlike'), label: 'BY-NC-SA (KIM)' } });
    expect(classifyLicenses(['http://w3id.org/kim/license/NONCOMMERCIAL/', KIM('noDerivatives')]))
      .toEqual({ group: 'cc', license: { id: 'http://w3id.org/kim/license/NONCOMMERCIAL/', label: 'BY-NC-ND (KIM)' } });
    expect(classifyLicenses([KIM('noDerivatives')]).license?.label).toBe('BY-ND (KIM)');
    expect(classifyLicenses([KIM('nonCommercial')]).license?.label).toBe('BY-NC (KIM)');
  });

  it('treats noLicense as winning and publicDomain mixed with other terms as unknown', () => {
    expect(classifyLicenses([KIM('attribution'), KIM('noLicense')]).license?.label).toBe('Keine Lizenz (KIM)');
    expect(classifyLicenses([KIM('publicDomain'), KIM('attribution')]))
      .toEqual({ group: 'other', license: { id: KIM('publicDomain'), label: 'unknown' } });
  });

  it('ignores unknown KIM terms (they are not KIM values)', () => {
    expect(classifyLicenses([KIM('bogus'), KIM('attribution')]))
      .toEqual({ group: 'open', license: { id: KIM('attribution'), label: 'BY (KIM)' } });
    expect(classifyLicenses([KIM('bogus')]))
      .toEqual({ group: 'other', license: { id: KIM('bogus'), label: 'unknown' } });
  });

  it('ranks KIM over free licences, free licences over the all-rights-reserved marker', () => {
    const gpl = 'https://www.gnu.org/licenses/gpl-3.0';
    const arr = 'https://de.wikipedia.org/wiki/Urheberrecht_(Deutschland)';
    expect(classifyLicenses([gpl, KIM('nonCommercial')]).license?.label).toBe('BY-NC (KIM)');
    expect(classifyLicenses([arr, gpl]).license).toEqual({ id: gpl, label: 'GPL-3.0' });
    expect(classifyLicenses(['https://example.org/x', arr]).license).toEqual({ id: arr, label: 'Alle Rechte vorbehalten' });
  });

  it.each([
    ['https://www.gnu.org/licenses/lgpl-2.1.html', 'LGPL-2.1'],
    ['https://gnu.org/licenses/agpl-3.0', 'AGPL-3.0'],
    ['https://www.gnu.org/licenses/fdl-1.2.txt', 'GFDL-1.2'],
    ['https://opensource.org/licenses/MIT/', 'MIT'],
    ['https://apache.org/licenses/LICENSE-2.0.html', 'Apache-2.0'],
    ['https://opensource.org/licenses/BSD-2-Clause', 'BSD-2-Clause'],
    ['https://spdx.org/licenses/GPL-3.0-or-later.html', 'GPL-3.0-or-later'],
    ['https://spdx.org/licenses/Apache-2.0', 'Apache-2.0'],
    ['https://spdx.org/licenses/MIT.html', 'MIT'],
    ['https://spdx.org/licenses/BSD-3-Clause', 'BSD-3-Clause'],
  ])('classifies free licence %s as open %s', (uri, label) => {
    expect(classifyLicenses([uri])).toEqual({ group: 'open', license: { id: uri, label } });
  });

  it.each([
    'https://spdx.org/licenses/CC-BY-NC-4.0',
    'https://www.gnu.org/licenses/gpl-faq',
    'https://opensource.org/license/bsd-4-clause',
    'https://example.org/licenses/gpl-3.0',
  ])('does not treat %s as a free licence', (uri) => {
    expect(classifyLicenses([uri]).group).toBe('other');
  });

  it('accepts URL-encoded parentheses in the all-rights-reserved marker', () => {
    const uri = 'https://de.wikipedia.org/wiki/Urheberrecht_%28Deutschland%29';
    expect(classifyLicenses([uri])).toEqual({ group: 'other', license: { id: uri, label: 'Alle Rechte vorbehalten' } });
  });
});

describe('licenseValuesOf', () => {
  it('reads a string, an array of strings, or nothing', () => {
    expect(licenseValuesOf('a')).toEqual(['a']);
    expect(licenseValuesOf(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(licenseValuesOf(undefined)).toEqual([]);
    expect(licenseValuesOf({})).toEqual([]);
  });
});

/** KIM terms not (yet) stored on the relays that can classify open or cc. */
const KIM_CC_TERMS = [
  KIM('shareAlike'), KIM('publicDomain'), KIM('nonCommercial'),
  KIM('noDerivatives'), KIM('nonCommercial-noDerivatives'),
];

describe('CC_LICENSE_URIS', () => {
  it('is exactly the stored fixture variants that classify open or cc, plus the KIM terms', () => {
    const expected = fixtureIds.filter((id) => {
      const { group } = classifyLicense(id);
      return group === 'open' || group === 'cc';
    });
    expect([...CC_LICENSE_URIS].sort()).toEqual([...expected, ...KIM_CC_TERMS].sort());
    for (const uri of KIM_CC_TERMS) expect(['open', 'cc']).toContain(classifyLicense(uri).group);
  });

  it('never lists a value that classifies other/none on its own', () => {
    for (const uri of CC_LICENSE_URIS) expect(['open', 'cc']).toContain(classifyLicense(uri).group);
    expect(CC_LICENSE_URIS).not.toContain(KIM('noLicense'));
  });

  it('is a superset of OPEN_LICENSE_URIS', () => {
    for (const uri of OPEN_LICENSE_URIS) expect(CC_LICENSE_URIS).toContain(uri);
  });
});

describe('matchesLicenseFilter', () => {
  it.each([
    ['open', 'open', true],
    ['open', 'cc-any', true],
    ['open', 'any', true],
    ['cc', 'open', false],
    ['cc', 'cc-any', true],
    ['cc', 'any', true],
    ['other', 'open', false],
    ['other', 'cc-any', false],
    ['other', 'any', true],
    ['none', 'open', false],
    ['none', 'cc-any', false],
    ['none', 'any', true],
  ] as const)('group %s under filter %s -> %s', (group, filter, expected) => {
    expect(matchesLicenseFilter(group, filter)).toBe(expected);
  });
});

describe('accessLevelFor', () => {
  it.each([
    ['open', 'full'],
    ['cc', 'full'],
    ['other', 'metadata-only'],
    ['none', 'metadata-only'],
  ] as const)('%s -> %s', (group, level) => {
    expect(accessLevelFor(group)).toBe(level);
  });
});

describe('eventLicense', () => {
  const ev = (tags: string[][]): NostrEvent => ({
    id: 'x', pubkey: 'a'.repeat(64), created_at: 1, kind: 30142, tags, content: '', sig: 's',
  });

  it('reads the license:id tag and reports access level', () => {
    const uri = 'https://creativecommons.org/licenses/by/4.0/';
    expect(eventLicense(ev([['license:id', uri]]))).toEqual({
      group: 'open',
      license: { id: uri, label: 'CC BY 4.0' },
      accessLevel: 'full',
    });
  });

  it('treats a missing license:id tag as none / metadata-only', () => {
    expect(eventLicense(ev([['d', 'x']]))).toEqual({
      group: 'none',
      license: null,
      accessLevel: 'metadata-only',
    });
  });

  it('falls back to the plain license tag (amb-indexer parity: worker.go readLicenseTag)', () => {
    const uri = 'https://creativecommons.org/licenses/by/4.0/';
    expect(eventLicense(ev([['license', uri]]))).toEqual({
      group: 'open',
      license: { id: uri, label: 'CC BY 4.0' },
      accessLevel: 'full',
    });
  });

  it('prefers license:id over license when both are present', () => {
    const idUri = 'https://creativecommons.org/licenses/by/4.0/';
    const plainUri = 'https://creativecommons.org/licenses/by-nc/4.0/';
    expect(eventLicense(ev([['license', plainUri], ['license:id', idUri]]))).toEqual({
      group: 'open',
      license: { id: idUri, label: 'CC BY 4.0' },
      accessLevel: 'full',
    });
  });

  it('classifies over ALL license:id tags (LEHRE LADEN KIM attribution + shareAlike)', () => {
    expect(eventLicense(ev([['license:id', KIM('attribution')], ['license:id', KIM('shareAlike')]]))).toEqual({
      group: 'open',
      license: { id: KIM('attribution'), label: 'BY-SA (KIM)' },
      accessLevel: 'full',
    });
  });

  it('narrows a KIM event to cc when a nonCommercial tag is present', () => {
    expect(eventLicense(ev([['license:id', KIM('attribution')], ['license:id', KIM('nonCommercial')]]))).toEqual({
      group: 'cc',
      license: { id: KIM('attribution'), label: 'BY-NC (KIM)' },
      accessLevel: 'full',
    });
  });

  it('lets a later CC URI tag win over an earlier KIM tag', () => {
    expect(eventLicense(ev([['license:id', KIM('attribution')], ['license:id', BY_NC_4]])).license)
      .toEqual({ id: BY_NC_4, label: 'CC BY-NC 4.0' });
  });

  it('drops empty license:id tags and ignores the plain license tag when any license:id is set', () => {
    expect(eventLicense(ev([
      ['license:id', ' '], ['license:id', KIM('attribution')], ['license', BY_NC_4],
    ])).license).toEqual({ id: KIM('attribution'), label: 'BY (KIM)' });
  });

  it('marks KIM noLicense and the Urheberrecht marker metadata-only', () => {
    expect(eventLicense(ev([['license:id', KIM('noLicense')]])).accessLevel).toBe('metadata-only');
    expect(eventLicense(ev([['license:id', 'https://de.wikipedia.org/wiki/Urheberrecht_(Deutschland)']])).accessLevel)
      .toBe('metadata-only');
  });
});

describe('parseLicenseFilterMax', () => {
  it('defaults to any', () => {
    expect(parseLicenseFilterMax({})).toBe('any');
    expect(parseLicenseFilterMax({ LICENSE_FILTER_MAX: '' })).toBe('any');
  });

  it.each(['open', 'cc-any', 'any', ' CC-ANY '])('accepts LICENSE_FILTER_MAX=%s', (v) => {
    expect(parseLicenseFilterMax({ LICENSE_FILTER_MAX: v })).toBe(v.trim().toLowerCase());
  });

  it('maps legacy OPEN_LICENSES_ONLY=true to open and warns once', () => {
    const warn = vi.fn();
    expect(parseLicenseFilterMax({ OPEN_LICENSES_ONLY: 'true' }, warn)).toBe('open');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/OPEN_LICENSES_ONLY.*deprecated.*LICENSE_FILTER_MAX/);
  });

  it('maps legacy OPEN_LICENSES_ONLY=false to any and warns once', () => {
    const warn = vi.fn();
    expect(parseLicenseFilterMax({ OPEN_LICENSES_ONLY: 'false' }, warn)).toBe('any');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('lets LICENSE_FILTER_MAX win over the legacy variable, still warning once', () => {
    const warn = vi.fn();
    expect(parseLicenseFilterMax({ LICENSE_FILTER_MAX: 'cc-any', OPEN_LICENSES_ONLY: 'true' }, warn)).toBe('cc-any');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn without the legacy variable', () => {
    const warn = vi.fn();
    parseLicenseFilterMax({ LICENSE_FILTER_MAX: 'open' }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws on an invalid value', () => {
    expect(() => parseLicenseFilterMax({ LICENSE_FILTER_MAX: 'closed' })).toThrow(/LICENSE_FILTER_MAX/);
  });
});

describe('clampLicenseFilter', () => {
  it.each([
    ['any', 'open', 'open', true],
    ['cc-any', 'open', 'open', true],
    ['any', 'cc-any', 'cc-any', true],
    ['open', 'any', 'open', false],
    ['open', 'cc-any', 'open', false],
    ['cc-any', 'cc-any', 'cc-any', false],
    [undefined, 'cc-any', 'cc-any', false],
    [undefined, 'any', 'any', false],
  ] as const)('requested %s under max %s -> %s (clamped %s)', (requested, max, effective, clamped) => {
    expect(clampLicenseFilter(requested, max)).toEqual({ effective, clamped });
  });
});
