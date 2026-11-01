import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NostrEvent } from 'nostr-tools';
import {
  isOpenLicense, normalizeLicenseUri, OPEN_LICENSE_URIS, eventHasOpenLicense,
} from '../../src/license/open.js';

interface Fixture { licenseIds: { id: string; count: number }[] }
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/license-ids.json', import.meta.url), 'utf8')
) as Fixture;
const fixtureIds = fixture.licenseIds.map((l) => l.id);

/**
 * The fixture URIs that ARE open: CC0, PDM, CC BY, CC BY-SA in any
 * version/port/form, the KIM attribution concept, and the free software /
 * documentation licences (2026-11-01 contract).
 */
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
  'https://w3id.org/kim/license/attribution',
  'https://www.apache.org/licenses/LICENSE-2.0',
  'https://www.gnu.org/licenses/gpl-3.0',
  'https://www.gnu.org/licenses/gpl-3.0-standalone.html',
  'https://www.gnu.org/licenses/fdl-1.3.html',
  'https://opensource.org/licenses/MIT',
  'https://opensource.org/license/mit',
  'https://www.gnu.org/licenses/gpl-3.0.html',
  'https://www.gnu.org/licenses/fdl-1.3',
  'https://www.gnu.org/licenses/gpl-3.0.txt',
  'http://www.gnu.org/licenses/gpl-3.0',
  'https://opensource.org/license/bsd-3-clause',
]);

/** KIM terms not (yet) in the fixture that classify open on their own. */
const KIM_OPEN_TERMS = [
  'https://w3id.org/kim/license/shareAlike',
  'https://w3id.org/kim/license/publicDomain',
];

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
    'https://w3id.org/kim/license/nonCommercial',
    'https://w3id.org/kim/license/noLicense',
    'https://w3id.org/kim/license/unknownTerm',
    'https://www.gnu.org/licenses/gpl-faq',
    'https://example.org/licenses/gpl-3.0',
    'https://example.org/creativecommons.org/licenses/by/4.0/',
    'https://creativecommons.org/licenses/by/4.0/extra/path/',
    'https://creativecommons.org/licenses/by/4.0/nc',
    'https://creativecommons.org/licenses/by/4.0/nd/',
    'https://creativecommons.org/licenses/by-sa/3.0/nc/',
    'https://creativecommons.org/licenses/by/4.0/sa',
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
    'https://w3id.org/kim/license/shareAlike',
    'http://w3id.org/kim/license/PUBLICDOMAIN/',
    'https://www.gnu.org/licenses/lgpl-2.1.html',
    'https://gnu.org/licenses/agpl-3.0.txt',
    'https://spdx.org/licenses/GPL-3.0-or-later.html',
    'https://opensource.org/licenses/BSD-2-Clause',
  ])('accepts unseen open variant %s', (id) => {
    expect(isOpenLicense(id)).toBe(true);
  });
});

describe('normalizeLicenseUri', () => {
  it('strips .html/.txt/-standalone.html only on the free-licence hosts', () => {
    expect(normalizeLicenseUri('https://www.gnu.org/licenses/gpl-3.0-standalone.html'))
      .toBe('https://www.gnu.org/licenses/gpl-3.0');
    expect(normalizeLicenseUri('https://www.gnu.org/licenses/gpl-3.0.txt'))
      .toBe('https://www.gnu.org/licenses/gpl-3.0');
    expect(normalizeLicenseUri('https://example.org/license.html'))
      .toBe('https://example.org/license.html');
  });

  it('upgrades to https, lowercases, strips legalcode/deed and the trailing slash', () => {
    expect(normalizeLicenseUri('http://creativecommons.org/licenses/by-sa/4.0/legalcode.de'))
      .toBe('https://creativecommons.org/licenses/by-sa/4.0');
    expect(normalizeLicenseUri('https://creativecommons.org/licenses/by/4.0/deed.de'))
      .toBe('https://creativecommons.org/licenses/by/4.0');
  });
});

describe('OPEN_LICENSE_URIS', () => {
  it('is exactly the stored fixture variants that classify open, plus the open KIM terms', () => {
    expect([...OPEN_LICENSE_URIS].sort()).toEqual(
      [...fixtureIds.filter((id) => isOpenLicense(id)), ...KIM_OPEN_TERMS].sort()
    );
    for (const uri of KIM_OPEN_TERMS) expect(isOpenLicense(uri)).toBe(true);
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

  it('falls back to the plain license tag (amb-indexer parity: worker.go readLicenseTag)', () => {
    expect(eventHasOpenLicense(ev([['license', 'https://creativecommons.org/licenses/by/4.0/']]))).toBe(true);
    expect(eventHasOpenLicense(ev([['license', 'https://creativecommons.org/licenses/by-nc/4.0/']]))).toBe(false);
  });

  it('prefers license:id over license when both are present', () => {
    expect(eventHasOpenLicense(ev([
      ['license', 'https://creativecommons.org/licenses/by-nc/4.0/'],
      ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
    ]))).toBe(true);
  });

  it('classifies over ALL license:id tags', () => {
    const kim = (t: string) => ['license:id', `https://w3id.org/kim/license/${t}`];
    expect(eventHasOpenLicense(ev([kim('attribution'), kim('shareAlike')]))).toBe(true);
    expect(eventHasOpenLicense(ev([kim('attribution')]))).toBe(true);
    expect(eventHasOpenLicense(ev([kim('attribution'), kim('nonCommercial')]))).toBe(false);
    expect(eventHasOpenLicense(ev([kim('shareAlike'), kim('noDerivatives')]))).toBe(false);
    expect(eventHasOpenLicense(ev([['license:id', 'https://www.gnu.org/licenses/gpl-3.0']]))).toBe(true);
  });
});
