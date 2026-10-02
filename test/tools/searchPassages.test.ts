import { describe, it, expect, vi } from 'vitest';
import {
  runSearchPassages, sanitizeHintRelays, makeFetchSpellEvent, makeFetchContacts,
  MAX_HINT_RELAYS, CONTACTS_FALLBACK_RELAY,
} from '../../src/tools/searchPassages.js';
import { SPELL_KIND } from '../../src/spells/types.js';
import { RelayUnreachableError } from '../../src/relay/client.js';
import type { Event as NostrEvent, Filter } from 'nostr-tools';

const RELAY = 'wss://relay.edufeed.org';
const HIT = { chunk_id: 'c1', event_id: 'e1', event_coord: `30142:${'a'.repeat(64)}:d1`, chunk_idx: 0, snippet: 'Klimawandel …', score: 0.91 };

function deps(overrides: Partial<Parameters<typeof runSearchPassages>[0]> = {}) {
  return {
    queryContentEvents: vi.fn(async () => [] as NostrEvent[]),
    fetchSpellEvent: vi.fn(async () => ({ event: null as NostrEvent | null, triedRelays: [RELAY] })),
    fetchContacts: vi.fn(async () => [] as string[]),
    searchChunks: vi.fn(async () => ({ hits: [HIT], total: 1 })),
    relay: RELAY,
    ...overrides,
  };
}

describe('runSearchPassages', () => {
  it('inline kinds scope → passthrough → passages + canonical spell', async () => {
    const d = deps();
    const out = await runSearchPassages(d, { question: 'klimawandel', kinds: [30142] }, undefined);
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, {
      q: 'klimawandel', k: 30, filter: { kinds: [30142] }, alpha: 0.7,
    });
    expect(out.passages).toHaveLength(1);
    expect(out.scope.mode).toBe('passthrough');
    expect(out.scope.spell.tags).toContainEqual(['cmd', 'REQ']);
    expect(out.scope.spell.tags).toContainEqual(['k', '30142']);
  });

  it('over-fetches, then caps per document and truncates to limit', async () => {
    const coordA = `30142:${'a'.repeat(64)}:d1`, coordB = `30142:${'b'.repeat(64)}:d2`;
    const mk = (c: string, s: number, i: number) => ({ ...HIT, event_coord: c, chunk_idx: i, chunk_id: `${c}:${i}`, score: s });
    const d = deps({ searchChunks: vi.fn(async () => ({ hits: [mk(coordA, 0.7, 1), mk(coordA, 0.35, 2), mk(coordA, 0.3, 3), mk(coordB, 0.25, 0)], total: 4 })) });
    const out = await runSearchPassages(d, { question: 'q', kinds: [30142], limit: 3 }, undefined);
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({ k: 9, alpha: 0.7 }));
    expect(out.passages.map((p) => p.event_coord)).toEqual([coordA, coordA, coordB]);
  });

  it('published spell → fetch, parse, materialize, ground', async () => {
    const spellEvent: NostrEvent = {
      id: '1'.repeat(64), pubkey: '2'.repeat(64), created_at: 1, kind: 777, sig: 's',
      content: 'Klima im Unterricht',
      tags: [['cmd', 'REQ'], ['k', '30142'], ['search', 'klima']],
    };
    const content: NostrEvent = {
      id: '3'.repeat(64), pubkey: 'a'.repeat(64), created_at: 5, kind: 30142, sig: 's',
      content: '', tags: [['d', 'd1']],
    };
    const d = deps({
      fetchSpellEvent: vi.fn(async () => ({ event: spellEvent, triedRelays: [RELAY] })),
      queryContentEvents: vi.fn(async () => [content]),
    });
    const out = await runSearchPassages(d, { question: 'ursachen', spell: '1'.repeat(64) }, undefined);
    expect(d.queryContentEvents).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: [30142], search: 'klima', limit: 500 })
    );
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({
      filter: { event_coord: [`30142:${'a'.repeat(64)}:d1`] },
    }));
    expect(out.scope.spell_event_id).toBe('1'.repeat(64));
    expect(out.scope.events_in_scope).toBe(1);
  });

  it('rejects spell + inline scope together', async () => {
    const out = runSearchPassages(deps(), { question: 'q', spell: '1'.repeat(64), kinds: [1] }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'no_filter' });
  });

  it('spell not found → spell_not_found naming the relays', async () => {
    const d = deps({
      fetchSpellEvent: vi.fn(async () => ({
        event: null as NostrEvent | null,
        triedRelays: [RELAY, 'wss://hint.example'],
      })),
    });
    const out = runSearchPassages(d, { question: 'q', spell: '1'.repeat(64) }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'spell_not_found' });
    const err: Error = await out.catch((e) => e);
    expect(err.message).toContain(RELAY);
    expect(err.message).toContain('wss://hint.example');
  });

  it('$me comes from ContextVM clientPubkey when no me param', async () => {
    const d = deps();
    await runSearchPassages(
      d,
      { question: 'q', authors: ['$me'] },
      { authInfo: { clientPubkey: 'a'.repeat(64) } }
    );
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({
      filter: { pubkey: ['a'.repeat(64)] },
    }));
  });

  it('empty scope propagates as a structured error, never unscoped search', async () => {
    const d = deps({ queryContentEvents: vi.fn(async () => []) });
    const out = runSearchPassages(d, { question: 'q', search: 'nichts' }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'empty_scope' });
    expect(d.searchChunks).not.toHaveBeenCalled();
  });

  it('a malformed me param never throws a raw bech32 decode error — rejects as me_unresolvable', async () => {
    const out = runSearchPassages(deps(), { question: 'q', me: 'not-bech32!!', kinds: [1] }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'me_unresolvable' });
  });

  it('a malformed spell ref never throws a raw bech32 decode error — rejects as spell_not_found', async () => {
    const out = runSearchPassages(deps(), { question: 'q', spell: 'not-bech32!!' }, undefined);
    await expect(out).rejects.toMatchObject({ code: 'spell_not_found' });
  });

  it('a tag param with an empty values array is treated as absent, not a vacuous filter', async () => {
    const d = deps();
    const out = runSearchPassages(
      d,
      { question: 'q', tag: { letter: 'h', values: [] } },
      undefined
    );
    await expect(out).rejects.toMatchObject({ code: 'no_filter' });
  });
});

