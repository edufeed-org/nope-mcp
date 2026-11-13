import { describe, it, expect, vi } from 'vitest';
import { createMcpServerFactory, resolveSessionRelays } from '../src/http.js';
import { SessionConfigError } from '../src/transport/http.js';

const CONFIG = {
  defaults: ['wss://relay.edufeed.org'],
  extras: ['wss://oersi.edufeed.org', 'wss://sodix.edufeed.org'],
};

const q = (search: string) => new URLSearchParams(search);

describe('resolveSessionRelays', () => {
  it('keeps the server config when the URL names no relays', () => {
    const out = resolveSessionRelays(q(''), CONFIG);
    expect(out.defaults).toEqual(CONFIG.defaults);
    expect(out.extras).toEqual(CONFIG.extras);
    expect(out.fromConnectorUrl).toBe(false);
  });

  it('promotes a URL-named extra relay into the session default set', () => {
    const out = resolveSessionRelays(q('relays=sodix'), CONFIG);
    expect(out.defaults).toEqual(['wss://sodix.edufeed.org']);
    expect(out.fromConnectorUrl).toBe(true);
  });

  it('leaves every relay the URL did not name selectable per call', () => {
    const out = resolveSessionRelays(q('relays=sodix'), CONFIG);
    expect(out.extras).toEqual(['wss://relay.edufeed.org', 'wss://oersi.edufeed.org']);
  });

  it('honours the order the URL listed the relays in', () => {
    const out = resolveSessionRelays(q('relays=sodix,relay'), CONFIG);
    expect(out.defaults).toEqual(['wss://sodix.edufeed.org', 'wss://relay.edufeed.org']);
    expect(out.extras).toEqual(['wss://oersi.edufeed.org']);
  });

  it('accepts full relay URLs as well as short aliases', () => {
    const out = resolveSessionRelays(q('relays=wss%3A%2F%2Fsodix.edufeed.org'), CONFIG);
    expect(out.defaults).toEqual(['wss://sodix.edufeed.org']);
  });

  it('rejects a relay this deployment does not serve', () => {
    try {
      resolveSessionRelays(q('relays=sodix,evil.example.com'), CONFIG);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConfigError);
      const e = err as SessionConfigError;
      expect(e.details?.unknownNames).toEqual(['evil.example.com']);
      expect(e.details?.knownNames).toContain('sodix');
    }
  });

  it('rejects a relays parameter that names nothing', () => {
    expect(() => resolveSessionRelays(q('relays='), CONFIG)).toThrow(SessionConfigError);
    expect(() => resolveSessionRelays(q('relays=%20,%20'), CONFIG)).toThrow(SessionConfigError);
  });
});

describe('createMcpServerFactory: relay clients of standalone requests', () => {
  const config = {
    ambRelays: ['wss://relay.edufeed.org'],
    ambExtraRelays: ['wss://oersi.edufeed.org', 'wss://sodix.edufeed.org'],
    calendarRelays: ['wss://relay.edufeed.org'],
  };
  const q = (s = '') => new URLSearchParams(s);
  const toolNames = (server: unknown) =>
    Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools);

  it('two standalone requests with the same relay config reuse one relay client', () => {
    const factory = createMcpServerFactory(config);
    const a = factory.build({ scopes: ['mcp:read'], query: q(), standalone: true });
    const b = factory.build({ scopes: ['mcp:read'], query: q(), standalone: true });
    expect(a.server).not.toBe(b.server);
    expect(b.ambClient).toBe(a.ambClient);
    expect(b.calendarClient).toBe(a.calendarClient);
    factory.close();
  });

  it('does not close the shared client when one request is done', () => {
    const factory = createMcpServerFactory(config);
    const a = factory.build({ scopes: ['mcp:read'], query: q(), standalone: true });
    const close = vi.spyOn(a.ambClient, 'close');
    a.dispose();
    expect(close).not.toHaveBeenCalled();
    factory.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps ?relays= apart: another relay set is another client with its own defaults', () => {
    const factory = createMcpServerFactory(config);
    const plain = factory.build({ scopes: ['mcp:read'], query: q(), standalone: true });
    const sodix = factory.build({ scopes: ['mcp:read'], query: q('relays=sodix'), standalone: true });
    const sodixAgain = factory.build({ scopes: ['mcp:read'], query: q('relays=sodix'), standalone: true });
    expect(sodix.ambClient).not.toBe(plain.ambClient);
    expect(sodixAgain.ambClient).toBe(sodix.ambClient);
    expect(plain.ambClient.getRelays()).toEqual(['wss://relay.edufeed.org']);
    expect(sodix.ambClient.getRelays()).toEqual(['wss://sodix.edufeed.org']);
    factory.close();
  });

  it('shares connections, not scopes: each request gets the tools of its own token', () => {
    const factory = createMcpServerFactory(config);
    const extract = factory.build({ scopes: ['mcp:read', 'mcp:extract'], query: q(), standalone: true });
    const read = factory.build({ scopes: ['mcp:read'], query: q(), standalone: true });
    expect(read.ambClient).toBe(extract.ambClient);
    expect(toolNames(extract.server)).toContain('extract_metadata');
    expect(toolNames(read.server)).not.toContain('extract_metadata');
    factory.close();
  });

  it('gives a session its own client, closed with the session', () => {
    const factory = createMcpServerFactory(config);
    const standalone = factory.build({ scopes: ['mcp:read'], query: q(), standalone: true });
    const session = factory.build({ scopes: ['mcp:read'], query: q(), standalone: false });
    expect(session.ambClient).not.toBe(standalone.ambClient);
    const close = vi.spyOn(session.ambClient, 'close');
    session.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    factory.close();
  });

  it('stops caching past the cap: further relay sets get a client of their own', () => {
    const factory = createMcpServerFactory({ ...config, maxSharedClients: 1 });
    const first = factory.build({ scopes: ['mcp:read'], query: q(), standalone: true });
    const overflow = factory.build({ scopes: ['mcp:read'], query: q('relays=sodix'), standalone: true });
    const close = vi.spyOn(overflow.ambClient, 'close');
    overflow.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(factory.build({ scopes: ['mcp:read'], query: q(), standalone: true }).ambClient).toBe(first.ambClient);
    factory.close();
  });
});
