import { describe, it, expect } from 'vitest';
import { tokenize, lexicalScore, rankResults } from '../../src/content/rank.js';

describe('tokenize', () => {
  it('splits on punctuation and lowercases', () => {
    expect(tokenize('Statistik-Vorkurs')).toEqual(['statistik', 'vorkurs']);
  });
  it('folds umlauts and ß', () => {
    expect(tokenize('Übungen größer Äpfel')).toEqual(['uebungen', 'groesser', 'aepfel']);
  });
  it('composes decomposed umlauts before folding', () => {
    expect(tokenize('Übung'.normalize('NFD'))).toEqual(['uebung']);
    expect(tokenize('Mu\u0308ller')).toEqual(['mueller']);
  });
  it('drops short tokens and stopwords', () => {
    expect(tokenize('Die Mathe in der Schule and the it')).toEqual(['mathe', 'schule']);
  });
  it('keeps 2-char all-caps acronyms', () => {
    expect(tokenize('KI und VR in der IT, ab 2D')).toEqual(['ki', 'vr', 'it', '2d']);
    expect(tokenize('Ki ab')).toEqual([]);
  });
  it('returns no tokens for non-strings', () => {
    expect(tokenize(42)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe('lexicalScore', () => {
  it('title match counts 1, description/keyword 0.5', () => {
    expect(lexicalScore('Statistik Vorkurs', { title: 'Vorkurs' })).toBe(0.5);
    expect(lexicalScore('Statistik Vorkurs', { title: 'Vorkurs', description: 'Statistik' })).toBe(0.75);
    expect(lexicalScore('Statistik Vorkurs', { keywords: ['statistik'] })).toBe(0.25);
    expect(lexicalScore('Statistik Vorkurs', { title: 'Statistik Vorkurs' })).toBe(1);
  });
  it('counts unique query tokens once', () => {
    expect(lexicalScore('Vorkurs Vorkurs', { title: 'Vorkurs' })).toBe(1);
  });
  it('counts a 6-char prefix match of long tokens half', () => {
    expect(lexicalScore('Prüfungen', { title: 'Kapitel 1: Prüfung' })).toBe(0.5);
    expect(lexicalScore('Unterrichtsentwürfe', { title: 'Unterrichtsentwurf Tiefsee' })).toBe(0.5);
    expect(lexicalScore('Prüfungen', { description: 'Prüfung' })).toBe(0.25);
    expect(lexicalScore('Prüfungen', { title: 'Prüfungen' })).toBeGreaterThan(
      lexicalScore('Prüfungen', { title: 'Prüfung' })
    );
    expect(lexicalScore('Mathe', { title: 'Mathematik' })).toBe(0); // short tokens: exact only
  });
  it('is 0 for a query without tokens', () => {
    expect(lexicalScore('der die', { title: 'der' })).toBe(0);
  });
});

describe('rankResults', () => {
  it('ranks the exact title above a higher-snippet unrelated hit (Review Focus 2)', () => {
    const items = [
      { title: 'Cookie Policy (EU)', score: 0.7 },
      { title: 'Vorkurs Mathematik "11 Stochastik"', description: '… Statistik' },
    ];
    const out = rankResults(items, 'Statistik Vorkurs', 20);
    expect(out.map((i) => i.title)).toEqual(['Vorkurs Mathematik "11 Stochastik"', 'Cookie Policy (EU)']);
    expect(out[0].lexical).toBe(0.75);
    expect(out[1].lexical).toBe(0);
  });
  it('sorts zero-match items last instead of dropping them', () => {
    const out = rankResults([{ title: 'Kekse' }, { title: 'Vorkurs' }], 'Vorkurs', 20);
    expect(out.map((i) => i.title)).toEqual(['Vorkurs', 'Kekse']);
    expect(out[1].lexical).toBe(0);
  });
  it('keeps relay order as tiebreak', () => {
    const out = rankResults([{ title: 'Vorkurs A' }, { title: 'Vorkurs B' }], 'Vorkurs', 20);
    expect(out.map((i) => i.title)).toEqual(['Vorkurs A', 'Vorkurs B']);
  });
  it('empty query keeps everything in arrival order, sliced', () => {
    const items = [{ title: 'b' }, { title: 'a' }, { title: 'c' }];
    expect(rankResults(items, undefined, 2).map((i) => i.title)).toEqual(['b', 'a']);
    expect(rankResults(items, '  ', 5)).toHaveLength(3);
  });
  it('interleaves relays round-robin for an empty query (fastest relay does not take the whole limit)', () => {
    const items = [
      { title: 'a1', relay: 'wss://a' }, { title: 'a2', relay: 'wss://a' }, { title: 'a3', relay: 'wss://a' },
      { title: 'b1', relay: 'wss://b' }, { title: 'b2', relay: 'wss://b' }, { title: 'b3', relay: 'wss://b' },
    ];
    expect(rankResults(items, undefined, 4).map((i) => i.title)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });
  it('breaks score ties by position within the own relay', () => {
    const items = [
      { title: 'Vorkurs a1', relay: 'wss://a' }, { title: 'Vorkurs a2', relay: 'wss://a' },
      { title: 'Vorkurs b1', relay: 'wss://b' },
    ];
    expect(rankResults(items, 'Vorkurs', 5).map((i) => i.title)).toEqual(['Vorkurs a1', 'Vorkurs b1', 'Vorkurs a2']);
  });
  it('ignores field filters and treats a token-less query as empty', () => {
    const items = [{ title: 'Paper', score: 0 }, { title: 'Other' }];
    expect(rankResults(items, 'type:academic', 5)).toHaveLength(2);
    expect(rankResults(items, 'Other doi:10.1/x', 5).map((i) => i.title)).toEqual(['Other', 'Paper']);
  });
  it('strips a quoted field filter like the relay tokenizer', () => {
    const items = [{ title: 'foo bar' }, { title: 'Mathe' }];
    const out = rankResults(items, 'title:"foo bar" Mathe', 5);
    expect(out.map((i) => i.title)).toEqual(['Mathe', 'foo bar']);
    expect(out[1].lexical).toBe(0);
  });
  it('applies limit after the sort', () => {
    const items = [{ title: 'Kekse', score: 0.1 }, { title: 'Vorkurs' }];
    expect(rankResults(items, 'Vorkurs', 1).map((i) => i.title)).toEqual(['Vorkurs']);
  });
  it('reads name/summary/topics/about too', () => {
    expect(rankResults([{ name: 'Vorkurs' }], 'Vorkurs', 5)[0].lexical).toBe(1);
    expect(rankResults([{ title: 'x', summary: 'Vorkurs' }], 'Vorkurs', 5)[0].lexical).toBe(0.5);
    expect(rankResults([{ title: 'x', about: ['Vorkurs'] }], 'Vorkurs', 5)[0].lexical).toBe(0.5);
  });
  it('a browse (no relay search at all) sorts newest first across relays', () => {
    const a = [1, 2, 3, 4].map((n) => ({ title: `a${n}`, relay: 'wss://a', createdAt: 1767225600 + n })); // 2026
    const b = [1, 2, 3, 4].map((n) => ({ title: `b${n}`, relay: 'wss://b', nostr: { createdAt: 1546300800 + n } })); // 2019
    expect(rankResults([...a, ...b], undefined, 4, true).map((i) => i.title)).toEqual(['a4', 'a3', 'a2', 'a1']);
  });
});

describe('rankResults merges relays by rank and level fit, not by raw scores', () => {
  const item = (id: string, relay: string, extra: Record<string, unknown> = {}) => ({ id, relay, title: 'Bruchrechnung', ...extra });
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it('interleaves relays round-robin whatever their snippet scores say', () => {
    // A relay's score is 0.7/rank within that relay: rank 1 of a small relay must not beat everything else.
    const a1 = item('a1', 'A', { score: 0.7 });
    const a2 = item('a2', 'A', { score: 0.35 });
    const b1 = item('b1', 'B', { score: 0.2 });
    const b2 = item('b2', 'B');
    expect(ids(rankResults([a1, a2, b1, b2], 'Bruchrechnung', 10))).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('puts better level fit first and keeps the interleave inside equal fit', () => {
    const a1 = item('a1', 'A');
    const a2 = item('a2', 'A');
    const b1 = item('b1', 'B');
    const b2 = item('b2', 'B');
    const fit = new Map([[a1, 0], [a2, 2], [b1, 1], [b2, 2]]);
    expect(ids(rankResults([a1, a2, b1, b2], 'Bruchrechnung', 10, false, (i) => fit.get(i)!))).toEqual(['a2', 'b2', 'b1', 'a1']);
  });

  it('a relay that returned nothing leaves no gaps', () => {
    expect(ids(rankResults([item('a1', 'A'), item('a2', 'A')], 'Bruchrechnung', 10))).toEqual(['a1', 'a2']);
  });
});
