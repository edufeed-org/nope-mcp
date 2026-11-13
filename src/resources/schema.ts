import type { McpServer } from '@modelcontextprotocol/server';

/**
 * AMB Schema resource - provides the JSON-LD schema for educational resources
 */
export function registerSchemaResource(server: McpServer): void {
  server.registerResource(
    'AMB Schema',
    'amb://schema',
    {
      description:
        'The AMB (Allgemeines Metadatenprofil für Bildungsressourcen) JSON-LD schema for educational resources. Describes the structure and vocabulary used in educational metadata.',
      mimeType: 'application/json',
    },
    async () => {
      const schema = {
        '@context': [
          'https://schema.org/',
          'https://w3id.org/kim/lrmi-profile/draft/context.jsonld',
          { '@language': 'de' },
        ],
        description:
          'AMB (Allgemeines Metadatenprofil für Bildungsressourcen) is a German application profile for describing educational resources, based on LRMI (Learning Resource Metadata Initiative) and schema.org.',
        specification: 'https://dini-ag-kim.github.io/amb/latest/',
        requiredFields: ['id', 'type', 'name'],
        fields: {
          id: {
            type: 'string',
            description: 'Unique identifier (URI) for the resource',
          },
          type: {
            type: 'array',
            description: 'Resource types, must include "LearningResource"',
            example: ['LearningResource', 'VideoObject'],
          },
          name: {
            type: 'string',
            description: 'Title of the educational resource',
          },
          description: {
            type: 'string',
            description: 'Description of the resource',
          },
          creator: {
            type: 'array',
            description: 'Authors/creators of the resource',
            itemType: 'Person | Organization',
          },
          publisher: {
            type: 'array',
            description: 'Publishers of the resource',
            itemType: 'Person | Organization',
          },
          about: {
            type: 'array',
            description: 'Subjects/topics from controlled vocabularies',
            itemType: 'Concept',
            vocabularies: [
              'https://w3id.org/kim/schulfaecher/',
              'https://w3id.org/kim/hochschulfaechersystematik/',
            ],
          },
          learningResourceType: {
            type: 'array',
            description: 'Type of learning resource',
            itemType: 'Concept',
            vocabulary: 'https://w3id.org/kim/hcrt/',
          },
          educationalLevel: {
            type: 'array',
            description: 'Target educational level',
            itemType: 'Concept',
            vocabulary: 'https://w3id.org/kim/educationalLevel/',
          },
          inLanguage: {
            type: 'array',
            description: 'Languages of the resource (ISO 639-1 codes)',
          },
          license: {
            type: 'object',
            description: 'License information',
            properties: {
              id: 'License URI',
              name: 'License name',
            },
          },
          isAccessibleForFree: {
            type: 'boolean',
            description: 'Whether the resource is freely accessible',
          },
          datePublished: {
            type: 'string',
            description: 'Publication date (ISO 8601)',
          },
        },
        nostrIntegration: {
          eventKind: 30142,
          description: 'AMB resources are stored as Nostr kind 30142 events',
          contentFormat: 'JSON-LD AMB document stored in event.content',
          tags: {
            d: 'Resource identifier (required for addressable events)',
            t: 'Keywords/hashtags',
            r: 'External reference URLs',
            p: 'Nostr pubkeys of creators/contributors',
            a: 'References to related AMB resources',
          },
        },
      };

      return {
        contents: [
          {
            uri: 'amb://schema',
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      };
    }
  );
}
