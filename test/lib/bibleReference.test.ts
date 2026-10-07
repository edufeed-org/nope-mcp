import { describe, it, expect } from 'vitest';
import { BIBLE_BOOKS, normalizeBibleReference } from '../../src/lib/bibleReference.js';

describe('normalizeBibleReference (Loccum guidelines)', () => {
  it('keeps the Passau handout examples verbatim', () => {
    for (const ref of [
      'Gen 1,1',
      'Gen 1-3',
      'Gen 1,1-17',
      'Gen 1,1.3.5.7',
      'Gen 1,1.3; 3,17-21; Ex 15,3',
      'Gen 3,17-21',
      'Gen 3,17-4,12'
    ]) {
      expect(normalizeBibleReference(ref)).toBe(ref);
    }
  });

  it.each([
    // Simon Petrus (RPI EKKW) values
    ['Mk. 1,16-20', 'Mk 1,16-20'],
    ['Mt. 14,22-32', 'Mt 14,22-32'],
    ['Mt. 16,13-19', 'Mt 16,13-19'],
    ['Mk. 14', 'Mk 14'],
    ['Joh. 21,15-17', 'Joh 21,15-17'],
    ['Apg. 1-2', 'Apg 1-2'],
    // full names, Luther abbreviations, English/OSIS
    ['Apostelgeschichte 2,1-12', 'Apg 2,1-12'],
    ['Matthäus 5,43-48', 'Mt 5,43-48'],
    ['Psalm 104', 'Ps 104'],
    ['Ps. 23', 'Ps 23'],
    ['1. Mose 2,4-7', 'Gen 2,4-7'],
    ['1 Mo 2,4-7', 'Gen 2,4-7'],
    ['5. Mose 6,4', 'Dtn 6,4'],
    ['Hiob 1,21', 'Ijob 1,21'],
    ['Hi 1,21', 'Ijob 1,21'],
    ['Pred 3,1-8', 'Koh 3,1-8'],
    ['Hes 37,1-14', 'Ez 37,1-14'],
    ['Esr 1,1', 'Esra 1,1'],
    ['Zeph 3,14', 'Zef 3,14'],
    ['Joel 3,1', 'Joël 3,1'],
    ['1. Kor. 13,1-13', '1 Kor 13,1-13'],
    ['1Kor 12', '1 Kor 12'],
    ['2. Tim 3,16', '2 Tim 3,16'],
    ['Matthew 5,1-12', 'Mt 5,1-12'],
    ['1 Corinthians 13', '1 Kor 13'],
    ['Rev 21,4', 'Offb 21,4'],
    // spacing and dashes
    ['Lukas 15,3–7', 'Lk 15,3-7'],
    ['Mk. 1,16 - 20', 'Mk 1,16-20'],
    ['Gen 1, 1', 'Gen 1,1'],
    ['Jer 29,7.11-14a', 'Jer 29,7.11-14a'],
    ['Mt 13,31f.', 'Mt 13,31f.'],
    ['Mt 5,3-12; Lk 6,20-26', 'Mt 5,3-12; Lk 6,20-26'],
    ['Mt 5,3; Mt 6,1', 'Mt 5,3; 6,1']
  ])('%s → %s', (input, expected) => {
    expect(normalizeBibleReference(input)).toBe(expected);
  });

  it('passes unparseable values through unchanged', () => {
    for (const v of [
      'Pfingstgeschichte',
      'Lukasevangelium (LK 10,25-37)',
      'Mk 1,16-20 und mehr',
      'Foo 5,3',
      'Mt 5; Bergpredigt',
      '3,17-21',
      ''
    ]) {
      expect(normalizeBibleReference(v)).toBe(v);
    }
  });

  it('mirrors the app table: 73 books, no dots, every spelling maps to one book', () => {
    expect(BIBLE_BOOKS).toHaveLength(73);
    const seen = new Map<string, string>();
    for (const b of BIBLE_BOOKS) {
      expect(b.abbr).not.toMatch(/\./);
      for (const name of [b.abbr, ...b.aliases]) {
        const key = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.\s]/g, '');
        expect(seen.get(key) ?? b.abbr, name).toBe(b.abbr);
        seen.set(key, b.abbr);
      }
    }
  });
});
