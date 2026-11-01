import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { licenseTagValue, licenseTagValues } from '../../src/license/tag.js';

const ev = (tags: string[][]): NostrEvent => ({
  id: 'x', pubkey: 'a'.repeat(64), created_at: 1, kind: 30142, tags, content: '', sig: 's',
});

describe('licenseTagValue', () => {
  it('reads license:id when present', () => {
    const uri = 'https://creativecommons.org/licenses/by/4.0/';
    expect(licenseTagValue(ev([['license:id', uri]]))).toBe(uri);
  });

  it('falls back to the plain license tag (amb-indexer parity: worker.go readLicenseTag)', () => {
    const uri = 'https://creativecommons.org/licenses/by/4.0/';
    expect(licenseTagValue(ev([['license', uri]]))).toBe(uri);
  });

  it('prefers license:id over license when both are present', () => {
    const idUri = 'https://creativecommons.org/licenses/by/4.0/';
    const plainUri = 'https://creativecommons.org/licenses/by-nc/4.0/';
    expect(licenseTagValue(ev([['license', plainUri], ['license:id', idUri]]))).toBe(idUri);
  });

  it('falls back to license when license:id is present but empty', () => {
    const uri = 'https://creativecommons.org/licenses/by/4.0/';
    expect(licenseTagValue(ev([['license:id', ''], ['license', uri]]))).toBe(uri);
  });

  it('falls back to license when license:id is whitespace-only (Go trims too)', () => {
    const uri = 'https://creativecommons.org/licenses/by/4.0/';
    expect(licenseTagValue(ev([['license:id', '  '], ['license', uri]]))).toBe(uri);
  });

  it('trims the chosen value', () => {
    const uri = 'https://creativecommons.org/licenses/by/4.0/';
    expect(licenseTagValue(ev([['license:id', ` ${uri} `]]))).toBe(uri);
    expect(licenseTagValue(ev([['license', ` ${uri}\n`]]))).toBe(uri);
  });

  it('returns undefined when neither tag is present', () => {
    expect(licenseTagValue(ev([['d', 'x']]))).toBeUndefined();
  });
});

describe('licenseTagValues', () => {
  const A = 'https://w3id.org/kim/license/attribution';
  const SA = 'https://w3id.org/kim/license/shareAlike';
  const plain = 'https://creativecommons.org/licenses/by/4.0/';

  it('returns every license:id value in tag order, trimmed, empty ones dropped', () => {
    expect(licenseTagValues(ev([['license:id', ` ${A}`], ['d', 'x'], ['license:id', ''], ['license:id', SA]])))
      .toEqual([A, SA]);
  });

  it('ignores the plain license tag when any license:id is set', () => {
    expect(licenseTagValues(ev([['license', plain], ['license:id', A]]))).toEqual([A]);
  });

  it('falls back to the single plain license tag', () => {
    expect(licenseTagValues(ev([['license:id', '  '], ['license', plain]]))).toEqual([plain]);
    expect(licenseTagValues(ev([['d', 'x']]))).toEqual([]);
  });
});
