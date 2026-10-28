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

/**
 * Canonical relay-less `nostr:naddr1…` for a replaceable-event coordinate.
 *
 * Byte-exact per NIP-VOCAB: TLV 0 (d, UTF-8), then 2 (author), then 3 (kind,
 * 32-bit big-endian), no relay TLVs. nostr-tools' `naddrEncode` writes the
 * kind first, which decodes to the same triple but is a different string —
 * every other edufeed component (nostr-vocab-core, go-nostr, nostrlib)
 * emits the 0/2/3 order, and sameness hashes compare the string.
 */
export function canonicalNostrUri(kind: number, pubkey: string, identifier: string): string {
  const d = new TextEncoder().encode(identifier);
  if (d.length > 255) throw new Error(`NIP-19 TLV: identifier is ${d.length} bytes, max 255`);
  const pk = hexToBytes(pubkey);
  const bytes = new Uint8Array(2 + d.length + 2 + 32 + 2 + 4);
  let o = 0;
  bytes[o++] = 0;
  bytes[o++] = d.length;
  bytes.set(d, o);
  o += d.length;
  bytes[o++] = 2;
  bytes[o++] = 32;
  bytes.set(pk, o);
  o += 32;
  bytes[o++] = 3;
  bytes[o++] = 4;
  bytes[o++] = (kind >>> 24) & 0xff;
  bytes[o++] = (kind >>> 16) & 0xff;
  bytes[o++] = (kind >>> 8) & 0xff;
  bytes[o++] = kind & 0xff;
  return 'nostr:' + nip19.encodeBytes('naddr', bytes);
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('pubkey must be 32 bytes hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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
