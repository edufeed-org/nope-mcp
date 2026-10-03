import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getVocabulary,
  getConcept,
  searchVocabulary,
  getLabel,
  flattenConcepts,
  DEFAULT_SEARCH_FIELDS,
  type SKOSConcept,
  type LocalizedString,
  type SearchField,
} from '../skos/index.js';
import { READ_ONLY } from './annotations.js';

/**
 * Format a concept for output
 */
function formatConcept(
  concept: SKOSConcept,
  language?: string
): Record<string, unknown> {
  return {
    id: concept.id,
    notation: concept.notation,
    prefLabel: language
      ? getLabel(concept.prefLabel, language)
      : concept.prefLabel,
    altLabel: concept.altLabel?.map((alt) =>
      language ? getLabel(alt, language) : alt
    ),
    definition: concept.definition
      ? language
        ? getLabel(concept.definition, language)
        : concept.definition
      : undefined,
    deprecated: concept.deprecated || undefined,
    broader: concept.broader?.map((b) =>
      typeof b === 'string'
        ? b
        : {
            id: b.id,
            prefLabel: language ? getLabel(b.prefLabel, language) : b.prefLabel,
          }
    ),
    narrower: concept.narrower?.map((n) =>
      typeof n === 'string'
        ? n
        : {
            id: n.id,
            prefLabel: language ? getLabel(n.prefLabel, language) : n.prefLabel,
          }
    ),
    related: concept.related?.map((r) =>
      typeof r === 'string'
        ? r
        : {
            id: r.id,
            prefLabel: language ? getLabel(r.prefLabel, language) : r.prefLabel,
          }
    ),
    exactMatch: concept.exactMatch,
    closeMatch: concept.closeMatch,
    broadMatch: concept.broadMatch,
    narrowMatch: concept.narrowMatch,
    relatedMatch: concept.relatedMatch,
  };
}

/**
 * Register the skos_get_vocabulary tool
 */
export function registerGetVocabularyTool(server: McpServer): void {
  server.registerTool(
    'skos_get_vocabulary',
    {
      title: 'Get SKOS Vocabulary',
      description:
        'Fetch and parse a SKOS vocabulary from its URI. Returns the concept scheme with all concepts organized hierarchically.',
      inputSchema: z.object({
        uri: z
          .string()
          .url()
          .describe(
            'URI of the SKOS vocabulary (e.g., "https://w3id.org/kim/hcrt/scheme")'
          ),
        language: z
          .string()
          .optional()
          .describe(
            'Preferred language for labels (e.g., "de", "en"). If not specified, all languages are returned.'
          ),
        flat: z
          .boolean()
          .optional()
          .describe(
            'If true, return a flat list of concepts instead of hierarchy. Default: false.'
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ uri, language, flat }) => {
      try {
        const vocabulary = await getVocabulary(uri);

        if (flat) {
          // Return flat list with depth indicators
          const flattened = flattenConcepts(vocabulary.scheme.hasTopConcept);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    scheme: {
                      id: vocabulary.scheme.id,
                      title: language
                        ? getLabel(vocabulary.scheme.title, language)
                        : vocabulary.scheme.title,
                      description: vocabulary.scheme.description
                        ? language
                          ? getLabel(vocabulary.scheme.description, language)
                          : vocabulary.scheme.description
                        : undefined,
                    },
                    conceptCount: vocabulary.concepts.size,
                    concepts: flattened.map(({ concept, depth }) => ({
                      depth,
                      ...formatConcept(concept, language),
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Return hierarchical structure
        const formatConceptTree = (concept: SKOSConcept): Record<string, unknown> => {
          const formatted = formatConcept(concept, language);
          if (concept.narrower) {
            formatted.narrower = concept.narrower
              .filter((n): n is SKOSConcept => typeof n !== 'string')
              .map(formatConceptTree);
          }
          return formatted;
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  scheme: {
                    id: vocabulary.scheme.id,
                    title: language
                      ? getLabel(vocabulary.scheme.title, language)
                      : vocabulary.scheme.title,
                    description: vocabulary.scheme.description
                      ? language
                        ? getLabel(vocabulary.scheme.description, language)
                        : vocabulary.scheme.description
                      : undefined,
                    issued: vocabulary.scheme.issued,
                    license: vocabulary.scheme.license,
                  },
                  conceptCount: vocabulary.concepts.size,
                  topConcepts: vocabulary.scheme.hasTopConcept.map(formatConceptTree),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to fetch vocabulary',
                message: error instanceof Error ? error.message : String(error),
                uri,
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register the skos_get_concept tool
 */
export function registerGetConceptTool(server: McpServer): void {
  server.registerTool(
    'skos_get_concept',
    {
      title: 'Get SKOS Concept',
      description:
        'Get details of a single SKOS concept by its URI, including broader, narrower, and related concepts.',
      inputSchema: z.object({
        uri: z
          .string()
          .url()
          .describe(
            'URI of the concept (e.g., "https://w3id.org/kim/hcrt/video")'
          ),
        language: z
          .string()
          .optional()
          .describe('Preferred language for labels (e.g., "de", "en")'),
      }),
      annotations: READ_ONLY,
    },
    async ({ uri, language }) => {
      try {
        const concept = await getConcept(uri);

        if (!concept) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Concept not found',
                  uri,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formatConcept(concept, language), null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to fetch concept',
                message: error instanceof Error ? error.message : String(error),
                uri,
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register the skos_search tool
 */
export function registerSearchConceptsTool(server: McpServer): void {
  server.registerTool(
    'skos_search',
    {
      title: 'Search SKOS Concepts',
      description:
        'Search for concepts in a SKOS vocabulary. By default searches prefLabel, altLabel, hiddenLabel, and definition.',
      inputSchema: z.object({
        vocabularyUri: z
          .string()
          .url()
          .describe(
            'URI of the vocabulary to search (e.g., "https://w3id.org/kim/hochschulfaechersystematik/scheme")'
          ),
        query: z.string().min(1).describe('Search query'),
        language: z
          .string()
          .optional()
          .describe(
            'Limit search to this language (e.g., "de"). If not specified, searches all languages.'
          ),
        fields: z
          .array(z.enum(['prefLabel', 'altLabel', 'hiddenLabel', 'definition', 'notation']))
          .optional()
          .describe(
            'Fields to search in. Default: ["prefLabel", "altLabel", "hiddenLabel", "definition"]'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of results (default: 20, max: 100)'),
      }),
      annotations: READ_ONLY,
    },
    async ({ vocabularyUri, query, language, fields, limit = 20 }) => {
      try {
        const results = await searchVocabulary(vocabularyUri, query, {
          language,
          fields: fields as SearchField[] | undefined,
          limit,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query,
                  vocabularyUri,
                  count: results.length,
                  results: results.map((concept) =>
                    formatConcept(concept, language)
                  ),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to search vocabulary',
                message: error instanceof Error ? error.message : String(error),
                vocabularyUri,
                query,
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register all SKOS tools
 */
export function registerSKOSTools(server: McpServer): void {
  registerGetVocabularyTool(server);
  registerGetConceptTool(server);
  registerSearchConceptsTool(server);
}
