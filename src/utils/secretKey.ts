import { nip19 } from 'nostr-tools';

/** A Nostr secret key as 64 hex characters, from hex or nsec. The error never repeats the input. */
export function secretKeyHex(key: string): string {
  const k = key.trim();
  if (/^[0-9a-f]{64}$/i.test(k)) return k.toLowerCase();
  try {
    const decoded = nip19.decode(k);
    if (decoded.type === 'nsec') return Buffer.from(decoded.data).toString('hex');
  } catch {
    // fall through to the one error below
  }
  throw new Error('secret key must be 64 hex characters or an nsec');
}
