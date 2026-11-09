import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools';
import { setEventRelay, getEventRelay, makeEventCollector } from '../../src/relay/provenance.js';

function evt(id: string, kind: number, created_at: number, tags: string[][] = [], content = ''): NostrEvent {
  return { id, pubkey: 'a'.repeat(64), created_at, kind, tags, content, sig: 's' };
}

describe('relay provenance', () => {
  it('round-trips the relay of an event object', () => {
    const e = evt('x', 1, 1);
    expect(getEventRelay(e)).toBeUndefined();
    setEventRelay(e, 'wss://a.example');
    expect(getEventRelay(e)).toBe('wss://a.example');
    expect(getEventRelay({ ...e })).toBeUndefined(); // keyed by object, not id
  });

  it('keeps the newer addressable event (older arrives first)', () => {
    const c = makeEventCollector();
    c.onevent(evt('old', 30023, 100, [['d', 'x']], 'old'), 'wss://a');
    c.onevent(evt('new', 30023, 200, [['d', 'x']], 'new'), 'wss://b');
    expect(c.events).toHaveLength(1);
    expect(c.events[0].content).toBe('new');
    expect(getEventRelay(c.events[0])).toBe('wss://b');
  });

  it('keeps the newer addressable event (newer arrives first)', () => {
    const c = makeEventCollector();
    c.onevent(evt('a1', 1, 0), 'wss://a');
    c.onevent(evt('new', 30023, 200, [['d', 'x']], 'new'), 'wss://a');
    c.onevent(evt('old', 30023, 100, [['d', 'x']], 'old'), 'wss://b');
    expect(c.events.map((e) => e.id)).toEqual(['a1', 'new']);
    expect(getEventRelay(c.events[1])).toBe('wss://a');
  });

  it('replaces in place, keeping the first-seen position', () => {
    const c = makeEventCollector();
    c.onevent(evt('old', 30023, 100, [['d', 'x']]), 'wss://a');
    c.onevent(evt('other', 30023, 100, [['d', 'y']]), 'wss://a');
    c.onevent(evt('new', 30023, 200, [['d', 'x']]), 'wss://b');
    expect(c.events.map((e) => e.id)).toEqual(['new', 'other']);
  });

  it('dedupes regular kinds by id, first relay wins', () => {
    const c = makeEventCollector();
    c.onevent(evt('r1', 1, 1), 'wss://a');
    c.onevent(evt('r1', 1, 1), 'wss://b');
    c.onevent(evt('r2', 1, 1), 'wss://b');
    expect(c.events.map((e) => e.id)).toEqual(['r1', 'r2']);
    expect(getEventRelay(c.events[0])).toBe('wss://a');
  });

  it('stores the relay URL as passed (the configured spelling)', () => {
    const c = makeEventCollector();
    c.onevent(evt('n1', 1, 1), 'wss://a.example');
    expect(getEventRelay(c.events[0])).toBe('wss://a.example');
  });

  it('keeps the newest replaceable event (kinds 0, 3, 10000–19999) per kind:pubkey', () => {
    const c = makeEventCollector();
    c.onevent(evt('p-old', 0, 100), 'wss://a');
    c.onevent(evt('c-new', 10222, 200), 'wss://a');
    c.onevent(evt('p-new', 0, 200), 'wss://b');
    c.onevent(evt('c-old', 10222, 100), 'wss://b');
    expect(c.events.map((e) => e.id)).toEqual(['p-new', 'c-new']);
  });
});