describe('sanitizeHintRelays', () => {
  it('keeps only wss:// URLs', () => {
    expect(sanitizeHintRelays([
      'wss://good.example', 'ws://insecure.example', 'https://not-a-relay.example', 'not a url',
    ])).toEqual(['wss://good.example']);
  });

  it('caps at MAX_HINT_RELAYS', () => {
    const hints = Array.from({ length: 10 }, (_, i) => `wss://r${i}.example`);
    const safe = sanitizeHintRelays(hints);
    expect(safe.length).toBe(MAX_HINT_RELAYS);
    expect(safe).toEqual(hints.slice(0, MAX_HINT_RELAYS));
  });

  it('returns empty when nothing survives', () => {
    expect(sanitizeHintRelays(['http://evil.example', 'ftp://also-no.example'])).toEqual([]);
  });
});

function fakeClient(events: NostrEvent[], relays: string[] = [RELAY]) {
  return {
    queryEvents: vi.fn(async (_f: Filter) => events),
    getRelays: () => relays,
  };
}

describe('makeFetchSpellEvent', () => {
  const spellEvent: NostrEvent = {
    id: '1'.repeat(64), pubkey: '2'.repeat(64), created_at: 1, kind: SPELL_KIND, sig: 's',
    content: '', tags: [['cmd', 'REQ'], ['k', '1']],
  };

  it('returns the event from the spell relays without ever building a hint client', async () => {
    const spellClient = fakeClient([spellEvent]);
    const makeHintClient = vi.fn();
    const fetchSpellEvent = makeFetchSpellEvent(spellClient, makeHintClient);
    const result = await fetchSpellEvent('1'.repeat(64), ['wss://hint.example']);
    expect(result).toEqual({ event: spellEvent, triedRelays: [RELAY] });
    expect(makeHintClient).not.toHaveBeenCalled();
  });

  it('falls back to sanitized hints, closes the throwaway client, and reports both in triedRelays', async () => {
    const spellClient = fakeClient([]);
    const hintClient = { queryEvents: vi.fn(async () => [spellEvent]), close: vi.fn() };
    const makeHintClient = vi.fn(() => hintClient);
    const fetchSpellEvent = makeFetchSpellEvent(spellClient, makeHintClient);
    const result = await fetchSpellEvent(
      '1'.repeat(64),
      ['wss://good.example', 'http://evil.example']
    );
    expect(makeHintClient).toHaveBeenCalledWith(['wss://good.example']);
    expect(hintClient.close).toHaveBeenCalled();
    expect(result).toEqual({ event: spellEvent, triedRelays: [RELAY, 'wss://good.example'] });
  });

  it('skips the hint fallback entirely when no hints survive sanitization', async () => {
    const spellClient = fakeClient([]);
    const makeHintClient = vi.fn();
    const fetchSpellEvent = makeFetchSpellEvent(spellClient, makeHintClient);
    const result = await fetchSpellEvent('1'.repeat(64), ['http://evil.example']);
    expect(makeHintClient).not.toHaveBeenCalled();
    expect(result).toEqual({ event: null, triedRelays: [RELAY] });
  });
});

