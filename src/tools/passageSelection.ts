import type { PassageHit } from '../indexer/client.js';
import { accessLevelFor, classifyLicense, matchesLicenseFilter, type LicenseFilter } from '../license/classify.js';

/**
 * Vector weight sent to the indexer (Typesense rank-fusion `alpha`; 1 = vector
 * only). The indexer's own default, 0.3, is keyword-dominant and lets
 * boilerplate keyword hits ("GRUNDSCHULE", "Kinder") outrank semantically
 * relevant passages; question-shaped queries want the vector rank to lead.
 */
export const PASSAGE_ALPHA = 0.7;
/** Over-fetch factor: k = min(limit * OVERFETCH_FACTOR, 100), so the per-document cap and floor still leave `limit` passages. */
export const OVERFETCH_FACTOR = 3;
/**
 * Extra over-fetch, always applied: partitionPassageHits drops hits outside the
 * licenseFilter and moves metadata-only resource hits out of the passage pool
 * before selection, so the released pool is smaller than k.
 */
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
 * Splits indexer hits into passages that may be released (text and all) and
 * learning-resource hits that may only be listed by their metadata, keeping
 * input order. Only kind 30142 (read from event_coord) is subject to it; other
 * kinds are always released, with or without text.
 *
 * A 30142 hit is classified by its `amb.license` enrichment (missing → no
 * license). Outside `filter` it is dropped from both lists. It is released only
 * when every signal agrees on full access: the license classifies CC/PD, the
 * indexer did not mark it `access_level: "metadata-only"`, and it carries
 * non-empty `text` (the indexer releases text only for chunks its own gate
 * passed). Anything else is metadata-only — even if it carries a snippet.
 * Pure function, no I/O.
 */
export function partitionPassageHits(
  hits: PassageHit[],
  filter: LicenseFilter
): { released: PassageHit[]; metadataOnly: PassageHit[] } {
  const released: PassageHit[] = [];
  const metadataOnly: PassageHit[] = [];
  for (const hit of hits) {
    if (!hit.event_coord.startsWith('30142:')) {
      released.push(hit);
      continue;
    }
    const license = hit.amb?.license;
    const { group } = classifyLicense(typeof license === 'string' ? license : undefined);
    if (!matchesLicenseFilter(group, filter)) continue;
    const full =
      accessLevelFor(group) === 'full' &&
      hit.access_level !== 'metadata-only' &&
      typeof hit.text === 'string' &&
      hit.text.length > 0;
    (full ? released : metadataOnly).push(hit);
  }
  return { released, metadataOnly };
}
