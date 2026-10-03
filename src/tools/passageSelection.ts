import type { PassageHit } from '../indexer/client.js';
import { isOpenLicense } from '../license/open.js';

/**
 * Vector weight sent to the indexer (Typesense rank-fusion `alpha`; 1 = vector
 * only). The indexer's own default, 0.3, is keyword-dominant and lets
 * boilerplate keyword hits ("GRUNDSCHULE", "Kinder") outrank semantically
 * relevant passages; question-shaped queries want the vector rank to lead.
 */
export const PASSAGE_ALPHA = 0.7;
/** Over-fetch factor: k = min(limit * OVERFETCH_FACTOR, 100), so the per-document cap and floor still leave `limit` passages. */
export const OVERFETCH_FACTOR = 3;
/** Extra over-fetch under open-licenses-only, which drops license-gated resource hits before selection. */
export const LICENSE_OVERFETCH_FACTOR = 2;
/** Max passages kept per document (event_coord) — one document must not crowd out the rest. */
export const MAX_PASSAGES_PER_DOC = 2;
/** Hits scoring below this fraction of the top score are dropped. */
export const MIN_SCORE_RATIO = 0.1;

/**
 * Post-filters indexer hits, keeping input order (the indexer already sorts by
 * fused score, descending): at most MAX_PASSAGES_PER_DOC per event_coord, no
 * hit below MIN_SCORE_RATIO of the top score, at most `limit` results.
 * Pure function, no I/O.
 */
export function selectPassages(hits: PassageHit[], limit: number): PassageHit[] {
  if (hits.length === 0 || limit <= 0) return [];
  const floor = MIN_SCORE_RATIO * hits[0].score;
  const perDoc = new Map<string, number>();
  const out: PassageHit[] = [];
  for (const h of hits) {
    if (out.length >= limit) break;
    if (h.score < floor) continue;
    const seen = perDoc.get(h.event_coord) ?? 0;
    if (seen >= MAX_PASSAGES_PER_DOC) continue;
    perDoc.set(h.event_coord, seen + 1);
    out.push(h);
  }
  return out;
}

/**
 * Open-license test for a passage hit. Only learning resources (kind 30142,
 * read from event_coord) are subject to it. The indexer releases `text` only
 * for chunks its license gate passed — the same allowlist (CC0, CC BY,
 * CC BY-SA, public domain) — so a resource hit without text is not open. When
 * the hit's best-effort AMB enrichment carries the license, it must classify
 * open too (guards an indexer deployed with a wider allowlist).
 */
export function isOpenPassageHit(hit: PassageHit): boolean {
  if (!hit.event_coord.startsWith('30142:')) return true;
  if (typeof hit.text !== 'string' || hit.text.length === 0) return false;
  const license = hit.amb?.license;
  return typeof license !== 'string' || isOpenLicense(license);
}
