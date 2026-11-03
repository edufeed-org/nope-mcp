import { describe, it, expect } from 'vitest';
import { isStandardTagFilter } from '../../src/relay/client.js';

// The client re-applies "standard" tag filters locally through nostr-tools'
// matchFilters, which is an EXACT match. `#g` is answered by the calendar
// relay as a geohash PREFIX (NIP-52 relay extension), so an event tagged
// `g=u33dc0` for a `#g=u33d` query would pass the relay and be discarded
// locally. It must therefore be treated as relay-only, like `#start_after`.
describe('isStandardTagFilter', () => {
  it('keeps exact-match tags local', () => {
    for (const k of ['#a', '#p', '#e', '#d', '#t', '#r']) expect(isStandardTagFilter(k)).toBe(true);
  });
  it('treats #g as relay-only because the relay matches it as a prefix', () => {
    expect(isStandardTagFilter('#g')).toBe(false);
  });
  it('treats calendar range params as relay-only', () => {
    expect(isStandardTagFilter('#start_after')).toBe(false);
  });
});
