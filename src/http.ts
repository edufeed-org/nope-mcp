#!/usr/bin/env node
/**
 * nope-mcp (formerly amb-mcp) - Streamable HTTP Transport
 *
 * Third entry point alongside `src/index.ts` (Nostr/ContextVM) and
 * `src/stdio.ts` (stdio). Mounts MCP at `/mcp` so web-based MCP clients
 * (Claude.ai connectors, MCP Inspector, custom browser apps) can connect.
 */

import { fileURLToPath } from 'node:url';
import {
  loadAuthorSets,
  setAuthorDirectory,
  setCalendarAuthorDirectory,
} from './authors.js';
import { startHttpServer, SessionConfigError } from './transport/http.js';
import { createJwtVerifier } from './transport/auth.js';
import { buildSessionServer } from './session.js';
import {
  buildRelayCatalog,
  parseRelayNames,
  UnknownRelayNameError,
} from './relay/catalog.js';
import { SERVER_NAME, SERVER_VERSION } from './server-info.js';
import type { ToolProfile } from './tools/index.js';
import { AMBRelayClient } from './relay/client.js';
import { IndexerClient } from './indexer/client.js';
import { parseOpenLicensesOnly } from './license/open.js';

// Deliberate deviation: insufficient scope yields a session built WITHOUT those tools
// (absent from tools/list; a call returns MCP method-not-found) rather than HTTP 403.
export function scopesToProfile(scopes: string[]): ToolProfile {
  return {
    read: scopes.includes('mcp:read'),
    extract: scopes.includes('mcp:extract'),
    write: false, // write/signing tools are never exposed over HTTP
  };
}

/**
 * Decide a session's relay split from the URL its connector was added with.
 *
 * `?relays=sodix,oersi` makes exactly those relays the session's default set
 * (searched on every query) and demotes the rest of the deployment's relays
 * to extras (still selectable per call). Clients like Claude.ai only offer a
 * name and a URL field, so the URL is the only place to express this.
 *
 * Names resolve through the catalog of relays this deployment already serves;
 * an arbitrary URL is refused, so the endpoint never becomes an open
 * WebSocket proxy. Anything unresolvable fails the connection loudly rather
 * than silently falling back to the server default, which would leave the
 * user searching a corpus they did not ask for.
 */
export function resolveSessionRelays(
  query: URLSearchParams,
  config: { defaults: string[]; extras: string[] },
): { defaults: string[]; extras: string[]; fromConnectorUrl: boolean } {
  const raw = query.get('relays');
  if (raw === null) {
    return { ...config, fromConnectorUrl: false };
  }

  const catalog = buildRelayCatalog([...config.defaults, ...config.extras]);
  const names = parseRelayNames(raw);
  if (names.length === 0) {
    throw new SessionConfigError(
      'The relays parameter names no relays.',
      { knownNames: catalog.knownNames() },
    );
  }

  let defaults: string[];
  try {
    defaults = catalog.resolve(names);
  } catch (err) {
    if (err instanceof UnknownRelayNameError) {
      throw new SessionConfigError(err.message, {
        unknownNames: err.unknownNames,
        knownNames: err.knownNames,
      });
    }
    throw err;
  }

  return {
    defaults,
    extras: catalog.entries()
      .map((entry) => entry.url)
      .filter((url) => !defaults.includes(url)),
    fromConnectorUrl: true,
  };
}

// Configuration from environment
const AMB_RELAYS = process.env.AMB_RELAYS?.split(',') || ['wss://relay.edufeed.org'];
const AMB_EXTRA_RELAYS = process.env.AMB_EXTRA_RELAYS?.split(',').filter(Boolean) || [];
const AMB_AUTHOR_SETS = process.env.AMB_AUTHOR_SETS?.split(',').filter(Boolean) || [];
const CALENDAR_RELAYS =
  process.env.CALENDAR_RELAYS?.split(',').filter(Boolean) || ['wss://relay.edufeed.org'];
const CALENDAR_AUTHOR_SETS =
  process.env.CALENDAR_AUTHOR_SETS?.split(',').filter(Boolean) || [];
const SPELL_RELAYS = process.env.SPELL_RELAYS?.split(',').filter(Boolean) || ['wss://relay.edufeed.org'];
const indexer = IndexerClient.fromEnv(process.env.INDEXER_ENDPOINTS, process.env.INDEXER_API_TOKEN, process.env.INDEXER_API_TOKENS);
const OPEN_LICENSES_ONLY = parseOpenLicensesOnly(process.env.OPEN_LICENSES_ONLY);

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000);
const HTTP_HOST = process.env.HTTP_HOST ?? '0.0.0.0';
const OAUTH_ISSUER = process.env.OAUTH_ISSUER || 'https://auth.edufeed.org/realms/edufeed';
// Comma-separated; a token whose aud contains ANY of these is accepted.
// `amb-mcp` stays accepted: Keycloak still issues it (edufeed-app, claude.ai).
const OAUTH_AUDIENCE = (process.env.OAUTH_AUDIENCE || 'nope-mcp,amb-mcp')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OAUTH_JWKS_URI =
  process.env.OAUTH_JWKS_URI || `${OAUTH_ISSUER}/protocol/openid-connect/certs`;
