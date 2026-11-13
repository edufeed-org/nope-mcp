import type { McpServer } from '@modelcontextprotocol/server';
import type { AMBRelayClient } from '../relay/client.js';
import { registerSchemaResource } from './schema.js';
import {
  registerSubjectsVocabularyResource,
  registerResourceTypesVocabularyResource,
  registerEducationalLevelsVocabularyResource,
} from './vocabularies.js';
import { registerRelayInfoResource } from './relay-info.js';

/**
 * Register all MCP resources with the server
 */
export function registerResources(
  server: McpServer,
  client: AMBRelayClient
): void {
  registerSchemaResource(server);
  registerSubjectsVocabularyResource(server);
  registerResourceTypesVocabularyResource(server);
  registerEducationalLevelsVocabularyResource(server);
  registerRelayInfoResource(server, client);
}
