import { describe, it, expect } from 'vitest';
import { assertPublicRelayUrl, assertResolvesPublic, makeSafeLookup, understandsHints } from '../../src/relay/capabilities.js';

describe('assertPublicRelayUrl', () => {
  it('rejects relay URLs that are not public wss', () => {
    for (const bad of [
      'ws://relay.example.org', 'https://relay.example.org', 'wss://127.0.0.1', 'wss://[::1]', 'wss://10.0.0.5',
      'wss://relay.example.org:8080', 'wss://localhost', 'wss://intranet', 'wss://user:pw@relay.example.org', 'not a url',
    ]) {
      expect(() => assertPublicRelayUrl(bad), bad).toThrow();
    }
  });
  it('accepts a public wss relay', () => {
    expect(() => assertPublicRelayUrl('wss://relay.example.org')).not.toThrow();
    expect(() => assertPublicRelayUrl('wss://relay.example.org:443/path')).not.toThrow();
  });
});

describe('understandsHints', () => {
  const doc = (d: unknown) => (async () => new Response(JSON.stringify(d))) as unknown as typeof fetch;
  it('reads hint support from the NIP-11 document', async () => {
    expect(await understandsHints('wss://a.example.org', doc({ limitation: { search_extensions: ['sort', 'prefer.level'] } }))).toBe(true);
    expect(await understandsHints('wss://b.example.org', doc({ nip50: ['ext prefer.level'] }))).toBe(true);
    expect(await understandsHints('wss://c.example.org', doc({ supported_nips: [50] }))).toBe(false);
  });
  it('is false when the document cannot be read', async () => {
    const down = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await understandsHints('wss://d.example.org', down)).toBe(false);
  });
  it('asks each relay once', async () => {
    let calls = 0;
    const counting = (async () => (calls++, new Response('{}'))) as unknown as typeof fetch;
    await understandsHints('wss://e.example.org', counting);
    await understandsHints('wss://e.example.org', counting);
    expect(calls).toBe(1);
  });
});

describe('assertResolvesPublic', () => {
  const to = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  it('rejects a public name that resolves to a private, loopback or link-local address', async () => {
    for (const addr of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      await expect(assertResolvesPublic('wss://relay.example.org', to(addr)), addr).rejects.toThrow();
    }
  });
  it('rejects when any of several addresses is private', async () => {
    await expect(assertResolvesPublic('wss://relay.example.org', to('93.184.216.34', '10.0.0.1'))).rejects.toThrow();
  });
  it('rejects a name that does not resolve', async () => {
    await expect(assertResolvesPublic('wss://relay.example.org', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow();
    await expect(assertResolvesPublic('wss://relay.example.org', to())).rejects.toThrow();
  });
  it('accepts public addresses', async () => {
    await expect(assertResolvesPublic('wss://relay.example.org', to('93.184.216.34', '2606:2800:220:1::1'))).resolves.toBeUndefined();
  });
});

describe('understandsHints does not follow redirects', () => {
  it('treats a redirect as no hints and asks without following', async () => {
    let init: RequestInit | undefined;
    const redirecting = (async (_u: string, i?: RequestInit) => ((init = i), new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }))) as unknown as typeof fetch;
    expect(await understandsHints('wss://redirect.example.org', redirecting)).toBe(false);
    expect(init?.redirect).toBe('manual');
  });
});

describe('safeLookup pins the connection to a checked address', () => {
  const resolver = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const run = (lookupFn: ReturnType<typeof makeSafeLookup>, all: boolean) =>
    new Promise<{ err: Error | null; res: unknown }>((resolve) => lookupFn('relay.example.org', { all }, (err, res) => resolve({ err, res })));

  it('fails the connection when the name resolves to a non-public address', async () => {
    const { err } = await run(makeSafeLookup(resolver('93.184.216.34', '10.0.0.1')), true);
    expect(err).toBeInstanceOf(Error);
  });
  it('hands the checked addresses to the socket', async () => {
    expect((await run(makeSafeLookup(resolver('93.184.216.34')), true)).res).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect((await run(makeSafeLookup(resolver('93.184.216.34')), false)).res).toBe('93.184.216.34');
  });
});
