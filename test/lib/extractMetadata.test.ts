import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractMetadata } from '../../src/lib/extractMetadata.js';
import type { AnthropicLike } from '../../src/lib/llm.js';
import { vocabularyCache } from '../../src/skos/cache.js';
import type { ParsedVocabulary } from '../../src/skos/types.js';

/**
 * Build a fake fetch returning a fixed HTML body.
 */
const fakeHtml = (html: string) =>
  async (_url: string | URL): Promise<Response> =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** A minimal Anthropic stub returning a canned tool_use payload. */
function stubLlm(payload: Record<string, unknown>, evidence: Record<string, string>): AnthropicLike {
  return {
    messages: {
      create: vi.fn(async () => ({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_test',
            name: 'submit_form_payload',
            input: { payload, evidence }
          }
        ]
      }))
    }
  };
}

const LRT_URI = 'https://w3id.org/kim/hcrt/scheme';
const lrtVocab: ParsedVocabulary = {
  scheme: {
    id: LRT_URI,
    type: 'ConceptScheme',
    title: { de: 'Lernressourcentyp' },
    hasTopConcept: []
  },
  concepts: new Map([
    [
      'https://w3id.org/kim/hcrt/text',
      {
        id: 'https://w3id.org/kim/hcrt/text',
        type: 'Concept',
        prefLabel: { de: 'Text' }
      }
    ],
    [
      'https://w3id.org/kim/hcrt/video',
      {
        id: 'https://w3id.org/kim/hcrt/video',
        type: 'Concept',
        prefLabel: { de: 'Video' }
      }
    ]
  ])
};

beforeEach(() => {
  vocabularyCache.clear();
  vocabularyCache.set(LRT_URI, lrtVocab);
});

describe('extractMetadata — AMB short-circuit', () => {
  it('returns source: amb-jsonld and skips LLM when AMB JSON-LD is present', async () => {
    const ld = JSON.stringify({
      '@context': ['https://schema.org/', 'https://w3id.org/kim/amb/context.jsonld'],
      '@type': ['LearningResource'],
      id: 'urn:uuid:abc',
      name: 'A lesson'
    });
    const html = `<html><head><script type="application/ld+json">${ld}</script></head><body><p>x</p></body></html>`;
    const llmClient = stubLlm({}, {});

    const result = await extractMetadata({
      url: 'https://example.com/lesson',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient
    });

    expect(result.source).toBe('amb-jsonld');
    expect(result.payload).toMatchObject({ name: 'A lesson' });
    expect(result.baseline.amb).toBeDefined();
    expect(llmClient.messages.create).not.toHaveBeenCalled();
  });
});

