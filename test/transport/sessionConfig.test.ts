import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  startHttpServer,
  SessionConfigError,
  type HttpServerHandle,
} from '../../src/transport/http.js';

let handle: HttpServerHandle;
let base: string;
let lastQuery: URLSearchParams | undefined;
let builds = 0;

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

const post = (path: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: initBody,
  });

beforeAll(async () => {
  handle = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    buildMcpServer: ({ query }) => {
      builds++;
      lastQuery = query;
      if (query.get('relays') === 'bogus') {
        throw new SessionConfigError('Unknown relay name(s): bogus', {
          unknownNames: ['bogus'],
          knownNames: ['sodix'],
        });
      }
      return { server: new McpServer({ name: 'test', version: '0' }) };
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
});

describe('per-connection session config', () => {
  it('hands the initialize request query string to the session factory', async () => {
    lastQuery = undefined;
    const res = await post('/mcp?relays=sodix,oersi');
    expect(res.status).toBe(200);
    expect(lastQuery?.get('relays')).toBe('sodix,oersi');
  });

  it('gives the factory an empty query when the URL carries none', async () => {
    lastQuery = undefined;
    const res = await post('/mcp');
    expect(res.status).toBe(200);
    expect(lastQuery?.get('relays')).toBeNull();
  });

  it('rejects an unusable session config with 400 and the offending details', async () => {
    const res = await post('/mcp?relays=bogus');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('bogus');
    expect(body.error.data).toEqual({ unknownNames: ['bogus'], knownNames: ['sodix'] });
  });

  it('opens no session when the config was rejected', async () => {
    const res = await post('/mcp?relays=bogus');
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('serves a non-initialize request without a session on its own, with the config of its own URL', async () => {
    const before = builds;
    const res = await fetch(`${base}/mcp?relays=sodix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(200); // was 404 while every request needed a session
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(builds).toBe(before + 1);
  });
});

describe('unknown session id', () => {
  const call = (method: string, sid: string) =>
    fetch(`${base}/mcp`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': sid,
      },
      body: method === 'POST'
        ? JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        : undefined,
    });

  it('answers a POST with an expired/unknown Mcp-Session-Id with 404 (spec re-init signal)', async () => {
    const res = await call('POST', 'no-such-session');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it('answers GET/DELETE with an unknown Mcp-Session-Id with 404', async () => {
    expect((await call('GET', 'no-such-session')).status).toBe(404);
    expect((await call('DELETE', 'no-such-session')).status).toBe(404);
  });
});
