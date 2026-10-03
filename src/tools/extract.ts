import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Anthropic from '@anthropic-ai/sdk';
import { extractMetadata } from '../lib/extractMetadata.js';
import type { AnthropicLike } from '../lib/llm.js';
import { extractPdfText } from '../lib/pdfExtractor.js';
import { VARIANTS } from '../lib/schema.js';
import { READ_OPEN_WORLD } from './annotations.js';

/** Upper bound on sources per extraction — keeps the combined LLM payload sane. */
const MAX_SOURCE_URLS = 10;

/**
 * `extract_metadata` MCP tool.
 *
 * Thin wrapper over `extractMetadata()` from src/lib/. Constructs the
 * Anthropic client from `ANTHROPIC_API_KEY` if present; absent key
 * degrades gracefully to the OpenGraph-only branch.
 *
 * `skosSchemes` defaults to `SKOS_SCHEMES` env (JSON map of
 * fieldName → scheme URI) so a stdio user gets a sensible default
 * without having to spell out vocabs on every call.
 */

function defaultSchemesFromEnv(): Record<string, string> {
  const raw = process.env.SKOS_SCHEMES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    // Ignore malformed env — caller can still pass schemes explicitly.
  }
  return {};
}

export function registerExtractTool(server: McpServer): void {
  server.registerTool(
    'extract_metadata',
    {
      title: 'Extract AMB/EKW form-prefill metadata from one or more URLs',
      description:
        'Fetch one or more public web pages and produce a single AMB/EKW form-prefill payload. ' +
        'Returns OpenGraph fallback by default; with ANTHROPIC_API_KEY set, an LLM ' +
        'grounded in the configured SKOS vocabularies fills SKOS-typed fields with ' +
        'concept IDs and per-field evidence quotes. Pass `urls` to ground the ' +
        'extraction in several documents at once (e.g. multiple uploaded PDFs).',
      inputSchema: {
        url: z
          .string()
          .url()
          .optional()
          .describe('Public http(s) URL of the page to extract. Use `urls` for multiple sources.'),
        urls: z
          .array(z.string().url())
          .min(1)
          .max(MAX_SOURCE_URLS)
          .optional()
          .describe(
            'Public http(s) URLs to extract from together. Their texts are merged into one ' +
              'LLM call so the payload reflects all sources. Provide either `url` or `urls`.'
          ),
        variant: z
          .enum(VARIANTS)
          .optional()
          .default('amb')
          .describe(
            'Form variant. EKW adds religious-education fields (Klassenstufen, Schulart, …); ' +
              'konfi adds Konfi-Arbeit fields (Zielgruppen, Lernformat, Themen, …).'
          ),
        skosSchemes: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Map of form-field name → SKOS scheme URI. Defaults to the SKOS_SCHEMES env var if absent.'
          )
      },
      annotations: READ_OPEN_WORLD,
    },
    async (params) => {
      const urls = params.urls ?? (params.url ? [params.url] : []);
      if (urls.length === 0) {
        throw new Error('extract_metadata requires `url` or a non-empty `urls` array.');
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      const llmClient = apiKey
        ? (new Anthropic({ apiKey }) as unknown as AnthropicLike)
        : undefined;

      // VOCAB_RELAYS is the fallback relay list for naddr1 SKOS schemes
      // whose hint relays are missing or unreachable (e.g. the
      // educational-level naddr ships with no hints). Falls back to
      // AMB_RELAYS so a single env var typically suffices.
      const vocabRelays = (process.env.VOCAB_RELAYS ?? process.env.AMB_RELAYS)
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const result = await extractMetadata({
        urls,
        variant: params.variant ?? 'amb',
        skosSchemes: params.skosSchemes ?? defaultSchemesFromEnv(),
        llmClient,
        pdfExtract: extractPdfText,
        ...(vocabRelays && vocabRelays.length > 0 ? { vocabRelays } : {}),
        ...(process.env.ANTHROPIC_MODEL ? { llmModel: process.env.ANTHROPIC_MODEL } : {})
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }]
      };
    }
  );
}