describe('makeFetchContacts', () => {
  const contactsEvent = (created_at: number, ...pubkeys: string[]): NostrEvent => ({
    id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at, kind: 3, sig: 's',
    content: '', tags: pubkeys.map((p) => ['p', p]),
  });

  it('uses the primary spell-relays result without touching the fallback', async () => {
    const ev = contactsEvent(5, 'c'.repeat(64));
    const spellClient = { queryEvents: vi.fn(async () => [ev]) };
    const makeFallbackClient = vi.fn();
    const fetchContacts = makeFetchContacts(spellClient, makeFallbackClient);
    const result = await fetchContacts('d'.repeat(64));
    expect(result).toEqual(['c'.repeat(64)]);
    expect(makeFallbackClient).not.toHaveBeenCalled();
  });

  it('falls back to purplepag.es when the primary yields no kind-3', async () => {
    const ev = contactsEvent(5, 'e'.repeat(64));
    const spellClient = { queryEvents: vi.fn(async () => [] as NostrEvent[]) };
    const fallbackClient = { queryEvents: vi.fn(async () => [ev]), close: vi.fn() };
    const makeFallbackClient = vi.fn(() => fallbackClient);
    const fetchContacts = makeFetchContacts(spellClient, makeFallbackClient);
    const result = await fetchContacts('d'.repeat(64));
    expect(makeFallbackClient).toHaveBeenCalledWith([CONTACTS_FALLBACK_RELAY]);
    expect(fallbackClient.close).toHaveBeenCalled();
    expect(result).toEqual(['e'.repeat(64)]);
  });

  it('returns empty when neither source has a kind-3', async () => {
    const spellClient = { queryEvents: vi.fn(async () => [] as NostrEvent[]) };
    const fallbackClient = { queryEvents: vi.fn(async () => [] as NostrEvent[]), close: vi.fn() };
    const fetchContacts = makeFetchContacts(spellClient, () => fallbackClient);
    const result = await fetchContacts('d'.repeat(64));
    expect(result).toEqual([]);
  });
});

describe('relay outage vs empty scope', () => {
  it('maps RelayUnreachableError from the scope query to relay_unreachable naming the relay', async () => {
    const d = deps({
      queryContentEvents: vi.fn(async () => { throw new RelayUnreachableError([RELAY], 'query timed out before EOSE'); }),
    });
    await expect(runSearchPassages(d, { question: 'x', kinds: [30142], search: 'klima' }, undefined))
      .rejects.toMatchObject({
        code: 'relay_unreachable',
        message: expect.stringContaining(RELAY),
      });
  });

  it('a reachable relay with zero matches still reports empty_scope', async () => {
    const d = deps({ queryContentEvents: vi.fn(async () => []) });
    await expect(runSearchPassages(d, { question: 'x', kinds: [30142], search: 'klima' }, undefined))
      .rejects.toMatchObject({ code: 'empty_scope' });
  });
});

describe('runSearchPassages with openLicensesOnly', () => {
  const res = (d: string) => `30142:${'a'.repeat(64)}:${d}`;
  const art = `30023:${'b'.repeat(64)}:art`;
  const hit = (coord: string, score: number, extra: Record<string, unknown> = {}) =>
    ({ ...HIT, chunk_id: `${coord}:0`, event_coord: coord, score, ...extra });

  it('over-fetches twice as much and adds no license filter to the indexer query', async () => {
    const d = deps();
    await runSearchPassages(d, { question: 'q', kinds: [30142], openLicensesOnly: true }, undefined);
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, {
      q: 'q', k: 60, filter: { kinds: [30142] }, alpha: 0.7,
    });
  });

  it('drops license-gated resource passages, keeps other kinds, and floors on the open hits', async () => {
    const d = deps({
      searchChunks: vi.fn(async () => ({
        total: 5,
        hits: [
          hit(res('gated'), 1.0), // no text → indexer license gate said not open
          hit(res('nc'), 0.9, { text: 'volltext', amb: { license: 'https://creativecommons.org/licenses/by-nc/4.0/' } }),
          hit(art, 0.2), // article: no license concept, snippet-only is fine
          hit(res('open'), 0.15, { text: 'volltext', amb: { license: 'https://creativecommons.org/licenses/by-sa/4.0/' } }),
          hit(res('open-nocache'), 0.09, { text: 'volltext' }), // below 0.1 × the dropped top hit
        ],
      })),
    });
    const out = await runSearchPassages(d, { question: 'q', kinds: [30142, 30023], openLicensesOnly: true }, undefined);
    expect(out.passages.map((p) => p.event_coord)).toEqual([art, res('open'), res('open-nocache')]);
  });

  it('keeps license-gated passages when the switch is off', async () => {
    const d = deps({ searchChunks: vi.fn(async () => ({ total: 1, hits: [hit(res('gated'), 1.0)] })) });
    const out = await runSearchPassages(d, { question: 'q', kinds: [30142], openLicensesOnly: false }, undefined);
    expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({ k: 30 }));
    expect(out.passages).toHaveLength(1);
  });
});
