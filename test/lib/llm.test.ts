import { describe, it, expect, vi } from 'vitest';
import { llmEnrich, type AnthropicLike } from '../../src/lib/llm.js';
import type { VocabSnapshot } from '../../src/lib/vocabs.js';

/**
 * Build a stub Anthropic client that returns a canned tool_use response.
 * Captures the arguments it was called with so tests can assert on prompt
 * shape (cache_control, vocab inclusion, etc.).
 */
function stubClient(toolInput: unknown): {
  client: AnthropicLike;
  calls: Parameters<AnthropicLike['messages']['create']>;
} {
  const calls: Parameters<AnthropicLike['messages']['create']> = [] as unknown as Parameters<
    AnthropicLike['messages']['create']
  >;
  const client: AnthropicLike = {
    messages: {
      create: vi.fn(async (params: unknown) => {
        (calls as unknown[]).push(params);
        return {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test',
              name: 'submit_form_payload',
              input: toolInput
            }
          ]
        };
      })
    }
  };
  return { client, calls };
}

const lrtVocab: VocabSnapshot = {
  id: 'https://w3id.org/kim/hcrt/scheme',
  title: 'Hochschulcampus Ressourcentypen',
  concepts: [
    { id: 'https://w3id.org/kim/hcrt/text', prefLabel: 'Text' },
    { id: 'https://w3id.org/kim/hcrt/video', prefLabel: 'Video' }
  ]
};

