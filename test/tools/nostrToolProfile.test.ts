import { describe, it, expect } from 'vitest';
import { nostrToolProfile } from '../../src/tools/index.js';

describe('nostrToolProfile', () => {
  it('registers read tools only by default', () => {
    for (const env of [{}, { CVM_READ_ONLY: 'true' }, { CVM_READ_ONLY: '' }]) {
      expect(nostrToolProfile(env)).toEqual({ read: true, extract: false, write: false });
    }
  });
  it('exposes the full toolset only when CVM_READ_ONLY is false', () => {
    expect(nostrToolProfile({ CVM_READ_ONLY: 'false' })).toEqual({ read: true, extract: true, write: true });
  });
});
