/**
 * SKOS Vocabulary Builder MCP Tools
 *
 * Tools for creating SKOS vocabularies through conversation.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  vocabularyStore,
  createVocabulary,
  addConcept,
  setConceptRelationship,
  addConceptMapping,
  updateConcept,
  removeConcept,
  validateVocabulary,
  getVocabularyState,
  deleteVocabulary,
  serializeToTurtle,
  importTurtle,
} from '../skos/builder/index.js';
import { getLabel } from '../skos/parser.js';
import type { SKOSConcept } from '../skos/types.js';
import { READ_ONLY, SESSION_MUTATOR, SESSION_DESTRUCTIVE } from './annotations.js';

/**
 * Extract user pubkey from request context
 * Falls back to 'local' for stdio transport
 */
function getUserPubkey(extra: unknown): string {
  const authInfo = (extra as { authInfo?: { clientPubkey?: string } })?.authInfo;
  return authInfo?.clientPubkey ?? 'local';
}

/**
 * Localized string schema
 */
const localizedStringSchema = z
  .record(z.string())
  .describe('Localized strings by language code (e.g., {"de": "Text", "en": "Text"})');

/**
 * Format a concept for output
 */
function formatConcept(concept: SKOSConcept, language?: string): Record<string, unknown> {
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
    broader: concept.broader?.map((b) =>
      typeof b === 'string' ? b : { id: b.id, prefLabel: language ? getLabel(b.prefLabel, language) : b.prefLabel }
    ),
    narrower: concept.narrower?.map((n) =>
      typeof n === 'string' ? n : { id: n.id, prefLabel: language ? getLabel(n.prefLabel, language) : n.prefLabel }
    ),
    related: concept.related?.map((r) =>
      typeof r === 'string' ? r : { id: r.id, prefLabel: language ? getLabel(r.prefLabel, language) : r.prefLabel }
    ),
    exactMatch: concept.exactMatch,
    closeMatch: concept.closeMatch,
    broadMatch: concept.broadMatch,
    narrowMatch: concept.narrowMatch,
    relatedMatch: concept.relatedMatch,
  };
}

/**
 * Register skos_create_vocabulary tool
 */
