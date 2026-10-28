import { describe, it, expect } from 'vitest';
import { selectPassages, partitionPassageHits, MAX_PASSAGES_PER_DOC, MIN_SCORE_RATIO } from '../../src/tools/passageSelection.js';
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

describe('partitionPassageHits', () => {
  const pk = 'a'.repeat(64);
  const h = (coord: string, extra: Record<string, unknown> = {}) => ({ ...hit(coord, 1), ...extra } as PassageHit);
  const ncSa = { license: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' };
  const by = { license: 'https://creativecommons.org/licenses/by/4.0/' };

  it('releases a 30142 hit with text and a BY-NC-SA license', () => {
    const nc = h(`30142:${pk}:nc`, { text: 't', amb: ncSa, access_level: 'full' });
    expect(partitionPassageHits([nc], 'any')).toEqual({ released: [nc], metadataOnly: [] });
  });

  it('sends a metadata-only 30142 hit to metadataOnly even if it carries a snippet (defence in depth)', () => {
    const restricted = h(`30142:${pk}:r`, { text: 'leak', snippet: 'leak', amb: by, access_level: 'metadata-only' });
    expect(partitionPassageHits([restricted], 'any')).toEqual({ released: [], metadataOnly: [restricted] });
  });

  it('sends a 30142 hit without text and without access_level to metadataOnly', () => {
    const noText = h(`30142:${pk}:x`, { amb: by });
    expect(partitionPassageHits([noText], 'any')).toEqual({ released: [], metadataOnly: [noText] });
  });

  it('sends a 30142 hit whose license is not CC/PD to metadataOnly even with text', () => {
    const arr = h(`30142:${pk}:arr`, { text: 't', amb: { license: 'https://w3id.org/kim/license/attribution' } });
    const unlicensed = h(`30142:${pk}:none`, { text: 't', amb: { name: 'x' } });
    expect(partitionPassageHits([arr, unlicensed], 'any')).toEqual({ released: [], metadataOnly: [arr, unlicensed] });
  });

  it('keeps other kinds released, with or without text', () => {
    const art = h(`30023:${pk}:a`);
    const pub = h(`30041:${pk}:a`, { text: 't' });
    expect(partitionPassageHits([art, pub], 'open')).toEqual({ released: [art, pub], metadataOnly: [] });
  });

  it('with open, drops the BY-NC-SA hit from both lists', () => {
    const nc = h(`30142:${pk}:nc`, { text: 't', amb: ncSa });
    const open = h(`30142:${pk}:by`, { text: 't', amb: by });
    expect(partitionPassageHits([nc, open], 'open')).toEqual({ released: [open], metadataOnly: [] });
  });

  it('with cc-any, metadataOnly is empty', () => {
    const nc = h(`30142:${pk}:nc`, { text: 't', amb: ncSa });
    const arr = h(`30142:${pk}:arr`, { amb: { license: 'https://w3id.org/kim/license/attribution' } });
    const none = h(`30142:${pk}:none`);
    const out = partitionPassageHits([nc, arr, none], 'cc-any');
    expect(out).toEqual({ released: [nc], metadataOnly: [] });
  });

  it('with cc-any, a CC hit without released text still lands in metadataOnly (indexer rollout skew)', () => {
    const skew = h(`30142:${pk}:skew`, { amb: ncSa });
    expect(partitionPassageHits([skew], 'cc-any')).toEqual({ released: [], metadataOnly: [skew] });
  });

  it('amb absent but indexer-released full text: released under any and cc-any, dropped under open', () => {
    const miss = h(`30142:${pk}:miss`, { text: 't', access_level: 'full' });
    expect(partitionPassageHits([miss], 'any')).toEqual({ released: [miss], metadataOnly: [] });
    expect(partitionPassageHits([miss], 'cc-any')).toEqual({ released: [miss], metadataOnly: [] });
    expect(partitionPassageHits([miss], 'open')).toEqual({ released: [], metadataOnly: [] });
  });

  it('amb present without a license and with text is metadata-only under any', () => {
    const named = h(`30142:${pk}:named`, { text: 't', access_level: 'full', amb: { name: 'x' } });
    expect(partitionPassageHits([named], 'any')).toEqual({ released: [], metadataOnly: [named] });
  });

  it('amb absent without access_level full stays metadata-only under any', () => {
    const bare = h(`30142:${pk}:bare`, { text: 't' });
    expect(partitionPassageHits([bare], 'any')).toEqual({ released: [], metadataOnly: [bare] });
  });
});
