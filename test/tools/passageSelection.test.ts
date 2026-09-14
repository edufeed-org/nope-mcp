import { describe, it, expect } from 'vitest';
import { selectPassages, MAX_PASSAGES_PER_DOC, MIN_SCORE_RATIO } from '../../src/tools/passageSelection.js';
import type { PassageHit } from '../../src/indexer/client.js';

const hit = (coord: string, score: number, idx = 0): PassageHit =>
  ({ chunk_id: `${coord}:${idx}`, event_id: 'e', event_coord: coord, chunk_idx: idx, snippet: 's', score } as PassageHit);

describe('selectPassages', () => {
  it('caps passages per document and keeps order', () => {
    const hits = [hit('A', 0.7, 1), hit('A', 0.35, 2), hit('A', 0.3, 3), hit('B', 0.25), hit('A', 0.2, 4), hit('C', 0.15)];
    const out = selectPassages(hits, 10);
    expect(out.map((h) => h.event_coord)).toEqual(['A', 'A', 'B', 'C']);
    expect(out.filter((h) => h.event_coord === 'A')).toHaveLength(MAX_PASSAGES_PER_DOC);
  });
  it('drops hits below the relative floor', () => {
    const out = selectPassages([hit('A', 1.0), hit('B', 0.2), hit('C', 0.1), hit('D', 0.09)], 10);
    expect(out.map((h) => h.event_coord)).toEqual(['A', 'B', 'C']);
    expect(0.09).toBeLessThan(MIN_SCORE_RATIO * 1.0);
  });
  it('truncates to limit', () => {
    const out = selectPassages([hit('A', 1), hit('B', 0.9), hit('C', 0.8)], 2);
    expect(out).toHaveLength(2);
  });
  it('empty input → empty output', () => {
    expect(selectPassages([], 5)).toEqual([]);
  });
});
