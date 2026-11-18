import { describe, it, expect } from 'vitest';
import { assertPublicRelayUrl, understandsHints } from '../../src/relay/capabilities.js';

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
