#!/usr/bin/env bun
/**
 * nope-mcp (formerly amb-mcp) - Nostr/ContextVM Transport
 *
 * A ContextVM-compliant MCP server for querying AMB (Educational Metadata)
 * resources from a Nostr relay.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  NostrServerTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
  EncryptionMode,
} from '@contextvm/sdk';

import { AMBRelayClient } from './relay/client.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { loadAuthorSets, setAuthorDirectory, setCalendarAuthorDirectory } from './authors.js';
import { SERVER_NAME, SERVER_VERSION, SERVER_INSTRUCTIONS } from './server-info.js';
import { IndexerClient } from './indexer/client.js';
import { parseOpenLicensesOnly } from './license/open.js';

// Configuration from environment
const AMB_RELAYS = process.env.AMB_RELAYS?.split(',') || ['wss://relay.edufeed.org'];
const AMB_EXTRA_RELAYS = process.env.AMB_EXTRA_RELAYS?.split(',').filter(Boolean) || [];
const AMB_AUTHOR_SETS = process.env.AMB_AUTHOR_SETS?.split(',').filter(Boolean) || [];
const CALENDAR_RELAYS = process.env.CALENDAR_RELAYS?.split(',').filter(Boolean) || ['wss://relay.edufeed.org'];
const CALENDAR_AUTHOR_SETS = process.env.CALENDAR_AUTHOR_SETS?.split(',').filter(Boolean) || [];
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY;
const RELAYS = process.env.RELAYS?.split(',') || [
  'wss://relay.contextvm.org',
  'wss://cvm.otherstuff.ai',
];
const SPELL_RELAYS = process.env.SPELL_RELAYS?.split(',').filter(Boolean) || ['wss://relay.edufeed.org'];
const indexer = IndexerClient.fromEnv(process.env.INDEXER_ENDPOINTS, process.env.INDEXER_API_TOKEN, process.env.INDEXER_API_TOKENS);
const OPEN_LICENSES_ONLY = parseOpenLicensesOnly(process.env.OPEN_LICENSES_ONLY);

async function main() {
  // Validate required configuration
  if (!SERVER_PRIVATE_KEY) {
    console.error('ERROR: SERVER_PRIVATE_KEY environment variable is required');
    console.error('Generate one with: npx nostr-tools generate-key');
    process.exit(1);
  }

  console.log('Starting nope-mcp...');
  console.log(`AMB Relays: ${AMB_RELAYS.join(', ')}`);
  if (AMB_EXTRA_RELAYS.length) console.log(`AMB Extra Relays: ${AMB_EXTRA_RELAYS.join(', ')}`);
  console.log(`Calendar Relays: ${CALENDAR_RELAYS.join(', ')}`);
  console.log(`ContextVM Relays: ${RELAYS.join(', ')}`);

  // Initialize AMB relay client
  const ambClient = new AMBRelayClient(AMB_RELAYS, { extraRelays: AMB_EXTRA_RELAYS });

  // Initialize calendar relay client
  const calendarClient = new AMBRelayClient(CALENDAR_RELAYS);

  // Spell relay client (kind-777 spells + kind-3 contact lists for search_passages)
  const spellClient = new AMBRelayClient(SPELL_RELAYS);

  // Create MCP server
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Register tools and resources
  registerTools(server, ambClient, calendarClient, { read: true, extract: true, write: true }, {
    spellClient,
    indexer: indexer ?? undefined,
    openLicensesOnly: OPEN_LICENSES_ONLY,
  });
  registerResources(server, ambClient);

  // Load known authors from follow sets if configured
  if (AMB_AUTHOR_SETS.length > 0) {
    console.log(`Loading author sets from ${AMB_AUTHOR_SETS.length} naddr(s)...`);
    try {
      const directory = await loadAuthorSets(AMB_AUTHOR_SETS, AMB_RELAYS);
      setAuthorDirectory(directory);
      console.log(`Loaded ${directory.authors.length} authors from ${directory.sets.length} set(s)`);
    } catch (error) {
      console.error('Failed to load author sets:', error);
    }
  }

  // Load calendar authors from follow sets if configured
  if (CALENDAR_AUTHOR_SETS.length > 0) {
    console.log(`Loading calendar author sets from ${CALENDAR_AUTHOR_SETS.length} naddr(s)...`);
    try {
      const directory = await loadAuthorSets(CALENDAR_AUTHOR_SETS, CALENDAR_RELAYS);
      setCalendarAuthorDirectory(directory);
      console.log(`Loaded ${directory.authors.length} calendar authors from ${directory.sets.length} set(s)`);
    } catch (error) {
      console.error('Failed to load calendar author sets:', error);
    }
  }

  // Set up ContextVM transport
  const signer = new PrivateKeySigner(SERVER_PRIVATE_KEY);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();

  console.log(`Server Public Key: ${serverPubkey}`);

  const transport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    serverInfo: {
      name: 'nope-mcp',
      about: 'Query educational resources (AMB metadata) from Nostr relays. Supports full-text search and filtering by subject, resource type, educational level, and more.',
    },
    isPublicServer: false,
    encryptionMode: EncryptionMode.OPTIONAL,
    injectClientPubkey: true,
  });

  // Connect and run
  await server.connect(transport);
  console.log('✓ nope-mcp running');
  console.log('');
  console.log('Available tools:');
  console.log('  - search_resources: Search for educational resources');
  console.log('  - get_resource: Get a single resource by identifier');
  console.log('  - browse_subjects: List available subjects');
  console.log('  - browse_resource_types: List resource types');
  console.log('  - browse_educational_levels: List educational levels');
  console.log('  - relay_stats: Get relay information');
  console.log('  - list_relays: List configured relays');
  console.log('  - add_relay: Add a relay at runtime');
  console.log('  - remove_relay: Remove a relay at runtime');
  console.log('');
  console.log('Press Ctrl+C to stop');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    ambClient.close();
    calendarClient.close();
    spellClient.close();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    ambClient.close();
    calendarClient.close();
    spellClient.close();
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
