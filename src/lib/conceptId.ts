/**
 * NIP-VOCAB concept identifiers.
 *
 * A concept without an external `i` URI is identified by the canonical,
 * relay-less `nostr:naddr1…` of its kind-39738 event (NIP-19/NIP-21). Older
 * producers emitted the raw coordinate (`39738:<pubkey>:<d>`) or the legacy
 * `nostr:<kind>:<pubkey>:<d>`; both are accepted on input and never emitted.
 */
import { nip19 } from 'nostr-tools';

const COORD = /^(?:nostr:)?(\d+):([0-9a-f]{64}):(.*)$/s;

/** Canonical relay-less `nostr:naddr1…` for a replaceable-event coordinate. */
export function canonicalNostrUri(kind: number, pubkey: string, identifier: string): string {
  return 'nostr:' + nip19.naddrEncode({ kind, pubkey, identifier, relays: [] });
}

/**
 * Canonicalise every accepted identifier form; anything else (http(s) URIs,
 * garbage) is returned unchanged.
 */
export function canonicalConceptId(value: string): string {
  const coord = COORD.exec(value);
  if (coord) {
    return canonicalNostrUri(Number(coord[1]), coord[2], coord[3]);
  }
  const bech = value.startsWith('nostr:') ? value.slice('nostr:'.length) : value;
  if (/^naddr1/i.test(bech)) {
    try {
      const decoded = nip19.decode(bech.toLowerCase());
      if (decoded.type === 'naddr') {
        const { kind, pubkey, identifier } = decoded.data;
        return canonicalNostrUri(kind, pubkey, identifier);
      }
    } catch {
      // not a valid naddr: leave unchanged
    }
  }
  return value;
}

/**
 * The short, human-readable alias of a Nostr concept: its `d`. Undefined for
 * external URIs. Used to show LLMs a compact id they can echo reliably.
 */
export function conceptAlias(id: string): string | undefined {
  const canonical = canonicalConceptId(id);
  if (!canonical.startsWith('nostr:naddr1')) return undefined;
  try {
    const decoded = nip19.decode(canonical.slice('nostr:'.length));
    return decoded.type === 'naddr' ? decoded.data.identifier : undefined;
  } catch {
    return undefined;
  }
}
