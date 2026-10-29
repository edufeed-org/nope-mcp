import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';
import { AMBRelayClient } from '../../src/relay/client.js';
import { newRelayDiagnostics } from '../../src/tools/relaySelection.js';

/**
 * A minimal real NIP-01 relay (over an actual WebSocket, not a mocked
 * pool/sub) that answers every REQ with a scripted set of events, after an
 * optional delay, then EOSEs — or never EOSEs at all. This is the only way
 * to exercise nostr-tools' OWN default `baseEoseTimeout` (4400ms) wiring:
 * a mocked `pool.subscribeManyEose`/`prepareSubscription` never goes near
 * that code at all, so it can't catch a regression there (the bug this
 * file guards: without passing `maxWait`/`eoseTimeout` through, nostr-tools
 * synthesizes a fake EOSE at 4400ms regardless of our own, much longer,
 * RELAY_QUERY_TIMEOUT_MS, silently truncating slower relays).
 */
function startFakeRelay(opts: {
  events: NostrEvent[];
  delayMs?: number;
  neverEose?: boolean;
}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: Buffer) => {
        let msg: unknown[];
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg[0] !== 'REQ') return;
        const subId = msg[1] as string;
        const send = () => {
          for (const event of opts.events) {
            ws.send(JSON.stringify(['EVENT', subId, event]));
          }
          if (!opts.neverEose) {
            ws.send(JSON.stringify(['EOSE', subId]));
          }
        };
        if (opts.delayMs) {
          setTimeout(send, opts.delayMs);
        } else {
          send();
        }
      });
    });
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => wss.close(() => res())),
      });
    });
  });
}

function signedResourceEvent(id: string): NostrEvent {
  const sk = generateSecretKey();
  return finalizeEvent(
    {
      kind: 30142,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', id], ['name', `Resource ${id}`]],
      content: '',
    },
    sk
  );
}

describe('real relay: eoseTimeout/maxWait wiring (regression for the 4400ms nostr-tools default)', () => {
  let cleanup: (() => Promise<void>) | undefined;
  let client: AMBRelayClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  it('query()/search() (subscribeManyEose path) returns events delivered after 5.5s when the client timeout covers it', async () => {
    const events = [signedResourceEvent('a'), signedResourceEvent('b')];
    const relay = await startFakeRelay({ events, delayMs: 5500 });
    cleanup = relay.close;
    client = new AMBRelayClient([relay.url], { queryTimeoutMs: 8000 });

    const diag = newRelayDiagnostics();
    const result = await client.query({ kinds: [30142], limit: 10 }, [relay.url], diag);

    expect(result.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
    expect(diag.timedOut).toEqual([]);
  }, 15000);

  it('queryEvents() (prepareSubscription path) returns events delivered after 5.5s when the client timeout covers it', async () => {
    const events = [signedResourceEvent('c')];
    const relay = await startFakeRelay({ events, delayMs: 5500 });
    cleanup = relay.close;
    client = new AMBRelayClient([relay.url], { queryTimeoutMs: 8000 });

    const diag = newRelayDiagnostics();
    const result = await client.queryEvents({ kinds: [30142], limit: 10 }, [relay.url], { diag });

    expect(result.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(diag.timedOut).toEqual([]);
  }, 15000);

  it('query() returns partial events and flags the relay incomplete when it stalls past a short RELAY_QUERY_TIMEOUT_MS', async () => {
    const events = [signedResourceEvent('d'), signedResourceEvent('e')];
    // Events are sent immediately, but EOSE never arrives (the relay hangs
    // mid-answer, as sodix did under reindex load).
    const relay = await startFakeRelay({ events, neverEose: true });
    cleanup = relay.close;
    client = new AMBRelayClient([relay.url], { queryTimeoutMs: 400 });

    const diag = newRelayDiagnostics();
    const result = await client.query({ kinds: [30142], limit: 10 }, [relay.url], diag);

    expect(result.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
    expect(diag.timedOut).toEqual([relay.url]);
  }, 10000);

  it('queryEvents() returns partial events and flags the relay incomplete when it stalls past a short RELAY_QUERY_TIMEOUT_MS', async () => {
    const events = [signedResourceEvent('f')];
    const relay = await startFakeRelay({ events, neverEose: true });
    cleanup = relay.close;
    client = new AMBRelayClient([relay.url], { queryTimeoutMs: 400 });

    const diag = newRelayDiagnostics();
    const result = await client.queryEvents({ kinds: [30142], limit: 10 }, [relay.url], { diag });

    expect(result.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(diag.timedOut).toEqual([relay.url]);
  }, 10000);
});
