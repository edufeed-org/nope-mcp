import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

// What a 2026-07-28 client puts on every request, in the body and mirrored in headers.
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

// A 2025-era request: no _meta envelope, no session.
const call = (id: number, text: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'echo', arguments: { text } },
});

// The same call as revision 2026-07-28 sends it.
const modern = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post(
    { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } },
    {
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
      ...headers,
    },
  );
const modernCall = (text: string, headers: Record<string, string> = {}) =>
  modern('tools/call', { name: 'echo', arguments: { text } }, headers);

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
        server.registerTool(name, { inputSchema: z.object({ text: z.string().optional() }) }, async ({ text }) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 50));
          running--;
          return { content: [{ type: 'text' as const, text: `${name}:${text ?? ''}` }] };
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
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
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
    expect(await names(await modern('tools/list'))).toEqual(first);
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

describe('revision 2026-07-28', () => {
  it('answers a tools/call that carries version and capabilities in _meta', async () => {
    const res = await modernCall('hi');
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const msg = await rpc(res);
    expect(msg.result.content[0].text).toBe('echo:hi');
    expect(msg.result.resultType).toBe('complete');
  });

  it('answers server/discover with the revisions it speaks', async () => {
    const msg = await rpc(await modern('server/discover'));
    expect(msg.result.supportedVersions).toContain('2026-07-28');
    expect(msg.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('test');
  });

  it('marks tools/list as cacheable', async () => {
    const { result } = await rpc(await modern('tools/list'));
    expect(typeof result.ttlMs).toBe('number');
    expect(['public', 'private']).toContain(result.cacheScope);
  });

  it('refuses a header that contradicts the body (HeaderMismatch)', async () => {
    const res = await modernCall('x', { 'Mcp-Name': 'alpha' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it('names its revisions when asked for one it does not speak', async () => {
    const res = await post(
      { ...call(1, 'x'), params: { ...call(1, 'x').params, _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } },
      { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    );
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe(-32022);
    expect(error.data.supported).toContain('2026-07-28');
  });

  it('ignores a stray Mcp-Session-Id', async () => {
    const res = await modernCall('x', { 'Mcp-Session-Id': 'gone' });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('answers parallel calls', async () => {
    maxRunning = 0;
    const texts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => modernCall(`n${i}`).then(async (res) => (await rpc(res)).result.content[0].text)),
    );
    expect(texts).toEqual(Array.from({ length: 8 }, (_, i) => `echo:n${i}`));
    expect(maxRunning).toBeGreaterThan(1);
  });

  it('refuses a bad token exactly like the session flow does', async () => {
    const res = await modernCall('x', { Authorization: 'Bearer not-a-jwt' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect((await res.json()).error.message).toBe('Unauthorized');
  });

  it('takes scopes from the token and ?relays= from the URL of the request itself', async () => {
    built = [];
    await (await modernCall('x')).text();
    await (await modernCall('x', { Authorization: `Bearer ${await sign('mcp:read mcp:extract')}` })).text();
    expect(built.map((b) => b.scopes)).toEqual([['mcp:read'], ['mcp:read', 'mcp:extract']]);

    const res = await fetch(`${base}/mcp?relays=nope`, {
      method: 'POST',
      headers: { ...HEADERS, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32602);
  });

  it('disposes the per-request server', async () => {
    const before = disposed;
    await (await modernCall('x')).text();
    await expect.poll(() => disposed).toBe(before + 1);
  });

  it('lets a browser send the new request headers (CORS preflight)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'mcp-method, mcp-name, mcp-protocol-version',
      },
    });
    const allowed = res.headers.get('access-control-allow-headers')!.toLowerCase();
    expect(allowed).toContain('mcp-method');
    expect(allowed).toContain('mcp-name');
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

  it('serves the v1 SDK client (what Claude Code and the claude.ai connector speak)', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    const client = new Client({ name: 'v1-client', version: '0' });
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['zulu', 'echo', 'alpha']);
    const result = await client.callTool({ name: 'echo', arguments: { text: 'v1' } });
    expect((result.content as { text: string }[])[0].text).toBe('echo:v1');
    await transport.terminateSession();
    await client.close();
  });

  it('still answers an unknown Mcp-Session-Id with 404 so the client re-initializes', async () => {
    const res = await post(call(1, 'x'), { 'Mcp-Session-Id': 'gone' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/Session not found/);
  });
});

describe('Host allow-list on standalone requests', () => {
  it('refuses a Host outside the list with 403, in both eras, as the session transport does', async () => {
    const guarded = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['mcp.edufeed.org'],
      buildMcpServer: () => ({ server: new McpServer({ name: 'test', version: '0' }) }),
    });
    const url = `http://127.0.0.1:${guarded.port}/mcp`;
    const send = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, { method: 'POST', headers: { ...HEADERS, ...headers }, body: JSON.stringify(body) });
    try {
      const legacy = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const modernReq = await send(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } },
        { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
      );
      const session = await send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      });
      expect([legacy.status, modernReq.status, session.status]).toEqual([403, 403, 403]);
    } finally {
      await guarded.close();
    }
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
