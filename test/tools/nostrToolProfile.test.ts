import { describe, it, expect } from 'vitest';
import { nostrToolProfile } from '../../src/tools/index.js';

describe('nostrToolProfile', () => {
  it('registers read tools only when CVM_READ_ONLY is true', () => {
    expect(nostrToolProfile({ CVM_READ_ONLY: 'true' })).toEqual({ read: true, extract: false, write: false });
  });
  it('keeps the full toolset otherwise', () => {
    for (const env of [{}, { CVM_READ_ONLY: 'false' }, { CVM_READ_ONLY: '' }]) {
      expect(nostrToolProfile(env)).toEqual({ read: true, extract: true, write: true });
    }
  });
});
