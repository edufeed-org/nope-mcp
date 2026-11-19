import { describe, it, expect } from 'vitest';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { secretKeyHex } from '../../src/utils/secretKey.js';

describe('secretKeyHex', () => {
  const bytes = generateSecretKey();
  const hex = Buffer.from(bytes).toString('hex');
  it('decodes an nsec', () => expect(secretKeyHex(nip19.nsecEncode(bytes))).toBe(hex));
  it('passes a hex key through, lower-cased and trimmed', () => expect(secretKeyHex(` ${hex.toUpperCase()}\n`)).toBe(hex));
  it('rejects anything else without echoing it', () => {
    expect(() => secretKeyHex('not-a-key')).toThrow(/64 hex characters or an nsec/);
    expect(() => secretKeyHex(nip19.npubEncode(hex))).toThrow(/64 hex characters or an nsec/);
    expect(() => secretKeyHex('not-a-key')).not.toThrow(/not-a-key/);
  });
});