describe('extractMetadata — opengraph-only fallback', () => {
  it('returns OG fields and source: opengraph-only when no LLM client provided', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Desc">
        <meta property="og:image" content="https://example.com/img.png">
        <meta property="og:locale" content="de_DE">
      </head><body><p>x</p></body></html>`;

    const result = await extractMetadata({
      url: 'https://example.com/',
      variant: 'amb',
      fetchFn: fakeHtml(html)
      // no llmClient
    });

    expect(result.source).toBe('opengraph-only');
    expect(result.payload).toMatchObject({
      name: 'OG Title',
      description: 'OG Desc',
      image: 'https://example.com/img.png',
      inLanguage: 'de'
    });
    expect(result.baseline.og?.['og:title']).toBe('OG Title');
    expect(result.evidence).toEqual({});
  });
});

describe('extractMetadata — LLM-enriched path', () => {
  it('calls the LLM with the requested vocabs and returns its payload', async () => {
    const html = `<html><head><title>Reading</title></head><body><p>A reading lesson.</p></body></html>`;

    const llmClient = stubLlm(
      {
        name: 'Reading lesson',
        learningResourceType: [{ id: 'https://w3id.org/kim/hcrt/text' }]
      },
      { name: 'Reading', learningResourceType: 'A reading lesson' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.source).toBe('llm-enriched');
    expect(result.payload.name).toBe('Reading lesson');
    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/text', prefLabel: 'Text' }
    ]);
    expect(llmClient.messages.create).toHaveBeenCalledOnce();
  });

  it('drops concept IDs that are not in the loaded vocab', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;

    const llmClient = stubLlm(
      {
        name: 'x',
        learningResourceType: [
          { id: 'https://w3id.org/kim/hcrt/text' },
          { id: 'https://w3id.org/kim/hcrt/INVALID' }
        ]
      },
      { name: 'x', learningResourceType: 'y' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/text', prefLabel: 'Text' }
    ]);
  });

  it('strips evidence entries whose payload field was dropped', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;

    const llmClient = stubLlm(
      { name: 'x' }, // no learningResourceType
      { name: 'name evidence', learningResourceType: 'orphan evidence' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.evidence.name).toBe('name evidence');
    expect(result.evidence.learningResourceType).toBeUndefined();
  });

  it('rejects EKW-only fields under variant=amb', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      { name: 'x', bibleReferences: ['Mt 5,1-12'] },
      { name: 'name', bibleReferences: 'matthew' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.payload.bibleReferences).toBeUndefined();
    expect(result.evidence.bibleReferences).toBeUndefined();
  });

  it('keeps EKW-only fields under variant=ekw', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      { name: 'x', bibleReferences: ['Mt 5,1-12'] },
      { name: 'name', bibleReferences: 'matthew' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'ekw',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.payload.bibleReferences).toEqual(['Mt 5,1-12']);
  });

  it('normalizes bibleReferences to the Loccum form after the LLM call', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      { name: 'x', bibleReferences: ['Mk. 1,16-20', '1. Mose 2,4-7', 'Pfingstgeschichte'] },
      { name: 'name', bibleReferences: 'Mk. 1,16-20' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'ekw',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.payload.bibleReferences).toEqual([
      'Mk 1,16-20',
      'Gen 2,4-7',
      'Pfingstgeschichte'
    ]);
  });

  it('keeps Konfi-only vocab fields and bibleReferences under variant=konfi', async () => {
    // Konfi vocabularies share the LLM's tool-input shape with the EKW
    // schemes — generic concept-array fields keyed by form-field name. As
    // long as the variant accepts them, the same filter+enrich pipeline
    // applies. This locks in the variant routing end-to-end.
    const KONFI_ZIELGRUPPEN_URI = 'naddr-konfi-zielgruppen';
    const KONFI_ZIELGRUPPEN_ID = 'https://w3id.org/kim/edufeed/konfi/zielgruppen/konfis';
    vocabularyCache.set(KONFI_ZIELGRUPPEN_URI, {
      scheme: {
        id: KONFI_ZIELGRUPPEN_URI,
        type: 'ConceptScheme',
        title: { de: 'Zielgruppen' },
        hasTopConcept: []
      },
      concepts: new Map([
        [
          KONFI_ZIELGRUPPEN_ID,
          { id: KONFI_ZIELGRUPPEN_ID, type: 'Concept', prefLabel: { de: 'Konfis' } }
        ]
      ])
    });

    const html = `<html><head><title>Konfi-Stationen</title></head><body><p>Heiliger Geist</p></body></html>`;
    const llmClient = stubLlm(
      {
        name: 'Konfi-Stationen',
        konfiZielgruppen: [{ id: KONFI_ZIELGRUPPEN_ID }],
        bibleReferences: ['Apostelgeschichte 2,1-12'],
        plainLanguage: true,
        requiredMaterialsNote: 'Stifte, Plakate'
      },
      {
        name: 'Konfi-Stationen',
        konfiZielgruppen: 'für Konfis',
        bibleReferences: 'Pfingstgeschichte',
        requiredMaterialsNote: 'Stifte und Plakate werden benötigt'
      }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'konfi',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { konfiZielgruppen: KONFI_ZIELGRUPPEN_URI }
    });

    expect(result.payload.konfiZielgruppen).toEqual([
      { id: KONFI_ZIELGRUPPEN_ID, prefLabel: 'Konfis' }
    ]);
    expect(result.payload.bibleReferences).toEqual(['Apg 2,1-12']);
    expect(result.payload.plainLanguage).toBe(true);
    expect(result.payload.requiredMaterialsNote).toBe('Stifte, Plakate');
  });

  it('strips EKW school fields (schoolTypes, gradeLevels) under variant=konfi', async () => {
    // If the LLM hallucinates school-context fields in a Konfi extraction,
    // the variant schema strips them — Konfi pedagogy uses its own vocab
    // family, so leaking school fields would render in places the form
    // never displays.
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      {
        name: 'x',
        schoolTypes: [{ id: 'https://example.org/grundschule' }],
        gradeLevels: [{ id: 'https://example.org/q1' }],
        ekwFachrichtung: [{ id: 'https://example.org/evangelisch' }]
      },
      {
        name: 'n',
        schoolTypes: 'Grundschule',
        gradeLevels: 'Q1',
        ekwFachrichtung: 'evangelisch'
      }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'konfi',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.payload.schoolTypes).toBeUndefined();
    expect(result.payload.gradeLevels).toBeUndefined();
    expect(result.payload.ekwFachrichtung).toBeUndefined();
    expect(result.evidence.schoolTypes).toBeUndefined();
    expect(result.evidence.gradeLevels).toBeUndefined();
    expect(result.evidence.ekwFachrichtung).toBeUndefined();
  });
});

describe('extractMetadata — LLM output normalization', () => {
  // Anthropic models, when handed a loose tool input_schema, sometimes
  // serialize concept IDs as bare strings ("https://…/text") rather than
  // {id: "…"} objects, and sometimes return evidence as a JSON-encoded
  // string instead of a flat object. extractMetadata must accept both
  // shapes so the downstream form prefill survives those drifts.

  it('coerces bare-string concept IDs into {id} objects so vocab filter keeps them', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      // bare-string concept IDs (as observed from real Anthropic output)
      { name: 'x', learningResourceType: ['https://w3id.org/kim/hcrt/text'] },
      { name: 'n', learningResourceType: 'y' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/text', prefLabel: 'Text' }
    ]);
    expect(result.evidence.learningResourceType).toBe('y');
  });

  it('parses payload when the LLM returns it as a JSON-encoded string', async () => {
    // Mirror of the evidence-as-string drift: Anthropic models sometimes
    // serialize the entire `payload` tool argument as a JSON string. Without
    // normalization, downstream `Object.entries(payload)` iterates the chars
    // of the string, applyVariantSchema strips everything, payload comes out
    // empty.
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      // payload as a JSON string
      JSON.stringify({
        name: 'x',
        learningResourceType: ['https://w3id.org/kim/hcrt/text']
      }) as unknown as Record<string, unknown>,
      { name: 'evidence-for-name', learningResourceType: 'evidence-for-lrt' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.payload.name).toBe('x');
    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/text', prefLabel: 'Text' }
    ]);
    expect(result.evidence.name).toBe('evidence-for-name');
  });

  it('repairs malformed JSON-encoded payloads with unescaped typographic quotes', async () => {
    // Captured live from a German-language magazine PDF (rpi-konfi 1/2025):
    // Anthropic returned the payload as a JSON-encoded string whose body
    // contained a stray unescaped ASCII `"` after the German low-9 opener
    // (`„gegen Einsamkeit"`) — the closing curly-quote `"` was a straight
    // quote, prematurely terminating the JSON string. Strict JSON.parse
    // rejects this; a repair fallback must keep the payload intact.
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const broken =
      '{\n  "name": "DU BIST NICHT ALLEIN ALLEIN – Ein Baustein „gegen Einsamkeit" im Rahmen der Kampagne",\n  "description": "Ein Baustein für die Konfi-Arbeit."\n}';
    const llmClient = stubLlm(
      broken as unknown as Record<string, unknown>,
      { name: 'evidence-for-name' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.payload.name).toBe(
      'DU BIST NICHT ALLEIN ALLEIN – Ein Baustein „gegen Einsamkeit" im Rahmen der Kampagne'
    );
    expect(result.payload.description).toBe('Ein Baustein für die Konfi-Arbeit.');
    expect(result.evidence.name).toBe('evidence-for-name');
  });

  it('parses evidence when the LLM returns it as a JSON-encoded string', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      { name: 'x' },
      // evidence as a JSON string (as observed from real Anthropic output)
      JSON.stringify({ name: 'evidence-for-name' }) as unknown as Record<string, string>
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    expect(result.evidence.name).toBe('evidence-for-name');
  });
});

