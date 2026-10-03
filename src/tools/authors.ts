import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAuthorDirectory } from '../authors.js';
import { READ_ONLY } from './annotations.js';

/**
 * Register the list_known_authors tool
 */
export function registerAuthorTools(server: McpServer): void {
  server.registerTool(
    'list_known_authors',
    {
      title: 'List Known Authors',
      description:
        'List known educational resource authors loaded from configured follow sets (NIP-51 kind 30000). ' +
        'Returns author names, pubkeys, and NIP-05 identifiers. Use the returned pubkeys with ' +
        'search_resources(authors: [...]) to filter resources by author.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const directory = getAuthorDirectory();

      if (!directory) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'not_configured',
                message:
                  'No author sets configured. Set the AMB_AUTHOR_SETS environment variable to a comma-separated list of naddr identifiers for kind 30000 follow sets.',
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              totalAuthors: directory.authors.length,
              totalSets: directory.sets.length,
              authors: directory.authors.map((a) => ({
                pubkey: a.pubkey,
                name: a.name,
                nip05: a.nip05,
                about: a.about,
                sets: a.sets,
              })),
              sets: directory.sets,
            }),
          },
        ],
      };
    }
  );
}
