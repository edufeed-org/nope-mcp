/**
 * Loads the search rules from the kind-30078 Nostr event named by SEARCH_RULES
 * (an naddr), so nope-mcp and the relays read one list. Only an event of that
 * kind, author and d tag with a valid signature and a document parseRules
 * accepts is adopted; anything else leaves the active rules as they are.
 */
import { SimplePool, nip19, verifyEvent, type Filter, type NostrEvent } from 'nostr-tools';
import WebSocket from 'ws';
import { parseRules, setActiveRules } from './intent.js';

type Fetch = (relays: string[], filter: Filter) => Promise<NostrEvent[]>;

const fromRelays: Fetch = async (relays, filter) => {
  const pool = new SimplePool({ websocketImplementation: WebSocket } as unknown as ConstructorParameters<typeof SimplePool>[0]);
  try {
    return await pool.querySync(relays, filter, { maxWait: 5000 });
  } finally {
    pool.close(relays);
  }
};

let adoptedAt = 0; // created_at of the adopted event: a stale copy must not roll the rules back

/** Fetch and adopt the rules event. Never throws; false means the active rules were kept. */
export async function refreshRules(naddr: string, fetchEvents: Fetch = fromRelays, fallbackRelays: string[] = []): Promise<boolean> {
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== 'naddr' || decoded.data.kind !== 30078) throw new Error('SEARCH_RULES must be an naddr of kind 30078');
    const { pubkey, identifier, relays } = decoded.data;
    const events = await fetchEvents(relays?.length ? relays : fallbackRelays, { kinds: [30078], authors: [pubkey], '#d': [identifier] });
    const newest = events
      .filter((e) => e.kind === 30078 && e.pubkey === pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === identifier) && verifyEvent(e))
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!newest) throw new Error('event not found');
    if (newest.created_at < adoptedAt) throw new Error('event is older than the active rules');
    setActiveRules(parseRules(JSON.parse(newest.content)));
    adoptedAt = newest.created_at;
    return true;
  } catch (err) {
    console.error(`search rules: ${(err as Error).message}; keeping the active rules`);
    return false;
  }
}

/** Load the rules now and then every `everyMs`. Without an naddr the built-in rules stay. */
export function startRulesRefresh(naddr: string | undefined, fallbackRelays: string[], everyMs = 3_600_000): void {
  if (!naddr) return;
  void refreshRules(naddr, fromRelays, fallbackRelays);
  setInterval(() => void refreshRules(naddr, fromRelays, fallbackRelays), everyMs).unref();
}
