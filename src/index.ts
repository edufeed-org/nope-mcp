#!/usr/bin/env bun
/**
 * nope-mcp (formerly amb-mcp) - Nostr/ContextVM Transport
 *
 * A ContextVM-compliant MCP server for querying AMB (Educational Metadata)
 * resources from a Nostr relay.
 */

import { secretKeyHex } from './utils/secretKey.js';
import { withPublishDeadline } from './transport/publishDeadline.js';
import { McpServer } from '@modelcontextprotocol/server';
import {
  NostrServerTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
  EncryptionMode,
  GiftWrapMode,
} from '@contextvm/sdk';

import { AMBRelayClient } from './relay/client.js';
import { startRulesRefresh } from './search/rulesStore.js';
import { registerTools, nostrToolProfile } from './tools/index.js';
import { limitToolCalls, parseMaxConcurrent } from './tools/concurrency.js';
import { registerResources } from './resources/index.js';
import { loadAuthorSets, setAuthorDirectory, setCalendarAuthorDirectory } from './authors.js';
import { SERVER_NAME, SERVER_VERSION, buildServerInstructions } from './server-info.js';
import { IndexerClient } from './indexer/client.js';
import { parseLicenseFilterMax } from './license/classify.js';

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
// Unset → undefined (no default): find_community stays unregistered.
const COMMUNITY_RELAYS = process.env.COMMUNITY_RELAYS?.split(',').filter(Boolean);
const indexer = IndexerClient.fromEnv(process.env.INDEXER_ENDPOINTS, process.env.INDEXER_API_TOKEN, process.env.INDEXER_API_TOKENS);
const LICENSE_FILTER_MAX = parseLicenseFilterMax(process.env);

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
  if (COMMUNITY_RELAYS?.length) console.log(`Community Relays: ${COMMUNITY_RELAYS.join(', ')}`);
  console.log(`ContextVM Relays: ${RELAYS.join(', ')}`);

  // Initialize AMB relay client
  const ambClient = new AMBRelayClient(AMB_RELAYS, { extraRelays: AMB_EXTRA_RELAYS });

  // Initialize calendar relay client
  const calendarClient = new AMBRelayClient(CALENDAR_RELAYS);

  // Spell relay client (kind-777 spells + kind-3 contact lists for search_passages)
  const spellClient = new AMBRelayClient(SPELL_RELAYS);

  // Community relay client (COMMUNITY_RELAYS, optional); unset → find_community absent
  const communityClient = COMMUNITY_RELAYS?.length ? new AMBRelayClient(COMMUNITY_RELAYS) : undefined;

  // Create MCP server
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildServerInstructions({ licenseFilterMax: LICENSE_FILTER_MAX }) },
  );

  // Anyone with a key can call this entry, and one search fans out to several relays.
  limitToolCalls(server, parseMaxConcurrent(process.env));

  // Register tools and resources
  registerTools(server, ambClient, calendarClient, nostrToolProfile(process.env), {
    spellClient,
    indexer: indexer ?? undefined,
    licenseFilterMax: LICENSE_FILTER_MAX,
    communityClient,
  });
  registerResources(server, ambClient);

  // Search rules shared with the relays (kind-30078 event); unset = built-in rules.
  startRulesRefresh(process.env.SEARCH_RULES, AMB_RELAYS);

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
  const signer = new PrivateKeySigner(secretKeyHex(SERVER_PRIVATE_KEY));
  const relayPool = new (withPublishDeadline(ApplesauceRelayPool, 15_000))(RELAYS);
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
    // The SDK would publish a kind-10002 relay list to public bootstrap relays
    // by default. This server is found by its configured pubkey, not announced.
    publishRelayList: false,
    encryptionMode: EncryptionMode.OPTIONAL,
    // Encrypted traffic as ephemeral gift wraps (kind 21059): a transport relay stores nothing.
    giftWrapMode: GiftWrapMode.EPHEMERAL,
    injectClientPubkey: true,
  });

  // Connect and run
  await server.connect(transport);
  console.log('✓ nope-mcp running');
  console.log('Press Ctrl+C to stop');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    ambClient.close();
    calendarClient.close();
    spellClient.close();
    communityClient?.close();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    ambClient.close();
    calendarClient.close();
    spellClient.close();
    communityClient?.close();
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
