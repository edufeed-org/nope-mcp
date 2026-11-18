import { describe, it, expect } from 'vitest';
import { defaultRules, parseRules, parseIntent, toSearchString, levelFit } from '../../src/search/intent.js';
import sharedCases from './intent_cases.json' with { type: 'json' };

const K = 'https://w3id.org/kim/';
const L = {
  primar: [K + 'isced-1997/level1', K + 'educationalLevel/level_1'],
  sek1: [K + 'isced-1997/level2', K + 'educationalLevel/level_2'],
  sek2: [K + 'isced-1997/level3', K + 'educationalLevel/level_3'],
};
const T = (t: string) => K + 'hcrt/' + t;

describe('parseIntent (same table as nope-relay search_intent_test.go)', () => {
  const cases: [string, string, string | undefined, string[], string[]][] = [
    ['Unterrichtsmaterial Bruchrechnung Klasse 6', 'Bruchrechnung', '6', L.sek1, []],
    ['Unterrichtsmaterial Bruchrechnung', 'Bruchrechnung', undefined, [...L.primar, ...L.sek1, ...L.sek2], []],
    ['Finde Material zu Fotosynthese, Klasse 7', 'Fotosynthese', '7', L.sek1, []],
    ['Arbeitsblätter Weimarer Republik Sekundarstufe I', 'Weimarer Republik', undefined, L.sek1, [T('worksheet')]],
    ['Video zum Wasserkreislauf für die Grundschule', 'Wasserkreislauf', undefined, L.primar, [T('video')]],
    ['Unterrichtsentwürfe für Klasse 12 Mathematik', 'Mathematik', '12', L.sek2, [T('lesson_plan')]],
    ['Künstliche Intelligenz im Unterricht', 'Künstliche Intelligenz Unterricht', undefined, [], []],
    ['Zeige Fotosynthese', 'Fotosynthese', undefined, [], []],
    // unchanged
    ['Fotosynthese', 'Fotosynthese', undefined, [], []],
    ['Videos für die Grundschule', 'Videos für die Grundschule', undefined, [], []],
    ['Klasse 2000', 'Klasse 2000', undefined, [], []],
    ['', '', undefined, [], []],
    // phrases and field tokens pass through verbatim
    ['"Klasse 6" Bruchrechnung', '"Klasse 6" Bruchrechnung', undefined, [], []],
    ['Bruchrechnung Grundschule type:academic', 'Bruchrechnung type:academic', undefined, L.primar, []],
    // a caller that already sends hints is left alone
    ['Bruchrechnung Grundschule prefer.grade:6', 'Bruchrechnung Grundschule prefer.grade:6', undefined, [], []],
  ];
  it.each(cases)('%s', (query, text, grade, levels, types) => {
    const i = parseIntent(query, defaultRules);
    expect(i.text).toBe(text);
    expect(i.grade).toBe(grade);
    expect([...i.levels].sort()).toEqual([...levels].sort());
    expect(i.types).toEqual(types);
  });
});

describe('toSearchString', () => {
  it('appends hints after the cleaned text', () => {
    const i = parseIntent('Video zum Wasserkreislauf für die Grundschule', defaultRules);
    expect(toSearchString(i)).toBe(
      `Wasserkreislauf prefer.level:${L.primar[0]} prefer.level:${L.primar[1]} prefer.type:${T('video')}`
    );
  });
  it('adds the grade', () => {
    expect(toSearchString(parseIntent('Bruchrechnung Klasse 6', defaultRules))).toContain(' prefer.grade:6');
  });
  it('returns the text alone when nothing was recognised', () => {
    expect(toSearchString(parseIntent('"Klasse 6" type:academic Fotosynthese', defaultRules))).toBe(
      '"Klasse 6" type:academic Fotosynthese'
    );
  });
});

describe('levelFit', () => {
  const i = parseIntent('Bruchrechnung Klasse 6', defaultRules);
  it('grades an event by its own tags', () => {
    expect(levelFit([['ext:de.sodix:klassenstufe:id', '6']], i)).toBe(3);
    expect(levelFit([['educationalLevel:id', L.sek1[0]]], i)).toBe(2);
    expect(levelFit([['educationalLevel:id', 'http://w3id.org/kim/isced-1997/level2/']], i)).toBe(2);
    expect(levelFit([], i)).toBe(1);
    expect(levelFit([['educationalLevel:id', L.primar[0]]], i)).toBe(0);
  });
  it('is 0 for every event when the intent names no level', () => {
    expect(levelFit([['educationalLevel:id', L.sek1[0]]], parseIntent('Fotosynthese', defaultRules))).toBe(0);
  });
});

describe('parseRules', () => {
  it('rejects what it does not fully understand', () => {
    for (const bad of [
      { version: 2, stopwords: ['a'] },
      { version: 1, stopwords: [] },
      { version: 1, stopwords: ['a'], level: [] }, // unknown key
      { version: 1, stopwords: ['a'], levels: [{ words: [''], concepts: ['L'] }] },
      { version: 1, stopwords: ['a'], types: [{ words: ['video'], concepts: ['v community:abc'] }] },
      'nonsense',
    ]) {
      expect(() => parseRules(bad)).toThrow();
    }
  });
});

// The TypeScript parser here and the Go parser in nope-relay must read a
// question the same way. Both run this file of cases (nope-relay keeps the
// same file in testdata/search_intent_cases.json).
describe('parseIntent shared cases with nope-relay', () => {
  it.each(sharedCases.cases)('$query', (c) => {
    const i = parseIntent(c.query, defaultRules);
    expect(i.text).toBe(c.text);
    expect(i.grade ?? null).toBe(c.grade);
    expect([...i.levels].sort()).toEqual(c.levels);
    expect(i.types).toEqual(c.types);
  });
});