// Fallback PRM resource for hosts outside HTTP_ALLOWED_HOSTS; allowed hosts
// (or any host, when the list is unset) get a resource derived per request.
const OAUTH_RESOURCE_URL =
  process.env.OAUTH_RESOURCE_URL || 'https://mcp.amb.edufeed.org/mcp';
const HTTP_ALLOWED_HOSTS = process.env.HTTP_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean);
const HTTP_ALLOWED_ORIGINS = process.env.HTTP_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  console.log('Starting nope-mcp (HTTP mode)...');
  console.log(`AMB Relays: ${AMB_RELAYS.join(', ')}`);
  if (AMB_EXTRA_RELAYS.length) console.log(`AMB Extra Relays: ${AMB_EXTRA_RELAYS.join(', ')}`);
  console.log(`Calendar Relays: ${CALENDAR_RELAYS.join(', ')}`);
  console.log(`HTTP bind: ${HTTP_HOST}:${HTTP_PORT}`);
  console.log(`Auth: OAuth (issuer ${OAUTH_ISSUER}, audience ${OAUTH_AUDIENCE.join(' | ')})`);
  if (HTTP_ALLOWED_HOSTS?.length) console.log(`Allowed hosts: ${HTTP_ALLOWED_HOSTS.join(', ')}`);
  if (HTTP_ALLOWED_ORIGINS?.length) console.log(`Allowed origins: ${HTTP_ALLOWED_ORIGINS.join(', ')}`);

  // Load author sets once at startup; setAuthorDirectory mutates module
  // state shared across all sessions.
  if (AMB_AUTHOR_SETS.length > 0) {
    console.log(`Loading author sets from ${AMB_AUTHOR_SETS.length} naddr(s)...`);
    try {
      const directory = await loadAuthorSets(AMB_AUTHOR_SETS, AMB_RELAYS);
      setAuthorDirectory(directory);
      console.log(
        `Loaded ${directory.authors.length} authors from ${directory.sets.length} set(s)`,
      );
    } catch (error) {
      console.error('Failed to load author sets:', error);
    }
  }

  if (CALENDAR_AUTHOR_SETS.length > 0) {
    console.log(`Loading calendar author sets from ${CALENDAR_AUTHOR_SETS.length} naddr(s)...`);
    try {
      const directory = await loadAuthorSets(CALENDAR_AUTHOR_SETS, CALENDAR_RELAYS);
      setCalendarAuthorDirectory(directory);
      console.log(
        `Loaded ${directory.authors.length} calendar authors from ${directory.sets.length} set(s)`,
      );
    } catch (error) {
      console.error('Failed to load calendar author sets:', error);
    }
  }

  const verify = createJwtVerifier({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, jwksUri: OAUTH_JWKS_URI });

  // Shared across all sessions (unlike ambClient/calendarClient): kind-777
  // spells and kind-3 contact lists are not session-scoped state, so one
  // long-lived client — same lifecycle as `indexer` — serves every session's
  // search_passages calls.
  const spellClient = new AMBRelayClient(SPELL_RELAYS);

  const handle = await startHttpServer({
    port: HTTP_PORT,
    host: HTTP_HOST,
    auth: {
      verify,
      resourceUrl: OAUTH_RESOURCE_URL,
      issuer: OAUTH_ISSUER,
      scopes: ['mcp:read', 'mcp:extract'],
    },
    allowedHosts: HTTP_ALLOWED_HOSTS,
    allowedOrigins: HTTP_ALLOWED_ORIGINS,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    buildMcpServer: ({ scopes, query }) => {
      // Per-session relay clients: each session starts from the configured
      // defaults (or the ?relays= set its connector URL named) and can
      // add/remove relays without affecting other sessions.
      const relays = resolveSessionRelays(query, {
        defaults: AMB_RELAYS,
        extras: AMB_EXTRA_RELAYS,
      });
      const { server, dispose } = buildSessionServer(
        relays.defaults,
        CALENDAR_RELAYS,
        scopesToProfile(scopes),
        {
          ambExtraRelays: relays.extras,
          defaultsFromConnectorUrl: relays.fromConnectorUrl,
          spellClient,
          indexer: indexer ?? undefined,
          openLicensesOnly: OPEN_LICENSES_ONLY,
        },
      );
      return { server, dispose };
    },
  });

  console.log(`✓ nope-mcp listening at http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
  console.log(`  Health: http://${HTTP_HOST}:${HTTP_PORT}/healthz`);
  console.log('Press Ctrl+C to stop');

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      // Closes all active session transports, each of which disposes its
      // own relay clients via the onclose hook.
      await handle.close();
    } catch (err) {
      console.error('Error closing HTTP server:', err);
    }
    spellClient.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Only run main() when executed directly (not imported as a module in tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
