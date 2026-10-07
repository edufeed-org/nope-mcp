import { jsonrepair } from 'jsonrepair';
import { fetchPage, type FetchPageResult } from './fetchPage.js';
import { llmEnrich, type AnthropicLike } from './llm.js';
import { vocabSnapshot, type VocabSnapshot } from './vocabs.js';
import { formPayload, type Variant, type ExtractMetadataResult } from './schema.js';
import { normalizeBibleReference } from './bibleReference.js';

/**
 * Orchestrate URL → form-prefill payload.
 *
 * Three branches:
 *
 *  1. AMB short-circuit — if the page exposes AMB JSON-LD, return it
 *     verbatim as payload. No LLM call.
 *  2. LLM-enriched — fetch vocab snapshots for the variant's admissible
 *     SKOS fields, hand them to the LLM via tool_use, validate concept IDs
 *     against the loaded vocabs, drop unknown ones.
 *  3. Open Graph fallback — if no LLM client is configured, surface OG
 *     fields as the payload so the form still gets four prefilled values.
 *
 * The third path doubles as the "graceful degradation" branch when the
 * deployment doesn't have an Anthropic key.
 *
 * `fetchFn` is injectable so the consumer can plug in a SSRF-aware fetch
 * or a test stub. `llmClient` is the same dependency-injected
 * `AnthropicLike` accepted by `llmEnrich`.
 */

export interface ExtractMetadataInput {
  /** Single source URL. Provide this or `urls`; `urls` wins when both are set. */
  url?: string;
  /**
   * Multiple source URLs. Their readable texts are concatenated (with
   * provenance markers) into ONE LLM call so the payload reflects every
   * source. The AMB short-circuit is skipped for multi-source extractions
   * (it has single-document semantics); the OG baseline derives from the
   * first source.
   */
  urls?: string[];
  variant: Variant;
  /**
   * Map of form-field name → SKOS scheme URI. Used to load vocab
   * snapshots and to validate that the LLM's chosen concept IDs are real.
   * Any field omitted here is sent to the LLM without grounding.
   */
  skosSchemes?: Record<string, string>;
  /**
   * Fallback Nostr relays for `naddr1…` SKOS schemes whose hint list is
   * missing or unreachable. Ignored for HTTP/skohub URIs.
   */
  vocabRelays?: string[];
  fetchFn?: typeof fetch;
  /**
   * PDF → plain-text extractor. Forwarded to fetchPage. When omitted,
   * PDF responses degrade to empty `readableText`.
   */
  pdfExtract?: (buffer: ArrayBuffer) => Promise<string>;
  llmClient?: AnthropicLike;
  llmModel?: string;
}

const OG_TO_FIELD: Array<[string, string]> = [
  ['og:title', 'name'],
  ['og:description', 'description'],
  ['og:image', 'image']
];

function ogPayload(page: FetchPageResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [og, field] of OG_TO_FIELD) {
    const v = page.ogTags[og];
    if (v) out[field] = v;
  }
  if (page.language) out.inLanguage = page.language;
  return out;
}

async function loadVocabSnapshots(
  skosSchemes: Record<string, string>,
  vocabRelays: string[] | undefined
): Promise<Record<string, VocabSnapshot>> {
  const snaps: Record<string, VocabSnapshot> = {};
  await Promise.all(
    Object.entries(skosSchemes).map(async ([field, uri]) => {
      try {
        snaps[field] = await vocabSnapshot(uri, {
          nostr: { fallbackRelays: vocabRelays }
        });
      } catch {
        // Skip — field gets an empty canonical-label map below, which
        // causes filterAndEnrichByVocab to drop every entry for that
        // field (correct: vocab unavailable → can't ground → don't
        // surface ungrounded concepts to the user).
      }
    })
  );
  return snaps;
}

/**
 * Build a per-field `Map<conceptId, canonicalPrefLabel>` from the loaded
 * snapshots. Configured fields whose snapshot failed to load get an empty
 * map (which causes the filter step to drop the field entirely).
 */
function vocabMapsFromSnapshots(
  skosSchemes: Record<string, string>,
  snapshots: Record<string, VocabSnapshot>
): Record<string, Map<string, string>> {
  const out: Record<string, Map<string, string>> = {};
  for (const field of Object.keys(skosSchemes)) {
    const snap = snapshots[field];
    out[field] = new Map(
      (snap?.concepts ?? []).map((c) => [c.id, c.prefLabel])
    );
  }
  return out;
}

