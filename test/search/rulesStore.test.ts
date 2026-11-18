import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent, nip19, type NostrEvent } from 'nostr-tools';
import rulesJson from '../../src/search/rules.de.json' with { type: 'json' };
import { activeRules, defaultRules, setActiveRules } from '../../src/search/intent.js';
import { refreshRules } from '../../src/search/rulesStore.js';

const D = 'edufeed-search-rules:de';
const author = generateSecretKey();
const stranger = generateSecretKey();
const naddr = nip19.naddrEncode({ kind: 30078, pubkey: getPublicKey(author), identifier: D, relays: ['wss://rules.example.org'] });
const withStopword = (w: string) => JSON.stringify({ ...rulesJson, stopwords: [...rulesJson.stopwords, w] });
const ev = (sk: Uint8Array, content: string, created_at: number): NostrEvent =>
  finalizeEvent({ kind: 30078, created_at, tags: [['d', D]], content }, sk);
const source = (events: NostrEvent[]) => async () => events;

describe('refreshRules', () => {
  beforeEach(() => setActiveRules(defaultRules));

  it('adopts a valid event from the addressed author', async () => {
    expect(await refreshRules(naddr, source([ev(author, withStopword('testwort'), 100)]))).toBe(true);
    expect(activeRules().stopwords.has('testwort')).toBe(true);
  });
  it('keeps the active rules when the content is invalid', async () => {
    await refreshRules(naddr, source([ev(author, withStopword('testwort'), 100)]));
    expect(await refreshRules(naddr, source([ev(author, '{', 200)]))).toBe(false);
    expect(activeRules().stopwords.has('testwort')).toBe(true);
  });
  it('ignores the same d from another author and a forged event', async () => {
    expect(await refreshRules(naddr, source([ev(stranger, withStopword('fremdwort'), 300)]))).toBe(false);
    // through JSON, as from the wire: a spread would copy nostr-tools' cached "verified" mark
    const forged = { ...JSON.parse(JSON.stringify(ev(stranger, withStopword('gefaelscht'), 400))), pubkey: getPublicKey(author) };
    expect(await refreshRules(naddr, source([forged]))).toBe(false);
    expect(activeRules()).toBe(defaultRules);
  });
  it('does not go back to an older event', async () => {
    await refreshRules(naddr, source([ev(author, withStopword('neu'), 5000)]));
    expect(await refreshRules(naddr, source([ev(author, withStopword('alt'), 4000)]))).toBe(false);
    expect(activeRules().stopwords.has('neu')).toBe(true);
  });
  it('never throws: a failing source or a wrong naddr is just false', async () => {
    expect(await refreshRules(naddr, async () => { throw new Error('down'); })).toBe(false);
    expect(await refreshRules('nonsense', source([]))).toBe(false);
    expect(await refreshRules(nip19.naddrEncode({ kind: 30023, pubkey: getPublicKey(author), identifier: D }), source([]))).toBe(false);
  });
});
