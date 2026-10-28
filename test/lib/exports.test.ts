import { describe, it, expect } from 'vitest';
import * as lib from '../../src/lib/index.js';

describe('library entry point', () => {
  it('exports the document and PDF extractors so SvelteKit callers can enable them', () => {
    expect(typeof lib.extractDocument).toBe('function');
    expect(typeof lib.extractPdfText).toBe('function');
  });
});