describe('llmEnrich', () => {
  it('returns the parsed tool_use payload + evidence', async () => {
    const toolInput = {
      payload: {
        name: 'A lesson',
        learningResourceType: [{ id: 'https://w3id.org/kim/hcrt/text' }]
      },
      evidence: {
        name: 'A lesson on the gospel',
        learningResourceType: 'reading text passages'
      }
    };
    const { client } = stubClient(toolInput);

    const result = await llmEnrich({
      client,
      variant: 'amb',
      page: {
        title: 'A lesson',
        description: 'short desc',
        ogTags: {},
        readableText: 'A lesson on the gospel with reading text passages.'
      },
      vocabs: { learningResourceType: lrtVocab }
    });

    expect(result.payload.name).toBe('A lesson');
    expect(result.evidence.name).toBe('A lesson on the gospel');
  });

  it('forces tool_choice to submit_form_payload', async () => {
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'amb',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as Record<string, unknown>;
    expect(params.tool_choice).toMatchObject({ type: 'tool', name: 'submit_form_payload' });
  });

  it('marks the vocab block as cache_control: ephemeral for prompt caching', async () => {
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'amb',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: { learningResourceType: lrtVocab }
    });
    const params = calls[0] as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const userBlocks = params.messages[0].content;
    // At least one block carries cache_control.ephemeral — that's the vocab block
    const hasCache = userBlocks.some(
      (b) => (b.cache_control as Record<string, unknown> | undefined)?.type === 'ephemeral'
    );
    expect(hasCache).toBe(true);
  });

  it('includes the variant in the system prompt', async () => {
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'ekw',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as { system: string | Array<{ text?: string }> };
    const systemText = typeof params.system === 'string'
      ? params.system
      : params.system.map((s) => s.text ?? '').join(' ');
    expect(systemText).toMatch(/ekw/i);
  });

  it('declares the AMB + EKW form fields as explicit payload properties', async () => {
    // Without per-field properties Anthropic models sometimes serialize the
    // entire `payload` arg as a JSON-encoded string, and those strings can
    // contain unescaped typographic quotes that break JSON.parse downstream
    // (observed on real magazine PDFs with German „…" quotes). A concrete
    // schema makes the model emit a structured object instead.
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'ekw',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as {
      tools: Array<{
        name: string;
        input_schema: {
          properties: {
            payload: {
              type?: string;
              properties?: Record<string, { type?: string }>;
            };
          };
        };
      }>;
    };
    const tool = params.tools.find((t) => t.name === 'submit_form_payload');
    expect(tool).toBeDefined();
    const payloadSchema = tool!.input_schema.properties.payload;
    expect(payloadSchema.type).toBe('object');
    const props = payloadSchema.properties ?? {};

    // AMB simple text fields
    expect(props.name?.type).toBe('string');
    expect(props.description?.type).toBe('string');
    expect(props.inLanguage?.type).toBe('string');
    expect(props.image?.type).toBe('string');
    expect(props.license?.type).toBe('string');
    // AMB array fields
    expect(props.keywords?.type).toBe('array');
    expect(props.creators?.type).toBe('array');
    expect(props.publisher?.type).toBe('array');
    // AMB SKOS concept arrays
    expect(props.learningResourceType?.type).toBe('array');
    expect(props.educationalLevels?.type).toBe('array');
    // EKW extension fields
    expect(props.ekwFachrichtung?.type).toBe('array');
    expect(props.gradeLevels?.type).toBe('array');
    expect(props.schoolTypes?.type).toBe('array');
    expect(props.didacticConcepts?.type).toBe('array');
    expect(props.methods?.type).toBe('array');
    expect(props.methodOther?.type).toBe('string');
    expect(props.bibleReferences?.type).toBe('array');
  });

  it('declares the Konfi-Arbeit form fields as explicit payload properties under variant=konfi', async () => {
    // Konfi extensions need explicit properties for the same reason as EKW —
    // without them Anthropic falls back to JSON-string serialization of the
    // entire payload, which breaks downstream parsing on typographic quotes.
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'konfi',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as {
      tools: Array<{
        name: string;
        input_schema: {
          properties: {
            payload: {
              properties?: Record<string, { type?: string }>;
            };
          };
        };
      }>;
    };
    const tool = params.tools.find((t) => t.name === 'submit_form_payload');
    const props = tool!.input_schema.properties.payload.properties ?? {};

    // All 11 Konfi vocab fields
    expect(props.konfiZielgruppen?.type).toBe('array');
    expect(props.konfiLernformat?.type).toBe('array');
    expect(props.konfiZeitstruktur?.type).toBe('array');
    expect(props.konfiBeteiligte?.type).toBe('array');
    expect(props.konfiThemen?.type).toBe('array');
    expect(props.konfiDimensionen?.type).toBe('array');
    expect(props.konfiMethode?.type).toBe('array');
    expect(props.konfiMaterialaufwand?.type).toBe('array');
    expect(props.konfiTechnikbedarf?.type).toBe('array');
    expect(props.konfiLernorte?.type).toBe('array');
    expect(props.landeskirchen?.type).toBe('array');
    // 2 Konfi scalars
    expect(props.plainLanguage?.type).toBe('boolean');
    expect(props.requiredMaterialsNote?.type).toBe('string');
    // shared with EKW
    expect(props.bibleReferences?.type).toBe('array');
  });

  it.each(['ekw', 'konfi'] as const)(
    'asks for bible references per the Loccum guidelines under variant=%s',
    async (variant) => {
      const { client, calls } = stubClient({ payload: {}, evidence: {} });
      await llmEnrich({ client, variant, page: { ogTags: {}, readableText: 'x' }, vocabs: {} });
      const params = calls[0] as { system: string | Array<{ text?: string }> };
      const systemText = typeof params.system === 'string'
        ? params.system
        : params.system.map((s) => s.text ?? '').join(' ');
      for (const example of ['Mt 5,1-12', 'Apg 2,1-12', '1 Kor 13,1-13', 'Gen 2,4-7', 'Ps 23']) {
        expect(systemText).toContain(`"${example}"`);
      }
      expect(systemText).toMatch(/Loccum/);
      expect(systemText).not.toContain('Apostelgeschichte 2,1-12');
    }
  );

  it('includes Konfi-specific field guidance in the system prompt under variant=konfi', async () => {
    // Konfi vocabularies overlap semantically (Themen vs Dimensionen, Lernformat
    // vs Methode) — without explicit guidance the LLM conflates them. Make
    // sure the prompt names at least the most-confusable fields so the
    // distinction reaches the model.
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'konfi',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as { system: string | Array<{ text?: string }> };
    const systemText = typeof params.system === 'string'
      ? params.system
      : params.system.map((s) => s.text ?? '').join(' ');
    expect(systemText).toMatch(/konfi/i);
    expect(systemText).toMatch(/zielgruppen/i);
    expect(systemText).toMatch(/themen/i);
    expect(systemText).toMatch(/dimensionen/i);
    expect(systemText).toMatch(/lernformat/i);
  });

  it('instructs the model that evidence must be a verbatim substring of the page in the source language', async () => {
    // Real-world failure: the model produced English meta-commentary like
    // "Content explicitly addresses religious and theological concepts: ..." for a
    // German page, instead of quoting actual page text. Tighten the prompt so
    // evidence is a verbatim substring AND in the page's language.
    const { client, calls } = stubClient({ payload: {}, evidence: {} });
    await llmEnrich({
      client,
      variant: 'amb',
      page: { ogTags: {}, readableText: 'x' },
      vocabs: {}
    });
    const params = calls[0] as { system: string | Array<{ text?: string }>; tools: Array<{ input_schema: { properties: { evidence: { description?: string } } } }> };
    const systemText = typeof params.system === 'string'
      ? params.system
      : params.system.map((s) => s.text ?? '').join(' ');
    expect(systemText).toMatch(/verbatim/i);
    expect(systemText).toMatch(/substring|exact phrase|exactly as it appears/i);
    expect(systemText).toMatch(/same language|source language|language of the page/i);

    // The tool schema description should reinforce the same constraint so the
    // model's structured-output discipline picks it up too.
    const evidenceDesc = params.tools[0].input_schema.properties.evidence.description ?? '';
    expect(evidenceDesc).toMatch(/verbatim/i);
  });

  it('throws when the model returns no tool_use block', async () => {
    const client: AnthropicLike = {
      messages: {
        create: vi.fn(async () => ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'sorry' }]
        }))
      }
    };
    await expect(
      llmEnrich({
        client,
        variant: 'amb',
        page: { ogTags: {}, readableText: 'x' },
        vocabs: {}
      })
    ).rejects.toThrow();
  });

  describe('retry on transient Anthropic errors', () => {
    /**
     * Build an Anthropic error mimicking the SDK's APIError shape. The SDK
     * exposes `status` as a number on thrown errors; `error.error.type` is
     * the Anthropic-side classification (`overloaded_error`, `rate_limit`,
     * etc.). We replicate both so the retry policy can match on either.
     */
    function anthropicError(status: number, type: string, message = 'boom'): Error & {
      status: number;
      error?: { type: string; error: { type: string; message: string } };
    } {
      const err = new Error(message) as Error & {
        status: number;
        error?: { type: string; error: { type: string; message: string } };
      };
      err.status = status;
      err.error = { type: 'error', error: { type, message } };
      return err;
    }

    function okResponse(toolInput: unknown) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use' as const,
            id: 'toolu_test',
            name: 'submit_form_payload',
            input: toolInput
          }
        ]
      };
    }

    it('retries on 529 overloaded_error and succeeds on the second attempt', async () => {
      const create = vi
        .fn()
        .mockRejectedValueOnce(anthropicError(529, 'overloaded_error', 'Overloaded'))
        .mockResolvedValueOnce(okResponse({ payload: { name: 'ok' }, evidence: { name: 'ok' } }));
      const client: AnthropicLike = { messages: { create } };

      const result = await llmEnrich({
        client,
        variant: 'amb',
        page: { ogTags: {}, readableText: 'x' },
        vocabs: {},
        // Tight timing so the test stays fast.
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      });

      expect(create).toHaveBeenCalledTimes(2);
      expect(result.payload).toEqual({ name: 'ok' });
    });

    it('retries on 429 rate-limit errors', async () => {
      const create = vi
        .fn()
        .mockRejectedValueOnce(anthropicError(429, 'rate_limit_error', 'Rate limited'))
        .mockResolvedValueOnce(okResponse({ payload: {}, evidence: {} }));
      const client: AnthropicLike = { messages: { create } };

      await llmEnrich({
        client,
        variant: 'amb',
        page: { ogTags: {}, readableText: 'x' },
        vocabs: {},
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      });

      expect(create).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 400/validation errors', async () => {
      const create = vi.fn().mockRejectedValue(anthropicError(400, 'invalid_request_error', 'bad'));
      const client: AnthropicLike = { messages: { create } };

      await expect(
        llmEnrich({
          client,
          variant: 'amb',
          page: { ogTags: {}, readableText: 'x' },
          vocabs: {},
          retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
        })
      ).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('gives up after maxAttempts and surfaces the original error', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(anthropicError(529, 'overloaded_error', 'Overloaded'));
      const client: AnthropicLike = { messages: { create } };

      await expect(
        llmEnrich({
          client,
          variant: 'amb',
          page: { ogTags: {}, readableText: 'x' },
          vocabs: {},
          retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
        })
      ).rejects.toThrow(/Overloaded/);
      expect(create).toHaveBeenCalledTimes(3);
    });

    it('logs Anthropic errors via console.error so failures appear in docker logs', async () => {
      // Today extract_metadata failures vanish into the MCP SDK's tool-error
      // envelope and never reach stderr. Make sure llmEnrich logs each
      // attempt's failure so future incidents are debuggable from the
      // container logs alone.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const create = vi
        .fn()
        .mockRejectedValueOnce(anthropicError(529, 'overloaded_error', 'Overloaded'))
        .mockResolvedValueOnce(okResponse({ payload: {}, evidence: {} }));
      const client: AnthropicLike = { messages: { create } };

      await llmEnrich({
        client,
        variant: 'amb',
        page: { ogTags: {}, readableText: 'x' },
        vocabs: {},
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      });

      expect(spy).toHaveBeenCalled();
      const msg = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(msg).toMatch(/llmEnrich/i);
      expect(msg).toMatch(/529|overloaded/i);
      spy.mockRestore();
    });
  });
});
