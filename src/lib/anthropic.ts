/**
 * Tiny factory that constructs an `AnthropicLike` client backed by the real
 * `@anthropic-ai/sdk` package. Exported from `nope-mcp/lib` so consumers don't
 * have to depend on the SDK directly — the lib already does.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike } from './llm.js';

/**
 * @param apiKey - Anthropic API key. When absent, returns `undefined` so
 *                 callers can pass the result straight into `extractMetadata`
 *                 (which then runs the OpenGraph-only branch).
 */
export function createAnthropicClient(apiKey: string | undefined): AnthropicLike | undefined {
  if (!apiKey) return undefined;
  // The SDK's typed surface is a superset of AnthropicLike; the cast is safe
  // because AnthropicLike picks only the messages.create method we use.
  return new Anthropic({ apiKey }) as unknown as AnthropicLike;
}
