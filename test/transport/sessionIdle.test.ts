import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { startHttpServer, type HttpServerHandle } from '../../src/transport/http.js';

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

let handle: HttpServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

// Regression: edufeed-app opens a session per tool call and never DELETEs it;
// without expiry every session kept its relay sockets open forever.
describe('idle session expiry', () => {
  it('closes and disposes a session nobody sends DELETE for', async () => {
    const dispose = vi.fn();
    handle = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      sessionIdleMs: 50,
      buildMcpServer: () => ({ server: new McpServer({ name: 't', version: '0' }), dispose }),
    });
    const base = `http://127.0.0.1:${handle.port}/mcp`;
    const res = await fetch(base, { method: 'POST', headers, body: initBody });
    const sid = res.headers.get('mcp-session-id')!;
    await res.text();
    expect(sid).toBeTruthy();

    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce(), { timeout: 2000 });
    const after = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(after.status).toBe(404);
  });

  it('keeps a session that is still within the idle window', async () => {
    const dispose = vi.fn();
    handle = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      sessionIdleMs: 60_000,
      buildMcpServer: () => ({ server: new McpServer({ name: 't', version: '0' }), dispose }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: 'POST', headers, body: initBody });
    await res.text();
    await new Promise((r) => setTimeout(r, 100));
    expect(dispose).not.toHaveBeenCalled();
  });
});
