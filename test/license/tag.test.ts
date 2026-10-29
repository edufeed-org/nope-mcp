import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { licenseTagValue } from '../../src/license/tag.js';

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

  it('returns undefined when neither tag is present', () => {
    expect(licenseTagValue(ev([['d', 'x']]))).toBeUndefined();
  });
});
