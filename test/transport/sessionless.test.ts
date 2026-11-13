import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer, SessionConfigError, type HttpServerHandle } from '../../src/transport/http.js';
import { createJwtVerifier } from '../../src/transport/auth.js';
import { buildSessionServer } from '../../src/session.js';

const ISSUER = 'https://auth.edufeed.org/realms/edufeed';
const AUDIENCE = 'nope-mcp';

let handle: HttpServerHandle;
let base: string;
let sign: (scope: string) => Promise<string>;
let built: { scopes: string[]; query: URLSearchParams }[] = [];
let disposed = 0;
let running = 0;
let maxRunning = 0;

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

// What a 2026-07-28 client puts on every request; the server must not choke on it.
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function post(body: unknown, headers: Record<string, string> = {}, path = '/mcp') {
  return fetch(`${base}${path}`, { method: 'POST', headers: { ...HEADERS, ...headers }, body: JSON.stringify(body) });
}

/** The JSON-RPC response of a request, whether it came as JSON or as an SSE stream. */
async function rpc(res: Response) {
  const text = await res.text();
  if (!res.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(text);
  const data = text.split('\n').filter((l) => l.startsWith('data: ') && l.length > 6).pop()!;
  return JSON.parse(data.slice(6));
}

const call = (id: number, text: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'echo', arguments: { text }, _meta: META },
});

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  const verify = createJwtVerifier({
    issuer: ISSUER, audience: AUDIENCE, jwksUri: 'unused', getKey: createLocalJWKSet({ keys: [jwk] }),
  });
  sign = (scope: string) =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('1h')
      .setSubject('tester').sign(privateKey);

  handle = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    auth: { verify, resourceUrl: 'https://mcp.edufeed.org/mcp', issuer: ISSUER, scopes: ['mcp:read', 'mcp:extract'] },
    buildMcpServer: ({ scopes, query }) => {
      if (query.get('relays') === 'nope') throw new SessionConfigError('Unknown relay name: nope');
      built.push({ scopes, query });
      const server = new McpServer({ name: 'test', version: '0' });
      for (const name of ['zulu', 'echo', 'alpha']) {
        server.tool(name, { text: z.string().optional() }, async ({ text }) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 50));
          running--;
          return { content: [{ type: 'text', text: `${name}:${text ?? ''}` }] };
        });
      }
      return { server, dispose: () => { disposed++; } };
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => { await handle.close(); });

describe('requests without a session', () => {
  it('answers a tools/call that was never preceded by initialize', async () => {
    const before = disposed;
    const res = await post(call(7, 'hi'));
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const msg = await rpc(res);
    expect(msg.id).toBe(7);
    expect(msg.result.content[0].text).toBe('echo:hi');
    // the per-request server is torn down once the response is out
    await expect.poll(() => disposed).toBe(before + 1);
  });

  it('answers on / as well', async () => {
    const res = await post(call(1, 'root'), {}, '/');
    expect((await rpc(res)).result.content[0].text).toBe('echo:root');
  });

  it('answers N parallel standalone calls, each with its own result', async () => {
    maxRunning = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(call(i + 1, `n${i}`)).then(async (res) => ({ status: res.status, msg: await rpc(res) }))),
    );
    results.forEach(({ status, msg }, i) => {
      expect(status).toBe(200);
      expect(msg.id).toBe(i + 1);
      expect(msg.result.content[0].text).toBe(`echo:n${i}`);
    });
    expect(maxRunning).toBeGreaterThan(1); // really in flight together, not queued
  });

  it('opens no session: /healthz keeps counting only initialized sessions', async () => {
    const sessions = async () => (await (await fetch(`${base}/healthz`)).json()).sessions;
    const before = await sessions();
    await (await post(call(1, 'x'))).text();
    expect(await sessions()).toBe(before);
  });

  it('lists tools in the same order on every request, and as a session does', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } };
    const names = async (res: Response) => (await rpc(res)).result.tools.map((t: { name: string }) => t.name);
    const first = await names(await post(list));
    const second = await names(await post(list));

    const init = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();
    const inSession = await names(await post(list, { 'Mcp-Session-Id': sid }));

    expect(first).toEqual(['zulu', 'echo', 'alpha']); // registration order, not sorted per request
    expect(second).toEqual(first);
    expect(inSession).toEqual(first);
  });

  it('refuses a bad token exactly like the session flow does', async () => {
    const bad = { Authorization: 'Bearer not-a-jwt' };
    const standalone = await post(call(1, 'x'), bad);
    const classic = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }, bad);
    expect(standalone.status).toBe(401);
    expect(standalone.status).toBe(classic.status);
    expect(standalone.headers.get('www-authenticate')).toBe(classic.headers.get('www-authenticate'));
    expect(standalone.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(await standalone.json()).toEqual(await classic.json());
  });

  it('takes scopes from the token of the request itself', async () => {
    built = [];
    await (await post(call(1, 'x'))).text();
    await (await post(call(2, 'x'), { Authorization: `Bearer ${await sign('mcp:read mcp:extract')}` })).text();
    expect(built.map((b) => b.scopes)).toEqual([['mcp:read'], ['mcp:read', 'mcp:extract']]);
  });

  it('reads ?relays= from the URL of the request itself, and refuses a bad one with 400', async () => {
    built = [];
    await (await post(call(1, 'x'), {}, '/mcp?relays=sodix')).text();
    expect(built[0].query.get('relays')).toBe('sodix');

    const res = await post(call(1, 'x'), {}, '/mcp?relays=nope');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32602);
  });
});

describe('the session flow next to it', () => {
  it('initialize → initialized → tools/call still works, in one session', async () => {
    built = [];
    const init = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    expect((await rpc(init)).result.protocolVersion).toBe('2025-06-18');
    const session = { 'Mcp-Session-Id': sid!, 'Mcp-Protocol-Version': '2025-06-18' };

    const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    expect(ack.status).toBe(202);

    const res = await post(call(2, 'classic'), session);
    expect(res.status).toBe(200);
    expect((await rpc(res)).result.content[0].text).toBe('echo:classic');
    expect(built).toHaveLength(1); // one server for the whole session

    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: session });
    expect(del.status).toBe(200);
  });

  it('still answers an unknown Mcp-Session-Id with 404 so the client re-initializes', async () => {
    const res = await post(call(1, 'x'), { 'Mcp-Session-Id': 'gone' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/Session not found/);
  });
});

describe('tool order of the real server', () => {
  it('is the same for every server built with the same profile', () => {
    const names = () => {
      const s = buildSessionServer(['wss://relay.example'], ['wss://relay.example'], { read: true, extract: true });
      const out = Object.keys((s.server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
      s.dispose();
      return out;
    };
    const first = names();
    expect(first.length).toBeGreaterThan(5);
    expect(names()).toEqual(first);
  });
});
