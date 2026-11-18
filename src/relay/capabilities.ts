/**
 * Relays a caller names for one search ("also use this relay"), beyond the
 * configured set: which URLs are acceptable, and whether such a relay
 * understands the `prefer.*` search hints nope-relay does.
 */
import { isIP } from 'node:net';

/**
 * Throws unless url is a public wss relay address: wss scheme, a hostname
 * with a dot that is not an IP literal, no credentials, no port but 443.
 * This server connects to whatever an anonymous caller names, so it must not
 * be steerable into a private network.
 * shortcut: checks syntax only, no DNS-rebinding protection; add a resolved-address check if nope-mcp ever runs where private services have public names.
 */
export function assertPublicRelayUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`extraRelays: not a URL: ${url}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'wss:') throw new Error(`extraRelays: only wss:// relays are accepted: ${url}`);
  if (u.username || u.password) throw new Error(`extraRelays: credentials in the URL are not accepted: ${url}`);
  if (u.port && u.port !== '443') throw new Error(`extraRelays: only port 443 is accepted: ${url}`);
  if (isIP(host) || !host.includes('.') || host.endsWith('.')) throw new Error(`extraRelays: a public hostname is required: ${url}`);
}

const cache = new Map<string, { at: number; value: boolean }>();
const TTL_MS = 3_600_000;

/**
 * Whether the relay advertises the prefer.* hints in its NIP-11 document
 * (limitation.search_extensions, or "ext prefer.level" in nip50). Asked once
 * per hour and URL; any error counts as "no", so an unknown relay just gets
 * the plain search text.
 */
export async function understandsHints(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = false;
  try {
    const res = await fetchFn(url.replace(/^wss:/, 'https:'), {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(3000),
    });
    const doc = (await res.json()) as { limitation?: { search_extensions?: unknown }; nip50?: unknown };
    const ext = doc.limitation?.search_extensions;
    value =
      (Array.isArray(ext) && ext.includes('prefer.level')) ||
      (Array.isArray(doc.nip50) && doc.nip50.includes('ext prefer.level'));
  } catch {
    value = false;
  }
  cache.set(url, { at: Date.now(), value });
  return value;
}
