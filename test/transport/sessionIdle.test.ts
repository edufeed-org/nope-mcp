import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { startHttpServer, type HttpServerHandle } from '../../src/transport/http.js';
import { createMcpServerFactory } from '../../src/http.js';

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

  it('closes the expired session\'s own relay clients, never the ones standalone requests share', async () => {
    const factory = createMcpServerFactory({
      ambRelays: ['wss://relay.example'],
      ambExtraRelays: [],
      calendarRelays: ['wss://relay.example'],
    });
    const builds: { standalone: boolean; server: ReturnType<typeof factory.build>; closed: ReturnType<typeof vi.spyOn>[] }[] = [];
    handle = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      sessionIdleMs: 50,
      buildMcpServer: (ctx) => {
        const server = factory.build(ctx);
        builds.push({
          standalone: ctx.standalone,
          server,
          // a shared client comes back on later builds: spy on it once
          closed: [server.ambClient, server.calendarClient].map((c) =>
            vi.isMockFunction(c.close) ? (c.close as unknown as ReturnType<typeof vi.spyOn>) : vi.spyOn(c, 'close'),
          ),
        });
        return server;
      },
    });
    const base = `http://127.0.0.1:${handle.port}/mcp`;
    const standaloneCall = async () => {
      const res = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_relays', arguments: {} } }),
      });
      expect(res.status).toBe(200);
      await res.text();
    };

    await standaloneCall();
    const init = await fetch(base, { method: 'POST', headers, body: initBody });
    await init.text();
    const [first, session] = builds;
    expect([first.standalone, session.standalone]).toEqual([true, false]);
    expect(session.server.ambClient).not.toBe(first.server.ambClient);

    // the idle session goes away and takes its own sockets with it
    await vi.waitFor(() => session.closed.forEach((c) => expect(c).toHaveBeenCalledOnce()), { timeout: 2000 });
    first.closed.forEach((c) => expect(c).not.toHaveBeenCalled());

    // the shared clients are still the ones in use, and still open
    await standaloneCall();
    const later = builds[2];
    expect(later.server.ambClient).toBe(first.server.ambClient);
    first.closed.forEach((c) => expect(c).not.toHaveBeenCalled());

    // they close exactly once, with the process
    factory.close();
    first.closed.forEach((c) => expect(c).toHaveBeenCalledOnce());
  });
});
