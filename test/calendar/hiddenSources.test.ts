import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
  parseHiddenSourceEntries,
  partitionHiddenCalendarSources,
} from '../../src/calendar/hiddenSources.js';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

describe('parseHiddenSourceEntries', () => {
  it('accepts hex pubkeys, npubs and kind-30000 naddrs, ignoring junk', () => {
    const npubB = nip19.npubEncode(HEX_B);
    const naddr = nip19.naddrEncode({ kind: 30000, pubkey: HEX_A, identifier: 'mirrors' });
    const parsed = parseHiddenSourceEntries(`${HEX_A}, ${npubB},${naddr},not-a-key,`);
    expect(parsed.pubkeys).toEqual([HEX_A, HEX_B]);
    expect(parsed.naddrs).toEqual([naddr]);
  });

  it('returns empty lists for an unset variable', () => {
    expect(parseHiddenSourceEntries(undefined)).toEqual({ pubkeys: [], naddrs: [] });
  });
});

describe('partitionHiddenCalendarSources', () => {
  const hidden = new Set([HEX_A]);
  const events = [
    { nostr: { pubkey: HEX_A } },
    { nostr: { pubkey: HEX_B } },
    { nostr: { pubkey: HEX_A } },
  ];

  it('drops hidden sources by default and reports how many were hidden', () => {
    const { shown, hidden: n } = partitionHiddenCalendarSources(events, hidden);
    expect(shown).toEqual([{ nostr: { pubkey: HEX_B } }]);
    expect(n).toBe(2);
  });

  it('keeps everything with showHidden but still counts', () => {
    const { shown, hidden: n } = partitionHiddenCalendarSources(events, hidden, { showHidden: true });
    expect(shown).toHaveLength(3);
    expect(n).toBe(2);
  });

  it('is a no-op with an empty hidden set', () => {
    const { shown, hidden: n } = partitionHiddenCalendarSources(events, new Set());
    expect(shown).toHaveLength(3);
    expect(n).toBe(0);
  });
});