/**
 * Coerce bare-string concept IDs (which Anthropic models sometimes emit
 * when the tool input_schema doesn't pin down concept-array shape) into
 * the `{id, prefLabel?}` objects the rest of the pipeline expects.
 * Touches only fields that are SKOS-grounded (i.e. have a vocab snapshot).
 */
function normalizeConceptArrays(
  payload: Record<string, unknown>,
  vocabFields: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const field of vocabFields) {
    const value = out[field];
    if (!Array.isArray(value)) continue;
    out[field] = value.map((entry) =>
      typeof entry === 'string' ? { id: entry } : entry
    );
  }
  return out;
}

/**
 * Try strict JSON.parse first; on failure run the input through `jsonrepair`,
 * which fixes the malformed-output shapes Anthropic models occasionally emit
 * — most commonly unescaped ASCII `"` inside German typographic-quote runs
 * (`„…"…"`), which prematurely terminate the JSON string. Returns undefined
 * if neither route yields a parseable object.
 */
function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to repair
  }
  try {
    const repaired = jsonrepair(text);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // give up
  }
  return undefined;
}

/**
 * Anthropic models sometimes serialize the `payload` tool argument as a
 * JSON-encoded string instead of a flat object. Without this, downstream
 * `Object.entries(payload)` iterates the chars of the string and
 * applyVariantSchema strips everything → empty payload. Accept both shapes,
 * and run a JSON-repair fallback when the encoded string is malformed.
 */
function normalizePayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return tryParseObject(value) ?? {};
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Anthropic models sometimes serialize the `evidence` tool argument as a
 * JSON-encoded string instead of a flat object. Accept both shapes (with the
 * same JSON-repair fallback) so the "Smart fill ✨" badges still get their
 * quotes downstream.
 */
function normalizeEvidence(value: unknown): Record<string, string> {
  if (typeof value === 'string') {
    return (tryParseObject(value) as Record<string, string> | undefined) ?? {};
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, string>;
  }
  return {};
}

/**
 * For every SKOS-grounded field: drop concept entries whose id isn't in
 * the loaded vocab AND overwrite each surviving entry's `prefLabel` with
 * the canonical label from the vocab snapshot. This closes two gaps in
 * one pass:
 *
 *  - LLM hallucinations (id not in vocab) are dropped.
 *  - LLM-supplied prefLabels that disagree with the vocab — or are
 *    omitted entirely — get replaced with the canonical label.
 *
 * An empty map for a field (vocab failed to load) drops every entry for
 * that field, which removes the field from the payload via the
 * `filtered.length === 0 → delete` branch. This is the desired
 * behavior: without grounding we can't validate, so we don't surface.
 */
function filterAndEnrichByVocab(
  payload: Record<string, unknown>,
  vocabMaps: Record<string, Map<string, string>>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const [field, idToLabel] of Object.entries(vocabMaps)) {
    const value = out[field];
    if (!Array.isArray(value)) continue;
    const filtered: Array<{ id: string; prefLabel: string }> = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      const canonical = idToLabel.get(id);
      if (canonical === undefined) continue;
      filtered.push({ id, prefLabel: canonical });
    }
    if (filtered.length === 0) {
      delete out[field];
    } else {
      out[field] = filtered;
    }
  }
  return out;
}

/**
 * Enforce the variant-aware schema by stripping fields the schema
 * rejects. AMB variant drops EKW-only fields. Returns the partial
 * payload the schema accepted.
 */
function applyVariantSchema(
  payload: Record<string, unknown>,
  variant: Variant
): Record<string, unknown> {
  const schema = formPayload(variant);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const trial = schema.safeParse({ [k]: v });
    if (trial.success) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Upper bound on the combined readable text handed to the LLM across all
 * sources. `llm.ts` sends `readableText` whole and uncached, so a runaway
 * multi-PDF batch would blow the token budget. Generous enough for a handful
 * of documents; later sources are truncated past this point.
 */
const MAX_COMBINED_TEXT_CHARS = 600_000;

/**
 * Concatenate the readable texts of multiple sources into one string with
 * `=== Source N: URL ===` provenance markers, capped at
 * MAX_COMBINED_TEXT_CHARS so the LLM payload stays bounded.
 */
function combineReadableTexts(
  urls: string[],
  pages: FetchPageResult[]
): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < pages.length; i++) {
    const header = `=== Source ${i + 1}: ${urls[i]} ===\n`;
    const remaining = MAX_COMBINED_TEXT_CHARS - used;
    if (remaining <= header.length) break;
    const body = (pages[i].readableText ?? '').slice(0, remaining - header.length);
    const block = header + body;
    parts.push(block);
    used += block.length + 2; // +2 for the join separator
  }
  return parts.join('\n\n');
}