function registerCreateVocabularyTool(server: McpServer): void {
  server.registerTool(
    'skos_create_vocabulary',
    {
      title: 'Create SKOS Vocabulary',
      description:
        'Start building a new SKOS vocabulary. Returns the scheme URI for use in subsequent operations.',
      inputSchema: {
        uri: z
          .string()
          .url()
          .describe('Base URI for the vocabulary (e.g., "https://example.org/vocab/my-vocab")'),
        title: localizedStringSchema.describe(
          'Vocabulary title by language (e.g., {"de": "Mein Vokabular", "en": "My Vocabulary"})'
        ),
        description: localizedStringSchema.optional().describe('Vocabulary description by language'),
        prefix: z
          .string()
          .optional()
          .describe('Preferred namespace prefix (e.g., "myvocab")'),
        license: z
          .string()
          .url()
          .optional()
          .describe('License URI (e.g., "https://creativecommons.org/licenses/by/4.0/")'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        const state = createVocabulary(userPubkey, {
          uri: params.uri,
          title: params.title,
          description: params.description,
          preferredNamespacePrefix: params.prefix,
          license: params.license,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Vocabulary created successfully',
                  schemeUri: state.scheme.id,
                  title: state.scheme.title,
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
                error: 'Failed to create vocabulary',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_add_concept tool
 */
function registerAddConceptTool(server: McpServer): void {
  server.registerTool(
    'skos_add_concept',
    {
      title: 'Add SKOS Concept',
      description:
        'Add a concept to a vocabulary being built. Optionally specify a parent to create hierarchy.',
      inputSchema: {
        schemeUri: z.string().url().describe('URI of the vocabulary to add to'),
        uri: z.string().url().describe('URI for this concept'),
        prefLabel: localizedStringSchema.describe('Preferred label by language'),
        definition: localizedStringSchema.optional().describe('Definition by language'),
        altLabel: z
          .array(localizedStringSchema)
          .optional()
          .describe('Alternative labels'),
        notation: z.array(z.string()).optional().describe('Notation codes'),
        broaderUri: z
          .string()
          .url()
          .optional()
          .describe('URI of parent concept (creates broader/narrower relationship)'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        const concept = addConcept(userPubkey, params.schemeUri, {
          uri: params.uri,
          prefLabel: params.prefLabel,
          definition: params.definition,
          altLabel: params.altLabel,
          notation: params.notation,
          broaderUri: params.broaderUri,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Concept added successfully',
                  concept: formatConcept(concept),
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
                error: 'Failed to add concept',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_set_relationship tool
 */
function registerSetRelationshipTool(server: McpServer): void {
  server.registerTool(
    'skos_set_relationship',
    {
      title: 'Set Concept Relationship',
      description:
        'Create a semantic relationship between two concepts in the vocabulary.',
      inputSchema: {
        schemeUri: z.string().url().describe('URI of the vocabulary'),
        sourceUri: z.string().url().describe('URI of the source concept'),
        targetUri: z.string().url().describe('URI of the target concept'),
        relationship: z
          .enum(['broader', 'narrower', 'related'])
          .describe('Type of relationship'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        setConceptRelationship(userPubkey, params.schemeUri, {
          sourceUri: params.sourceUri,
          targetUri: params.targetUri,
          relationship: params.relationship,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: `Relationship set: ${params.sourceUri} ${params.relationship} ${params.targetUri}`,
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
                error: 'Failed to set relationship',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_add_mapping tool
 */
function registerAddMappingTool(server: McpServer): void {
  server.registerTool(
    'skos_add_mapping',
    {
      title: 'Add Concept Mapping',
      description:
        'Add a mapping from a concept to an external vocabulary concept.',
      inputSchema: {
        schemeUri: z.string().url().describe('URI of the vocabulary'),
        conceptUri: z.string().url().describe('URI of concept in current vocabulary'),
        targetUri: z.string().url().describe('URI of concept in external vocabulary'),
        mappingType: z
          .enum(['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch'])
          .describe('Type of mapping'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        addConceptMapping(userPubkey, params.schemeUri, {
          conceptUri: params.conceptUri,
          targetUri: params.targetUri,
          mappingType: params.mappingType,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: `Mapping added: ${params.conceptUri} ${params.mappingType} ${params.targetUri}`,
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
                error: 'Failed to add mapping',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_update_concept tool
 */
function registerUpdateConceptTool(server: McpServer): void {
  server.registerTool(
    'skos_update_concept',
    {
      title: 'Update SKOS Concept',
      description: 'Update properties of an existing concept.',
      inputSchema: {
        schemeUri: z.string().url().describe('URI of the vocabulary'),
        conceptUri: z.string().url().describe('URI of the concept to update'),
        prefLabel: localizedStringSchema.optional().describe('New preferred labels'),
        definition: localizedStringSchema.optional().describe('New definition'),
        altLabel: z.array(localizedStringSchema).optional().describe('New alternative labels'),
        notation: z.array(z.string()).optional().describe('New notation codes'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        const concept = updateConcept(userPubkey, params.schemeUri, params.conceptUri, {
          prefLabel: params.prefLabel,
          definition: params.definition,
          altLabel: params.altLabel,
          notation: params.notation,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Concept updated successfully',
                  concept: formatConcept(concept),
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
                error: 'Failed to update concept',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_remove_concept tool
 */
function registerRemoveConceptTool(server: McpServer): void {
  server.registerTool(
    'skos_remove_concept',
    {
      title: 'Remove SKOS Concept',
      description: 'Remove a concept and all its relationships from the vocabulary.',
      inputSchema: {
        schemeUri: z.string().url().describe('URI of the vocabulary'),
        conceptUri: z.string().url().describe('URI of the concept to remove'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        const removed = removeConcept(userPubkey, params.schemeUri, params.conceptUri);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: removed,
                  message: removed
                    ? `Concept ${params.conceptUri} removed`
                    : `Concept ${params.conceptUri} not found`,
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
                error: 'Failed to remove concept',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_list_vocabularies tool
 */
function registerListVocabulariesTool(server: McpServer): void {
  server.registerTool(
    'skos_list_vocabularies',
    {
      title: 'List Vocabularies',
      description: 'List all vocabularies currently being built in this session.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async (_params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        const vocabularies = vocabularyStore.list(userPubkey);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: vocabularies.length,
                  vocabularies: vocabularies.map((v) => ({
                    uri: v.uri,
                    title: v.title,
                    conceptCount: v.conceptCount,
                    createdAt: new Date(v.createdAt).toISOString(),
                    modifiedAt: new Date(v.modifiedAt).toISOString(),
                  })),
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
                error: 'Failed to list vocabularies',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_get_vocabulary_status tool
 */
function registerGetVocabularyStatusTool(server: McpServer): void {
  server.registerTool(
    'skos_get_vocabulary_status',
    {
      title: 'Get Vocabulary Status',
      description:
        'Get the current state of a vocabulary being built, including validation status.',
      inputSchema: {
        schemeUri: z.string().url().describe('URI of the vocabulary'),
        includeHierarchy: z
          .boolean()
          .optional()
          .describe('Include concept hierarchy tree (default: true)'),
        language: z
          .string()
          .optional()
          .describe('Preferred language for labels (e.g., "de", "en")'),
      },
      annotations: READ_ONLY,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);
        const includeHierarchy = params.includeHierarchy ?? true;

        const state = getVocabularyState(userPubkey, params.schemeUri);
        if (!state) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Vocabulary not found',
                  schemeUri: params.schemeUri,
                }),
              },
            ],
          };
        }

        const validation = validateVocabulary(userPubkey, params.schemeUri);

        const result: Record<string, unknown> = {
          scheme: {
            id: state.scheme.id,
            title: params.language
              ? getLabel(state.scheme.title, params.language)
              : state.scheme.title,
            description: state.scheme.description
              ? params.language
                ? getLabel(state.scheme.description, params.language)
                : state.scheme.description
              : undefined,
            license: state.scheme.license,
          },
          createdAt: new Date(state.createdAt).toISOString(),
          modifiedAt: new Date(state.modifiedAt).toISOString(),
          validation,
        };

        if (includeHierarchy) {
          // Build hierarchy from top concepts
          const buildTree = (concept: SKOSConcept): Record<string, unknown> => {
            const node: Record<string, unknown> = formatConcept(concept, params.language);
            if (concept.narrower && concept.narrower.length > 0) {
              node.children = concept.narrower
                .map((n) => {
                  const narrowerId = typeof n === 'string' ? n : n.id;
                  const narrowerConcept = state.concepts.get(narrowerId);
                  return narrowerConcept ? buildTree(narrowerConcept) : null;
                })
                .filter(Boolean);
            }
            return node;
          };

          result.topConcepts = state.scheme.hasTopConcept.map((tc) => {
            const concept = state.concepts.get(tc.id);
            return concept ? buildTree(concept) : { id: tc.id, error: 'not found' };
          });
        } else {
          result.concepts = Array.from(state.concepts.values()).map((c) =>
            formatConcept(c, params.language)
          );
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Failed to get vocabulary status',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_export_turtle tool
 */
function registerExportTurtleTool(server: McpServer): void {
  server.registerTool(
    'skos_export_turtle',
    {
      title: 'Export Vocabulary as Turtle',
      description:
        'Export the vocabulary as Turtle (.ttl) format. Validates before export.',
      inputSchema: {
        schemeUri: z.string().url().describe('URI of the vocabulary to export'),
        validateFirst: z
          .boolean()
          .optional()
          .describe('Run validation before export (default: true)'),
      },
      annotations: READ_ONLY,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);
        const validateFirst = params.validateFirst ?? true;

        const state = getVocabularyState(userPubkey, params.schemeUri);
        if (!state) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Vocabulary not found',
                  schemeUri: params.schemeUri,
                }),
              },
            ],
          };
        }

        // Validate if requested
        if (validateFirst) {
          const validation = validateVocabulary(userPubkey, params.schemeUri);
          if (!validation.valid) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      error: 'Validation failed',
                      message: 'Fix validation errors before exporting',
                      validation,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        const turtle = serializeToTurtle(state);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  schemeUri: params.schemeUri,
                  format: 'text/turtle',
                  turtle,
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
                error: 'Failed to export vocabulary',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_delete_vocabulary tool
 */
function registerDeleteVocabularyTool(server: McpServer): void {
  server.registerTool(
    'skos_delete_vocabulary',
    {
      title: 'Delete Vocabulary',
      description: 'Delete a vocabulary being built from session memory.',
      inputSchema: {
        schemeUri: z.string().url().describe('URI of the vocabulary to delete'),
      },
      annotations: SESSION_DESTRUCTIVE,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        const deleted = deleteVocabulary(userPubkey, params.schemeUri);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: deleted,
                  message: deleted
                    ? `Vocabulary ${params.schemeUri} deleted`
                    : `Vocabulary ${params.schemeUri} not found`,
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
                error: 'Failed to delete vocabulary',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register skos_import_turtle tool
 */
function registerImportTurtleTool(server: McpServer): void {
  server.registerTool(
    'skos_import_turtle',
    {
      title: 'Import Vocabulary from Turtle',
      description:
        'Import a SKOS vocabulary from Turtle format into the builder session for editing.',
      inputSchema: {
        turtle: z.string().describe('Turtle content to import'),
      },
      annotations: SESSION_MUTATOR,
    },
    async (params, extra) => {
      try {
        const userPubkey = getUserPubkey(extra);

        const result = importTurtle(params.turtle, userPubkey);

        if (!result.success || !result.state) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'Failed to parse Turtle',
                  message: result.error || 'Unknown error',
                }),
              },
            ],
          };
        }

        // Store the imported vocabulary
        vocabularyStore.set(userPubkey, result.state.scheme.id, result.state);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: 'Vocabulary imported successfully',
                  schemeUri: result.state.scheme.id,
                  title: result.state.scheme.title,
                  conceptCount: result.state.concepts.size,
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
                error: 'Failed to import vocabulary',
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Register all SKOS builder tools
 */
export function registerSKOSBuilderTools(server: McpServer): void {
  registerCreateVocabularyTool(server);
  registerAddConceptTool(server);
  registerSetRelationshipTool(server);
  registerAddMappingTool(server);
  registerUpdateConceptTool(server);
  registerRemoveConceptTool(server);
  registerListVocabulariesTool(server);
  registerGetVocabularyStatusTool(server);
  registerExportTurtleTool(server);
  registerDeleteVocabularyTool(server);
  registerImportTurtleTool(server);
}
