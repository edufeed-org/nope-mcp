import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { eventsToAMBResources } from '../utils/transform.js';
import type { LocalizedString } from 'amb-nostr-converter';
import { getLabel } from '../skos/parser.js';
import { READ_ONLY } from './annotations.js';

interface VocabularyItem {
  id: string;
  prefLabel: LocalizedString | undefined;
  count: number;
}

/**
 * Extract and aggregate vocabulary items from resources
 */
function aggregateVocabulary(
  resources: ReturnType<typeof eventsToAMBResources>,
  extractor: (r: ReturnType<typeof eventsToAMBResources>[0]['resource']) => Array<{ id: string; prefLabel?: LocalizedString }> | undefined
): VocabularyItem[] {
  const counts = new Map<string, { id: string; prefLabel: LocalizedString | undefined; count: number }>();

  for (const { resource } of resources) {
    const items = extractor(resource);
    if (!items) continue;

    for (const item of items) {
      const existing = counts.get(item.id);
      if (existing) {
        existing.count++;
      } else {
        counts.set(item.id, {
          id: item.id,
          prefLabel: item.prefLabel,
          count: 1,
        });
      }
    }
  }

  return Array.from(counts.values()).sort((a, b) => b.count - a.count);
}

/**
 * Register browse_subjects tool
 */
export function registerBrowseSubjectsTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'browse_subjects',
    {
      title: 'Browse Subjects',
      description:
        'List available subjects/topics in the educational resource collection. Returns subjects with their labels and resource counts.',
      inputSchema: {
        prefix: z
          .string()
          .optional()
          .describe('Filter subjects whose label starts with this prefix'),
        language: z
          .string()
          .optional()
          .default('de')
          .describe('Language for labels (default: "de")'),
        limit: z
          .number()
          .min(1)
          .max(250)
          .optional()
          .default(50)
          .describe('Maximum number of subjects to return'),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      // Query a sample of resources to extract subjects
      const events = await client.query({ limit: 250 });
      const resources = eventsToAMBResources(events);

      let subjects = aggregateVocabulary(resources, r => r.about);

      // Apply prefix filter if provided
      if (params.prefix) {
        const lang = params.language || 'de';
        const prefix = params.prefix.toLowerCase();
        subjects = subjects.filter(s => {
          const label = s.prefLabel?.[lang]?.toLowerCase();
          return label?.startsWith(prefix);
        });
      }

      // Apply limit
      subjects = subjects.slice(0, params.limit);

      const lang = params.language || 'de';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: subjects.length,
              subjects: subjects.map(s => ({
                id: s.id,
                label: getLabel(s.prefLabel, lang) || s.id,
                count: s.count,
              })),
            }),
          },
        ],
      };
    }
  );
}

/**
 * Register browse_resource_types tool
 */
export function registerBrowseResourceTypesTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'browse_resource_types',
    {
      title: 'Browse Resource Types',
      description:
        'List available learning resource types (Video, Course, Worksheet, etc.) with resource counts.',
      inputSchema: {
        language: z
          .string()
          .optional()
          .default('de')
          .describe('Language for labels (default: "de")'),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .default(50)
          .describe('Maximum number of resource types to return'),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      const events = await client.query({ limit: 250 });
      const resources = eventsToAMBResources(events);

      const resourceTypes = aggregateVocabulary(resources, r => r.learningResourceType);

      const lang = params.language || 'de';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: resourceTypes.length,
              resourceTypes: resourceTypes.slice(0, params.limit).map(t => ({
                id: t.id,
                label: getLabel(t.prefLabel, lang) || t.id,
                count: t.count,
              })),
            }),
          },
        ],
      };
    }
  );
}

/**
 * Register browse_educational_levels tool
 */
export function registerBrowseEducationalLevelsTool(server: McpServer, client: AMBRelayClient): void {
  server.registerTool(
    'browse_educational_levels',
    {
      title: 'Browse Educational Levels',
      description:
        'List available educational levels (Primary, Secondary, Higher Education, etc.) with resource counts.',
      inputSchema: {
        language: z
          .string()
          .optional()
          .default('de')
          .describe('Language for labels (default: "de")'),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .default(50)
          .describe('Maximum number of levels to return'),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      const events = await client.query({ limit: 250 });
      const resources = eventsToAMBResources(events);

      const levels = aggregateVocabulary(resources, r => r.educationalLevel);

      const lang = params.language || 'de';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: levels.length,
              educationalLevels: levels.slice(0, params.limit).map(l => ({
                id: l.id,
                label: getLabel(l.prefLabel, lang) || l.id,
                count: l.count,
              })),
            }),
          },
        ],
      };
    }
  );
}
