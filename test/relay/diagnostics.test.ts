import { describe, it, expect } from 'vitest';
import type { Filter, NostrEvent } from 'nostr-tools';
import { AMBRelayClient, parseRelayQueryTimeoutMs } from '../../src/relay/client.js';
import { newRelayDiagnostics, relayDiagnosticsFields } from '../../src/tools/relaySelection.js';

const DEAD = 'ws://127.0.0.1:1'; // refuses connections immediately

describe('relayDiagnosticsFields', () => {
  it('is empty when every relay answered', () => {
    expect(relayDiagnosticsFields({ unreachable: [], timedOut: [] })).toEqual({});
  });

  it('names timed-out and unreachable relays, deduplicated, with a warning', () => {
    const out = relayDiagnosticsFields({ unreachable: ['wss://a'], timedOut: ['wss://a', 'wss://b'] });
    expect(out.relaysIncomplete).toEqual(['wss://a', 'wss://b']); // set-union, timedOut order first
    expect(String(out.warning)).toContain('did not fully answer');
    expect(String(out.warning)).toContain('NOT proof the corpus is');
  });
});

describe('queryEvents diagnostics (prepareSubscription path)', () => {
  it('records a connection-refusing relay as unreachable and returns [] leniently', async () => {
    const client = new AMBRelayClient([DEAD], { queryTimeoutMs: 500 });
    const diag = newRelayDiagnostics();
    try {
      const events = await client.queryEvents({ kinds: [30142], limit: 1 }, [DEAD], { diag });
      expect(events).toEqual([]);
      expect(diag.unreachable).toEqual([DEAD]);
      expect(diag.timedOut).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('records a connected-but-never-EOSE relay as timedOut', async () => {
    const client = new AMBRelayClient(['wss://hangs.example'], { queryTimeoutMs: 80 });
    // Fake pool: ensureRelay resolves, prepareSubscription fires but never
    // calls oneose/onclose — i.e. a relay that connects and then hangs.
    (client as unknown as { pool: Record<string, unknown> }).pool = {
      ensureRelay: async () => ({
        prepareSubscription: () => ({ fire() {}, close() {}, filters: [] as Filter[] }),
      }),
      close() {},
    };
    const diag = newRelayDiagnostics();
    const events = await client.queryEvents({ kinds: [30142], limit: 1 }, ['wss://hangs.example'], { diag });
    expect(events).toEqual([]);
    expect(diag.timedOut).toEqual(['wss://hangs.example']);
    expect(diag.unreachable).toEqual([]);
  });
});

/**
 * A fake relay sub whose close() mimics nostr-tools' real Subscription.close():
 * it synchronously invokes the caller's onclose. Needed to exercise the
 * oneose-calls-close-which-fires-onclose-too double-settlement bug (and its
 * fix) that a close() stub ignoring `onclose` can't catch.
 */
function fakeRelayWithControllableSubs() {
  const control: Record<
    string,
    { oneose: () => void; onclose: (reason?: string) => void; fireEose: () => void }
  > = {};
  const pool = {
    ensureRelay: async (url: string) => ({
      prepareSubscription: (
        _filters: Filter[],
        params: { oneose: () => void; onclose: (reason?: string) => void; onevent: (e: NostrEvent) => void }
      ) => {
        let closed = false;
        const sub = {
          fire() {},
          close(reason?: string) {
            if (closed) return;
            closed = true;
            params.onclose(reason);
          },
          filters: [] as Filter[],
        };
        control[url] = { oneose: params.oneose, onclose: params.onclose, fireEose: () => sub.close('eose') };
        return sub;
      },
    }),
    close() {},
  };
  return { pool, control };
}

describe('queryEvents bookkeeping across multiple relays', () => {
  const R1 = 'wss://r1.example';
  const R2 = 'wss://r2.example';

  it('waits for every relay to settle before resolving (oneose must not double-decrement pendingRelays)', async () => {
    const client = new AMBRelayClient([R1, R2], { queryTimeoutMs: 5000 });
    const { pool, control } = fakeRelayWithControllableSubs();
    (client as unknown as { pool: unknown }).pool = pool;

    const promise = client.queryEvents({ kinds: [30142], limit: 1 }, [R1, R2]);
    await new Promise((r) => setTimeout(r, 10)); // let both ensureRelay/prepareSubscription calls land

    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    // Relay 1's real EOSE arrives — its oneose handler calls sub.close('eose'),
    // which (in the buggy version) fired onclose too, decrementing
    // pendingRelays a second time and resolving the whole query early.
    control[R1].oneose();
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false); // relay 2 hasn't EOSE'd yet — must still be waiting

    control[R2].oneose();
    await promise;
    expect(resolved).toBe(true);
  });

  it('reports only the relay still hanging at the deadline as timedOut, not one that EOSE\'d first', async () => {
    const client = new AMBRelayClient([R1, R2], { queryTimeoutMs: 60 });
    const { pool, control } = fakeRelayWithControllableSubs();
    (client as unknown as { pool: unknown }).pool = pool;

    const diag = newRelayDiagnostics();
    const promise = client.queryEvents({ kinds: [30142], limit: 1 }, [R1, R2], { diag });
    await new Promise((r) => setTimeout(r, 10));
    control[R1].oneose(); // R1 settles normally well before the 60ms deadline; R2 never does

    await promise;
    expect(diag.timedOut).toEqual([R2]); // not [] (which the pre-fix snapshot-after-close bug produced)
    expect(diag.unreachable).toEqual([]);
  });
});

type FakeSubscribeManyEose = (
  relays: string[],
  filter: Filter,
  params: { onevent: (e: NostrEvent) => void; onclose: () => void }
) => { close(reason?: string): void };

function fakePool(impl: FakeSubscribeManyEose) {
  return { subscribeManyEose: impl };
}

function fakeEvent(id: string): NostrEvent {
  return { id, pubkey: 'a'.repeat(64), created_at: 1700000000, kind: 30142, tags: [], content: '', sig: 's' };
}

describe('queryRelays diagnostics (subscribeManyEose path, via query())', () => {
  it('marks every queried relay as incomplete on a timeout (coarse)', async () => {
    const client = new AMBRelayClient(['wss://slow.example'], { queryTimeoutMs: 60 });
    let closed = false;
    (client as unknown as { pool: ReturnType<typeof fakePool> }).pool = fakePool(() => ({
      // Never calls onclose — a relay that connects and then hangs past EOSE.
      close: () => {
        closed = true;
      },
    }));
    const diag = newRelayDiagnostics();
    const events = await client.query({ limit: 1 }, ['wss://slow.example'], diag);
    expect(events).toEqual([]);
    expect(diag.timedOut).toEqual(['wss://slow.example']);
    expect(closed).toBe(true); // the stalled subscription was closed, not leaked
  });

  it('returns events collected so far on timeout instead of discarding them', async () => {
    const client = new AMBRelayClient(['wss://partial.example'], { queryTimeoutMs: 80 });
    (client as unknown as { pool: ReturnType<typeof fakePool> }).pool = fakePool((_relays, _filter, params) => {
      // Deliver two events immediately, then stall past the timeout (like
      // sodix under reindex load answering well after the old 10s budget).
      queueMicrotask(() => {
        params.onevent(fakeEvent('e1'));
        params.onevent(fakeEvent('e2'));
      });
      return { close: () => {} };
    });
    const diag = newRelayDiagnostics();
    const events = await client.query({ limit: 1 }, ['wss://partial.example'], diag);
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(diag.timedOut).toEqual(['wss://partial.example']);
  });

  it('reports no incomplete relays on a clean (fast) return', async () => {
    const client = new AMBRelayClient(['wss://ok.example'], { queryTimeoutMs: 500 });
    (client as unknown as { pool: ReturnType<typeof fakePool> }).pool = fakePool((_relays, _filter, params) => {
      queueMicrotask(() => params.onclose());
      return { close: () => {} };
    });
    const diag = newRelayDiagnostics();
    await client.query({ limit: 1 }, ['wss://ok.example'], diag);
    expect(diag.timedOut).toEqual([]);
    expect(diag.unreachable).toEqual([]);
  });
});

describe('queryEvents: timeout keeps collected events and closes subscriptions', () => {
  it('returns events gathered before the deadline and closes every open subscription', async () => {
    const client = new AMBRelayClient(['wss://partial.example'], { queryTimeoutMs: 80 });
    let closed = false;
    (client as unknown as { pool: Record<string, unknown> }).pool = {
      ensureRelay: async () => ({
        prepareSubscription: (_filters: Filter[], params: { onevent: (e: NostrEvent) => void }) => {
          queueMicrotask(() => {
            params.onevent(fakeEvent('e1'));
            params.onevent(fakeEvent('e2'));
          });
          // Never calls oneose/onclose — connects, delivers events, then hangs.
          return {
            fire() {},
            close() {
              closed = true;
            },
            filters: [] as Filter[],
          };
        },
      }),
      close() {},
    };
    const diag = newRelayDiagnostics();
    const events = await client.queryEvents({ kinds: [30142], limit: 1 }, ['wss://partial.example'], { diag });
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(diag.timedOut).toEqual(['wss://partial.example']);
    expect(closed).toBe(true);
  });
});

describe('RELAY_QUERY_TIMEOUT_MS', () => {
  it('overrides the default per-query timeout from the environment', () => {
    expect(parseRelayQueryTimeoutMs({ RELAY_QUERY_TIMEOUT_MS: '5000' })).toBe(5000);
  });

  it('falls back to the 25s default when unset', () => {
    expect(parseRelayQueryTimeoutMs({})).toBe(25000);
  });

  it('throws on a non-numeric or non-positive value', () => {
    expect(() => parseRelayQueryTimeoutMs({ RELAY_QUERY_TIMEOUT_MS: 'abc' })).toThrow();
    expect(() => parseRelayQueryTimeoutMs({ RELAY_QUERY_TIMEOUT_MS: '0' })).toThrow();
    expect(() => parseRelayQueryTimeoutMs({ RELAY_QUERY_TIMEOUT_MS: '-5' })).toThrow();
  });

  it('AMBRelayClient reads it from process.env when queryTimeoutMs is not passed explicitly', () => {
    const prev = process.env.RELAY_QUERY_TIMEOUT_MS;
    process.env.RELAY_QUERY_TIMEOUT_MS = '12345';
    try {
      const client = new AMBRelayClient(['wss://x.example']);
      expect((client as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(12345);
    } finally {
      if (prev === undefined) delete process.env.RELAY_QUERY_TIMEOUT_MS;
      else process.env.RELAY_QUERY_TIMEOUT_MS = prev;
    }
  });
});