describe('extractMetadata — production LLM-output shape', () => {
  // Replays the exact shape captured live from /api/enrich against the
  // RPI Impulse PDF: bare-string concept IDs (HTTP-form for HCRT/EDU_LEVEL,
  // NIP-VOCAB `kind:pubkey:dtag` form for the NIP-VOCAB schemes), plus
  // evidence as a JSON-encoded string. The endpoint logged
  //   result.source= llm-enriched payload keys= [] evidence keys= []
  // so this test must currently fail.

  const HCRT_URI = 'https://w3id.org/kim/hcrt/scheme';
  const KLASSEN_URI = 'naddr-klassenstufen';
  const SCHULART_URI = 'naddr-schulart';

  const NIP_VOCAB_PUBKEY =
    'd2689e2f41dabfba953da26655a94ce2aa4e029c383ee921c6a4deafab99a612';

  const hcrtVocab: ParsedVocabulary = {
    scheme: { id: HCRT_URI, type: 'ConceptScheme', title: { de: 'HCRT' }, hasTopConcept: [] },
    concepts: new Map([
      [
        'https://w3id.org/kim/hcrt/worksheet',
        { id: 'https://w3id.org/kim/hcrt/worksheet', type: 'Concept', prefLabel: { de: 'Arbeitsblatt' } }
      ]
    ])
  };

  const klassenVocab: ParsedVocabulary = {
    scheme: { id: `39737:${NIP_VOCAB_PUBKEY}:klassenstufen`, type: 'ConceptScheme', title: { de: 'Klassenstufen' }, hasTopConcept: [] },
    concepts: new Map([
      [
        `39738:${NIP_VOCAB_PUBKEY}:1`,
        { id: `39738:${NIP_VOCAB_PUBKEY}:1`, type: 'Concept', prefLabel: { de: 'Jahrgang 1' } }
      ],
      [
        `39738:${NIP_VOCAB_PUBKEY}:2`,
        { id: `39738:${NIP_VOCAB_PUBKEY}:2`, type: 'Concept', prefLabel: { de: 'Jahrgang 2' } }
      ]
    ])
  };

  const schulartVocab: ParsedVocabulary = {
    scheme: { id: `39737:${NIP_VOCAB_PUBKEY}:schulart`, type: 'ConceptScheme', title: { de: 'Schulart' }, hasTopConcept: [] },
    concepts: new Map([
      [
        `39738:${NIP_VOCAB_PUBKEY}:grundschule`,
        { id: `39738:${NIP_VOCAB_PUBKEY}:grundschule`, type: 'Concept', prefLabel: { de: 'Grundschule' } }
      ]
    ])
  };

  it('keeps both HTTP-form and NIP-VOCAB-form concept IDs after filter+schema', async () => {
    vocabularyCache.set(HCRT_URI, hcrtVocab);
    vocabularyCache.set(KLASSEN_URI, klassenVocab);
    vocabularyCache.set(SCHULART_URI, schulartVocab);

    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;

    // Bare-string IDs and JSON-encoded evidence — the production drift.
    const llmClient = stubLlm(
      {
        learningResourceType: ['https://w3id.org/kim/hcrt/worksheet'],
        gradeLevels: [`39738:${NIP_VOCAB_PUBKEY}:1`, `39738:${NIP_VOCAB_PUBKEY}:2`],
        schoolTypes: [`39738:${NIP_VOCAB_PUBKEY}:grundschule`]
      },
      JSON.stringify({
        learningResourceType: 'M4 Rollenspiel',
        gradeLevels: 'Jahrgang 1 und 2',
        schoolTypes: 'GRUNDSCHULE'
      }) as unknown as Record<string, string>
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'ekw',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {
        learningResourceType: HCRT_URI,
        gradeLevels: KLASSEN_URI,
        schoolTypes: SCHULART_URI
      }
    });

    expect(result.source).toBe('llm-enriched');
    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/worksheet', prefLabel: 'Arbeitsblatt' }
    ]);
    expect(result.payload.gradeLevels).toEqual([
      { id: `39738:${NIP_VOCAB_PUBKEY}:1`, prefLabel: 'Jahrgang 1' },
      { id: `39738:${NIP_VOCAB_PUBKEY}:2`, prefLabel: 'Jahrgang 2' }
    ]);
    expect(result.payload.schoolTypes).toEqual([
      { id: `39738:${NIP_VOCAB_PUBKEY}:grundschule`, prefLabel: 'Grundschule' }
    ]);
    expect(result.evidence.learningResourceType).toBe('M4 Rollenspiel');
    expect(result.evidence.gradeLevels).toBe('Jahrgang 1 und 2');
    expect(result.evidence.schoolTypes).toBe('GRUNDSCHULE');
  });
});