export async function extractMetadata(
  input: ExtractMetadataInput
): Promise<ExtractMetadataResult> {
  const { url, urls, variant, skosSchemes = {}, vocabRelays, fetchFn, pdfExtract, llmClient, llmModel } = input;

  const sourceUrls = urls ?? (url ? [url] : []);
  if (sourceUrls.length === 0) {
    throw new Error('extractMetadata requires `url` or a non-empty `urls` array.');
  }
  const isMulti = sourceUrls.length > 1;

  const pages = await Promise.all(
    sourceUrls.map((u) => fetchPage({ url: u, fetchFn, pdfExtract }))
  );
  // The first source is authoritative for the OG/AMB baseline and the
  // title/description/ogTags handed to the LLM.
  const page = pages[0];
  const baseline = {
    og: Object.keys(page.ogTags).length > 0 ? page.ogTags : undefined,
    amb: page.ambJsonLd as Record<string, unknown> | undefined
  };

  // 1. AMB short-circuit — single-document semantics only.
  if (!isMulti && page.ambJsonLd && typeof page.ambJsonLd === 'object') {
    return {
      source: 'amb-jsonld',
      payload: page.ambJsonLd as Record<string, unknown>,
      evidence: {},
      baseline
    };
  }

  // 3. OpenGraph fallback (no LLM client configured)
  if (!llmClient) {
    return {
      source: 'opengraph-only',
      payload: ogPayload(page),
      evidence: {},
      baseline
    };
  }

  // 2. LLM-enriched path
  const snapshots = await loadVocabSnapshots(skosSchemes, vocabRelays);
  const vocabMaps = vocabMapsFromSnapshots(skosSchemes, snapshots);

  // Single source keeps its readable text verbatim (behavior unchanged);
  // multiple sources are merged with provenance markers.
  const readableText = isMulti
    ? combineReadableTexts(sourceUrls, pages)
    : page.readableText;

  const llmRes = await llmEnrich({
    client: llmClient,
    variant,
    page: {
      title: page.title,
      description: page.description,
      ogTags: page.ogTags,
      jsonLdPartial: page.jsonLd,
      readableText
    },
    vocabs: snapshots,
    ...(llmModel ? { model: llmModel } : {})
  });

  const vocabFields = new Set(Object.keys(vocabMaps));
  const payloadObject = normalizePayload(llmRes.payload);
  const normalizedPayload = normalizeConceptArrays(payloadObject, vocabFields);
  const normalizedEvidence = normalizeEvidence(llmRes.evidence);

  const filtered = filterAndEnrichByVocab(normalizedPayload, vocabMaps);
  // Layer OG fallbacks beneath the LLM output so the four cheap-to-derive
  // fields (name/description/image/inLanguage) still prefill when the
  // LLM is conservative. LLM output wins on conflict.
  const merged = { ...ogPayload(page), ...filtered };
  const variantSafe = applyVariantSchema(merged, variant);
  // Bible references per the Loccum guidelines even when the model ignored
  // the prompt; unrecognized free text passes through unchanged.
  if (Array.isArray(variantSafe.bibleReferences)) {
    variantSafe.bibleReferences = variantSafe.bibleReferences.map((v: unknown) =>
      typeof v === 'string' ? normalizeBibleReference(v) : v
    );
  }

  // Keep evidence only for fields that survived filtering.
  const evidence: Record<string, string> = {};
  for (const [k, quote] of Object.entries(normalizedEvidence)) {
    if (k in variantSafe && typeof quote === 'string') evidence[k] = quote;
  }

  return {
    source: 'llm-enriched',
    payload: variantSafe,
    evidence,
    baseline
  };
}
