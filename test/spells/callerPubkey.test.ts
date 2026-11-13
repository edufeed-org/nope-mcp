import { describe, it, expect } from 'vitest';
import { getSessionPubkey } from '../../src/tools/signer.js';

describe('getSessionPubkey', () => {
  it('returns null when no signer session exists for the caller', () => {
    expect(getSessionPubkey({ http: { authInfo: { clientPubkey: 'f'.repeat(64) } } })).toBeNull();
    expect(getSessionPubkey(undefined)).toBeNull();
  });
});
