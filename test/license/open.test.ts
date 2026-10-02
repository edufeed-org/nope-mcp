import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NostrEvent } from 'nostr-tools';
import {
  isOpenLicense, normalizeLicenseUri, OPEN_LICENSE_URIS, eventHasOpenLicense, parseOpenLicensesOnly,
} from '../../src/license/open.js';

interface Fixture { licenseIds: { id: string; count: number }[] }
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/license-ids.json', import.meta.url), 'utf8')
) as Fixture;
const fixtureIds = fixture.licenseIds.map((l) => l.id);

/** The fixture URIs that ARE open (CC0, PDM, CC BY, CC BY-SA in any version/port/form). */
const EXPECTED_OPEN = new Set([
  'https://creativecommons.org/licenses/by-sa/4.0/',
  'https://creativecommons.org/licenses/by/4.0/',
  'https://creativecommons.org/licenses/by-sa/3.0/',
  'https://creativecommons.org/publicdomain/zero/1.0/',
  'http://creativecommons.org/licenses/by-sa/4.0/legalcode.de',
  'https://creativecommons.org/licenses/by-sa/3.0/de/',
  'https://creativecommons.org/licenses/by/3.0/',
  'https://creativecommons.org/publicdomain/mark/1.0/',
  'http://creativecommons.org/licenses/by/4.0/legalcode.de',
  'https://creativecommons.org/licenses/by-sa/3.0/us/',
  'http://creativecommons.org/licenses/by-sa/4.0/',
  'http://creativecommons.org/licenses/by/4.0/',
  'https://creativecommons.org/licenses/by-sa/2.5/',
  'https://creativecommons.org/licenses/by-sa/3.0/de/deed.de',
  'https://creativecommons.org/licenses/by/3.0/de/',
  'https://creativecommons.org/licenses/by/4.0/deed.de',
  'https://creativecommons.org/licenses/by-sa/2.0/',
  'https://creativecommons.org/licenses/by/2.0/',
  'https://creativecommons.org/licenses/by-sa/2.0/de/',
  'https://creativecommons.org/licenses/by/2.5/',
  'https://creativecommons.org/licenses/by-sa/4.0/deed.de',
]);

describe('license fixture', () => {
  it('holds a non-trivial inventory of stored license:id values', () => {
    expect(fixtureIds.length).toBeGreaterThan(30);
    for (const id of EXPECTED_OPEN) expect(fixtureIds).toContain(id);
  });
});

describe('isOpenLicense', () => {
  it.each(fixtureIds)('classifies stored value %s', (id) => {
    expect(isOpenLicense(id)).toBe(EXPECTED_OPEN.has(id));
  });

  it.each([
    'https://creativecommons.org/licenses/by-nc/4.0/',
    'https://creativecommons.org/licenses/by-nd/4.0/',
    'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    'https://creativecommons.org/licenses/by-nc-nd/3.0/de/',
    'https://de.wikipedia.org/wiki/Urheberrecht_(Deutschland)',
    'https://w3id.org/kim/license/attribution',
    'https://www.apache.org/licenses/LICENSE-2.0',
    'https://example.org/creativecommons.org/licenses/by/4.0/',
    'https://creativecommons.org/licenses/by/4.0/extra/path/',
    '',
    '   ',
    undefined,
  ])('rejects %s', (id) => {
    expect(isOpenLicense(id)).toBe(false);
  });

  it.each([
    'HTTPS://CreativeCommons.org/licenses/BY/4.0',
    'https://creativecommons.org/licenses/by-sa/4.0/legalcode',
    'https://creativecommons.org/licenses/by/4.0/deed.en',
    'http://creativecommons.org/publicdomain/zero/1.0/legalcode.de',
    ' https://creativecommons.org/licenses/by/4.0/ ',
  ])('accepts unseen open variant %s', (id) => {
    expect(isOpenLicense(id)).toBe(true);
  });
});

describe('normalizeLicenseUri', () => {
  it('upgrades to https, lowercases, strips legalcode/deed and the trailing slash', () => {
    expect(normalizeLicenseUri('http://creativecommons.org/licenses/by-sa/4.0/legalcode.de'))
      .toBe('https://creativecommons.org/licenses/by-sa/4.0');
    expect(normalizeLicenseUri('https://creativecommons.org/licenses/by/4.0/deed.de'))
      .toBe('https://creativecommons.org/licenses/by/4.0');
  });
});

describe('OPEN_LICENSE_URIS', () => {
  it('is exactly the stored fixture variants that classify open', () => {
    expect([...OPEN_LICENSE_URIS].sort()).toEqual(fixtureIds.filter((id) => isOpenLicense(id)).sort());
  });

  it('contains no value the relay tokenizer would split or unquote', () => {
    for (const uri of OPEN_LICENSE_URIS) expect(uri).not.toMatch(/[\s"]/);
  });
});

describe('eventHasOpenLicense', () => {
  const ev = (tags: string[][]): NostrEvent => ({
    id: 'x', pubkey: 'a'.repeat(64), created_at: 1, kind: 30142, tags, content: '', sig: 's',
  });
  it('reads the license:id tag', () => {
    expect(eventHasOpenLicense(ev([['license:id', 'https://creativecommons.org/licenses/by/4.0/']]))).toBe(true);
    expect(eventHasOpenLicense(ev([['license:id', 'https://creativecommons.org/licenses/by-nc/4.0/']]))).toBe(false);
  });
  it('treats a missing license as not open', () => {
    expect(eventHasOpenLicense(ev([['d', 'x']]))).toBe(false);
  });
});

describe('parseOpenLicensesOnly', () => {
  it('defaults to true', () => {
    expect(parseOpenLicensesOnly(undefined)).toBe(true);
    expect(parseOpenLicensesOnly('')).toBe(true);
    expect(parseOpenLicensesOnly('true')).toBe(true);
    expect(parseOpenLicensesOnly('1')).toBe(true);
  });
  it.each(['false', 'FALSE', '0', 'no', 'off', ' false '])('is false for %s', (v) => {
    expect(parseOpenLicensesOnly(v)).toBe(false);
  });
});
