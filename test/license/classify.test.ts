import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NostrEvent } from 'nostr-tools';
import {
  classifyLicense, accessLevelFor, matchesLicenseFilter, eventLicense, CC_LICENSE_URIS,
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

  it('classifies a non-CC URI as other with label unknown', () => {
    const uri = 'https://w3id.org/kim/license/attribution';
    expect(classifyLicense(uri)).toEqual({ group: 'other', license: { id: uri, label: 'unknown' } });
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

describe('CC_LICENSE_URIS', () => {
  it('is exactly the stored fixture variants that classify open or cc', () => {
    const expected = fixtureIds.filter((id) => {
      const { group } = classifyLicense(id);
      return group === 'open' || group === 'cc';
    });
    expect([...CC_LICENSE_URIS].sort()).toEqual(expected.sort());
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
});