describe('extractMetadata — canonical prefLabel enrichment', () => {
  // The server is the authority on labels: it has the SKOS vocab loaded, so
  // every concept it returns must carry the canonical prefLabel. This guards
  // against two failure modes:
  //   1. The LLM emits {id} with no prefLabel, or with a wrong one.
  //   2. The vocab fails to load — today's silent-skip-validation hatch
  //      let hallucinated IDs pass through unchecked.

  it('overwrites a wrong LLM-supplied prefLabel with the canonical one from the loaded vocab', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      {
        learningResourceType: [
          { id: 'https://w3id.org/kim/hcrt/text', prefLabel: 'wrong label' }
        ]
      },
      { learningResourceType: 'evidence' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/text', prefLabel: 'Text' }
    ]);
  });

  it('attaches the canonical prefLabel when the LLM omits it', async () => {
    const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
    const llmClient = stubLlm(
      { learningResourceType: [{ id: 'https://w3id.org/kim/hcrt/video' }] },
      { learningResourceType: 'evidence' }
    );

    const result = await extractMetadata({
      url: 'https://example.com/r',
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: { learningResourceType: LRT_URI }
    });

    expect(result.payload.learningResourceType).toEqual([
      { id: 'https://w3id.org/kim/hcrt/video', prefLabel: 'Video' }
    ]);
  });

  it('drops the entire field from the payload when its vocab fails to load', async () => {
    // Simulate "configured but failed to load" — global fetch rejects for
    // the vocab URI. Without the fix, filterByVocab silently skipped
    // validation for fields with empty id-sets and the LLM's hallucinations
    // passed through unchecked.
    const FAILING_URI = 'https://invalid-vocab.test/scheme';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: any) => {
        const u = typeof input === 'string' ? input : input?.url;
        if (typeof u === 'string' && u.includes('invalid-vocab.test')) {
          throw new Error('simulated network failure');
        }
        // Real fetch shouldn't run for any other URL in this test (page
        // fetch goes through `fetchFn`); fall back to a 404 just in case.
        return new Response('', { status: 404 });
      });

    try {
      const html = `<html><head><title>x</title></head><body><p>y</p></body></html>`;
      const llmClient = stubLlm(
        {
          learningResourceType: [
            { id: 'https://hallucinated.example/concept', prefLabel: 'Hallucinated' }
          ]
        },
        { learningResourceType: 'evidence' }
      );

      const result = await extractMetadata({
        url: 'https://example.com/r',
        variant: 'amb',
        fetchFn: fakeHtml(html),
        llmClient,
        skosSchemes: { learningResourceType: FAILING_URI }
      });

      expect(result.payload.learningResourceType).toBeUndefined();
      expect(result.evidence.learningResourceType).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('extractMetadata — multi-source concatenation', () => {
  /** Fake fetch that returns distinct body text per URL. */
  const fakeHtmlByUrl = async (input: string | URL): Promise<Response> => {
    const u = String(input);
    const body = u.includes('/a') ? 'ALPHA-CONTENT' : 'BETA-CONTENT';
    return new Response(
      `<html><head><title>doc</title></head><body><p>${body}</p></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  };

  it('merges multiple source pages into a single LLM call with provenance markers', async () => {
    const llmClient = stubLlm({ name: 'Combined' }, { name: 'ev' });

    const result = await extractMetadata({
      urls: ['https://example.com/a', 'https://example.com/b'],
      variant: 'amb',
      fetchFn: fakeHtmlByUrl,
      llmClient,
      skosSchemes: {}
    });

    expect(result.source).toBe('llm-enriched');
    expect(llmClient.messages.create).toHaveBeenCalledOnce();
    const sent = JSON.stringify(
      (llmClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    );
    expect(sent).toContain('ALPHA-CONTENT');
    expect(sent).toContain('BETA-CONTENT');
    expect(sent).toContain('Source 1');
    expect(sent).toContain('Source 2');
    expect(sent).toContain('https://example.com/a');
    expect(sent).toContain('https://example.com/b');
  });

  it('skips the AMB short-circuit for multiple sources even if the first has AMB JSON-LD', async () => {
    const ld = JSON.stringify({ '@type': ['LearningResource'], name: 'First doc' });
    const fetchFn = async (input: string | URL): Promise<Response> => {
      const u = String(input);
      const html = u.includes('/a')
        ? `<html><head><script type="application/ld+json">${ld}</script></head><body><p>A</p></body></html>`
        : `<html><head><title>doc</title></head><body><p>B</p></body></html>`;
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    };
    const llmClient = stubLlm({ name: 'Combined' }, { name: 'ev' });

    const result = await extractMetadata({
      urls: ['https://example.com/a', 'https://example.com/b'],
      variant: 'amb',
      fetchFn,
      llmClient,
      skosSchemes: {}
    });

    expect(result.source).toBe('llm-enriched');
    expect(llmClient.messages.create).toHaveBeenCalledOnce();
  });

  it('keeps single-URL behavior byte-for-byte (no provenance markers)', async () => {
    const html = `<html><head><title>solo</title></head><body><p>SOLO-CONTENT</p></body></html>`;
    const llmClient = stubLlm({ name: 'Solo' }, { name: 'ev' });

    await extractMetadata({
      urls: ['https://example.com/solo'],
      variant: 'amb',
      fetchFn: fakeHtml(html),
      llmClient,
      skosSchemes: {}
    });

    const sent = JSON.stringify(
      (llmClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
    );
    expect(sent).toContain('SOLO-CONTENT');
    expect(sent).not.toContain('Source 1');
  });
});

describe('extractMetadata — output shape', () => {
  it('passes extractMetadataResult zod validation in all three modes', async () => {
    const { extractMetadataResult } = await import('../../src/lib/schema.js');

    const ambHtml =
      `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': ['LearningResource'],
        name: 'L'
      })}</script></head><body><p>x</p></body></html>`;
    const ogHtml = `<html><head><meta property="og:title" content="t"></head><body><p>x</p></body></html>`;
    const llmHtml = `<html><head><title>t</title></head><body><p>x</p></body></html>`;

    const ambRes = await extractMetadata({
      url: 'https://example.com/a',
      variant: 'amb',
      fetchFn: fakeHtml(ambHtml)
    });
    const ogRes = await extractMetadata({
      url: 'https://example.com/o',
      variant: 'amb',
      fetchFn: fakeHtml(ogHtml)
    });
    const llmRes = await extractMetadata({
      url: 'https://example.com/l',
      variant: 'amb',
      fetchFn: fakeHtml(llmHtml),
      llmClient: stubLlm({ name: 't' }, { name: 'evidence' }),
      skosSchemes: {}
    });

    expect(extractMetadataResult.safeParse(ambRes).success).toBe(true);
    expect(extractMetadataResult.safeParse(ogRes).success).toBe(true);
    expect(extractMetadataResult.safeParse(llmRes).success).toBe(true);
  });
});
