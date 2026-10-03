/**
 * Public library entry — what consumers import as `nope-mcp/lib`.
 *
 * Used directly by edufeed-app's `/api/enrich` route so the runtime path
 * matches the MCP tool path exactly. No subprocess, no separate code.
 */

export { extractMetadata } from './extractMetadata.js';
export type { ExtractMetadataInput } from './extractMetadata.js';

export { fetchPage } from './fetchPage.js';
export type { FetchPageInput, FetchPageResult } from './fetchPage.js';

export { vocabSnapshot } from './vocabs.js';
export type { VocabConcept, VocabSnapshot, VocabSnapshotOptions } from './vocabs.js';

export { llmEnrich, DEFAULT_MODEL } from './llm.js';
export type { AnthropicLike, LlmEnrichInput, LlmEnrichResult, LlmPageInput } from './llm.js';

export { createAnthropicClient } from './anthropic.js';

export {
  formPayload,
  extractMetadataResult
} from './schema.js';
export type {
  Variant,
  FormPayload,
  FormPayloadAmb,
  FormPayloadEkw,
  ExtractMetadataResult
} from './schema.js';
