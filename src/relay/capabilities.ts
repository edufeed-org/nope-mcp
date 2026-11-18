/**
 * Relays a caller names for one search ("also use this relay"), beyond the
 * configured set: which URLs are acceptable, and whether such a relay
 * understands the `prefer.*` search hints nope-relay does.
 */
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Throws unless url is a public wss relay address: wss scheme, a hostname
 * with a dot that is not an IP literal, no credentials, no port but 443.
 * This server connects to whatever an anonymous caller names, so it must not
 * be steerable into a private network.
 * Syntax only; assertResolvesPublic checks where the name actually points.
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

// Everything that is not a global unicast address: loopback, private,
// link-local (incl. cloud metadata 169.254.169.254), CGNAT, unspecified,
// multicast, unique-local, and the IPv4 ranges again as IPv4-mapped IPv6.
const NON_PUBLIC = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as [string, number][]) {
  NON_PUBLIC.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as [string, number][]) {
  NON_PUBLIC.addSubnet(net, bits, 'ipv6');
}

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const dnsLookup: Lookup = (host) => lookup(host, { all: true });

/**
 * Throws unless every address the relay's hostname resolves to is public. A
 * public-looking name can point into a private network; an anonymous caller
 * must not get this server to connect there.
 * shortcut: the connection is not pinned to the checked address, so a DNS answer that changes between this check and the connect (rebinding) is not caught; pin via a custom lookup when the WebSocket library allows it.
 */
export async function assertResolvesPublic(url: string, lookupFn: Lookup = dnsLookup): Promise<void> {
  const host = new URL(url).hostname;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookupFn(host);
  } catch {
    throw new Error(`extraRelays: ${host} does not resolve`);
  }
  if (addresses.length === 0) throw new Error(`extraRelays: ${host} does not resolve`);
  for (const { address } of addresses) {
    const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
    const family = isIP(mapped) === 6 ? 'ipv6' : 'ipv4';
    if (NON_PUBLIC.check(mapped, family)) throw new Error(`extraRelays: ${host} does not resolve to a public address`);
  }
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
      redirect: 'manual', // a redirect could lead anywhere, including into a private network
    });
    if (!res.ok) throw new Error(`NIP-11: HTTP ${res.status}`);
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
