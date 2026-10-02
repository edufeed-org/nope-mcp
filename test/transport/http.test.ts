import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer, type HttpServerHandle } from '../../src/transport/http.js';
import { createJwtVerifier } from '../../src/transport/auth.js';

const ISSUER = 'https://auth.edufeed.org/realms/edufeed';
const AUDIENCE = 'amb-mcp';
const RESOURCE = 'https://mcp.amb.edufeed.org/mcp';

let handle: HttpServerHandle;
let base: string;
let sign: (scope: string) => Promise<string>;
let lastScopes: string[] | undefined;

// Minimal MCP initialize request body (a session is only built for initialize).
const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0' },
  },
});

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const verify = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: 'unused', getKey });
  sign = (scope: string) =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('1h')
      .setSubject('tester').sign(privateKey);

  handle = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    auth: { verify, resourceUrl: RESOURCE, issuer: ISSUER, scopes: ['mcp:read', 'mcp:extract'] },
    buildMcpServer: ({ scopes }) => {
      lastScopes = scopes;
      return { server: new McpServer({ name: 'test', version: '0' }) };
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => { await handle.close(); });

describe('HTTP transport OAuth', () => {
  it('serves PRM unauthenticated', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.resource).toBe(RESOURCE);
    expect(doc.authorization_servers).toEqual([ISSUER]);
  });

  it('serves an anonymous read session (no token) with scopes [mcp:read]', async () => {
    lastScopes = undefined;
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Protocol-Version': '2025-03-26' },
      body: initBody,
    });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(lastScopes).toEqual(['mcp:read']);
  });

  it('rejects /mcp with a garbage token (401)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-jwt' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts /mcp with a valid signed token (200, no WWW-Authenticate)', async () => {
    const token = await sign('mcp:read');
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Mcp-Protocol-Version': '2025-03-26',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0' },
        },
      }),
    });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('keeps /healthz open', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('nope-mcp');
  });

  it('grants mcp:extract to a session initialized with an extract-scoped token', async () => {
    lastScopes = undefined;
    const token = await sign('mcp:read mcp:extract');
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Mcp-Protocol-Version': '2025-03-26',
      },
      body: initBody,
    });
    expect(res.status).not.toBe(401);
    expect(lastScopes).toEqual(['mcp:read', 'mcp:extract']);
  });
});

import { scopesToProfile } from '../../src/http.js';

describe('scopesToProfile', () => {
  it('maps mcp:read + mcp:extract to a read+extract, no-write profile', () => {
    expect(scopesToProfile(['mcp:read', 'mcp:extract'])).toEqual({ read: true, extract: true, write: false });
  });
  it('maps read-only', () => {
    expect(scopesToProfile(['mcp:read'])).toEqual({ read: true, extract: false, write: false });
  });
  it('never enables write tools', () => {
    expect(scopesToProfile(['mcp:read', 'mcp:extract', 'mcp:write']).write).toBe(false);
  });
});