import { z } from 'zod';

/**
 * Form-payload schema for the URL → form prefill feature.
 *
 * Three variants:
 *  - 'amb'   — generic AMB educational resources
 *  - 'ekw'   — adds EKKW-specific religious-education fields on top of AMB
 *              (school-context: schoolTypes, gradeLevels, ekwFachrichtung, …)
 *  - 'konfi' — Konfi-Arbeit (confirmation program); adds its own vocabulary
 *              family (Zielgruppen, Lernformat, Themen, …) on top of AMB.
 *              Disjoint from 'ekw' because Konfi pedagogy ≠ school pedagogy.
 *
 * Variant-aware via .strict(): variant-specific fields are rejected when sent
 * under the wrong variant. `bibleReferences` is shared between 'ekw' and
 * 'konfi' since both deal with biblical content.
 */

/**
 * Single source of truth for valid variant strings. Exported as a runtime
 * constant so the MCP tool boundary (`src/tools/extract.ts`) can derive its
 * input enum from the same list — otherwise the two diverge silently and a
 * new variant added here is rejected at the tool boundary before reaching
 * the handler.
 */
export const VARIANTS = ['amb', 'ekw', 'konfi'] as const;
export type Variant = (typeof VARIANTS)[number];

const localizedConcept = z.object({
  id: z.string(),
  prefLabel: z.string().optional()
});

const personOrOrg = z.object({
  name: z.string(),
  type: z.enum(['Person', 'Organization']).optional(),
  id: z.string().optional()
});

const ambBase = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  inLanguage: z.string().optional(),
  image: z.string().url().optional(),
  keywords: z.array(z.string()).optional(),

  // SKOS concept-picker fields — concept IDs are required, prefLabels are hints
  learningResourceType: z.array(localizedConcept).optional(),
  educationalLevels: z.array(localizedConcept).optional(),
  about: z.array(localizedConcept).optional(),

  creators: z.array(personOrOrg).optional(),
  publisher: z.array(personOrOrg).optional(),

  license: z.string().url().optional(),
  isAccessibleForFree: z.boolean().optional(),
  datePublished: z.string().optional()
});

const ekwExtensions = z.object({
  ekwFachrichtung: z.array(localizedConcept).optional(),
  gradeLevels: z.array(localizedConcept).optional(),
  schoolTypes: z.array(localizedConcept).optional(),
  didacticConcepts: z.array(localizedConcept).optional(),
  methods: z.array(localizedConcept).optional(),
  methodOther: z.string().optional(),
  bibleReferences: z.array(z.string()).optional()
});

// Konfi-Arbeit extensions. Field names mirror `schemeKey` in the edufeed-app
// wizard's `bildungsbereich.js` konfi step4 config so the wizard's
// `applyEnrichmentToForm` can map directly without re-keying.
const konfiExtensions = z.object({
  konfiZielgruppen: z.array(localizedConcept).optional(),
  konfiLernformat: z.array(localizedConcept).optional(),
  konfiZeitstruktur: z.array(localizedConcept).optional(),
  konfiBeteiligte: z.array(localizedConcept).optional(),
  konfiThemen: z.array(localizedConcept).optional(),
  konfiDimensionen: z.array(localizedConcept).optional(),
  konfiMethode: z.array(localizedConcept).optional(),
  konfiMaterialaufwand: z.array(localizedConcept).optional(),
  konfiTechnikbedarf: z.array(localizedConcept).optional(),
  konfiLernorte: z.array(localizedConcept).optional(),
  landeskirchen: z.array(localizedConcept).optional(),
  plainLanguage: z.boolean().optional(),
  requiredMaterialsNote: z.string().optional(),
  // Shared with EKW — both variants deal with biblical content.
  bibleReferences: z.array(z.string()).optional()
});

const ambSchema = ambBase.strict();
const ekwSchema = ambBase.merge(ekwExtensions).strict();
const konfiSchema = ambBase.merge(konfiExtensions).strict();

/**
 * Return the variant-appropriate form-payload zod schema.
 */
export function formPayload(variant: Variant) {
  switch (variant) {
    case 'ekw':
      return ekwSchema;
    case 'konfi':
      return konfiSchema;
    default:
      return ambSchema;
  }
}

export type FormPayloadAmb = z.infer<typeof ambSchema>;
export type FormPayloadEkw = z.infer<typeof ekwSchema>;
export type FormPayloadKonfi = z.infer<typeof konfiSchema>;
export type FormPayload = FormPayloadAmb | FormPayloadEkw | FormPayloadKonfi;

/**
 * The full result returned by extractMetadata().
 *
 * `source` indicates how the payload was produced:
 *   - 'amb-jsonld'      — page contained AMB JSON-LD; LLM was not called
 *   - 'llm-enriched'    — Open Graph + Readability text fed to an LLM
 *   - 'opengraph-only'  — page had no AMB JSON-LD and the LLM step was skipped
 *
 * `evidence[fieldName]` is a quoted page phrase justifying the LLM's choice
 * for that field. Empty for amb-jsonld and opengraph-only sources.
 *
 * `baseline` carries the raw extracted shapes so the UI can show the user
 * what was on the page before the LLM made any inferences.
 */
export const extractMetadataResult = z.object({
  source: z.enum(['amb-jsonld', 'llm-enriched', 'opengraph-only']),
  // payload is intentionally loose at this level — variant-specific validation
  // happens via formPayload(variant). Keeping it permissive here lets a single
  // result type be returned for either variant without parameterizing the
  // outer schema.
  payload: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.string()),
  baseline: z.object({
    og: z.record(z.string(), z.unknown()).optional(),
    amb: z.record(z.string(), z.unknown()).optional()
  }),
  // Multi-source extraction: sources after the first that could not be used
  // (unsupported content type, fetch failure, too large). Absent when every
  // source contributed.
  skippedSources: z
    .array(z.object({ url: z.string(), code: z.string(), reason: z.string() }))
    .optional()
});

export type ExtractMetadataResult = z.infer<typeof extractMetadataResult>;
