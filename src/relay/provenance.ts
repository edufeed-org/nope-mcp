import type { NostrEvent } from 'nostr-tools';

/** Source relay per event object (not per id: a copy carries no provenance). */
const eventRelays = new WeakMap<NostrEvent, string>();

export function setEventRelay(event: NostrEvent, url: string): void {
  eventRelays.set(event, url);
}

export function getEventRelay(event: NostrEvent): string | undefined {
  return eventRelays.get(event);
}

/**
 * Collect events from several relays: regular kinds dedupe by id (first wins);
 * replaceable kinds (0, 3, 10000–19999) by `kind:pubkey` and addressable kinds
 * (30000–39999) by `kind:pubkey:d`, a newer `created_at` replacing the older
 * in place so per-relay arrival order is kept.
 */
export function makeEventCollector(): {
  onevent(event: NostrEvent, url: string | undefined): void;
  events: NostrEvent[];
} {
  const events: NostrEvent[] = [];
  const index = new Map<string, number>();
  return {
    events,
    onevent(event, url) {
      const k = event.kind;
      const key =
        k >= 30000 && k < 40000
          ? `${k}:${event.pubkey}:${event.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`
          : k === 0 || k === 3 || (k >= 10000 && k < 20000)
            ? `${k}:${event.pubkey}`
            : event.id;
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, events.length);
        events.push(event);
      } else if (event.created_at > events[at].created_at) {
        events[at] = event;
      } else {
        return;
      }
      // Both query paths pass the configured spelling (as in relaysSearched / list_relays).
      if (url) setEventRelay(event, url);
    },
  };
}
