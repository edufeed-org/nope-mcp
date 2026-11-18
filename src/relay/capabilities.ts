/**
 * Relays a caller names for one search ("also use this relay"), beyond the
 * configured set: which URLs are acceptable, and whether such a relay
 * understands the `prefer.*` search hints nope-relay does.
 */
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';

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
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible addresses
  ['64:ff9b::', 96], ['2002::', 16], // NAT64 and 6to4 reach IPv4 space
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as [string, number][]) {
  NON_PUBLIC.addSubnet(net, bits, 'ipv6');
}

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const dnsLookup: Lookup = (host) => lookup(host, { all: true });

/**
 * Throws unless every address the relay's hostname resolves to is public. A
 * public-looking name can point into a private network; an anonymous caller
 * must not get this server to connect there.
 * This is the early, readable error. The connections themselves use
 * makeSafeLookup, so the address that was checked is the one connected to.
 */
export async function assertResolvesPublic(url: string, lookupFn: Lookup = dnsLookup): Promise<void> {
  const host = new URL(url).hostname;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookupFn(host);
  } catch {
    throw new Error(`extraRelays: ${host} does not resolve`);
  }
  assertPublicAddresses(host, addresses);
}

function assertPublicAddresses(host: string, addresses: { address: string; family: number }[]): void {
  if (addresses.length === 0) throw new Error(`extraRelays: ${host} does not resolve`);
  for (const { address } of addresses) {
    // BlockList matches IPv4-mapped IPv6 addresses against the IPv4 rules itself.
    if (NON_PUBLIC.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')) {
      throw new Error(`extraRelays: ${host} does not resolve to a public address`);
    }
  }
}

type LookupCallback = (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;

/**
 * A `lookup` for node's net/tls/http(s) and for `ws`: resolves the name,
 * rejects it when any address is non-public, and hands the socket exactly the
 * addresses it checked. This closes the gap a separate pre-check leaves (a
 * DNS answer that changes between check and connect).
 */
export function makeSafeLookup(lookupFn: Lookup = dnsLookup) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback): void => {
    lookupFn(hostname).then(
      (addresses) => {
        try {
          assertPublicAddresses(hostname, addresses);
        } catch (err) {
          return callback(err as Error);
        }
        if (typeof options === 'object' && options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      () => callback(new Error(`extraRelays: ${hostname} does not resolve`))
    );
  };
}

/** NIP-11 document over https with the checking lookup: no redirects, at most 64 kB, at most 3 s in total. */
const fetchNip11: typeof fetch = ((url: string) =>
  new Promise<Response>((resolve, reject) => {
    const req = httpsGet(url, { headers: { Accept: 'application/nostr+json' }, lookup: makeSafeLookup() as never }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 65536) req.destroy(new Error('NIP-11 document too large'));
        else chunks.push(c);
      });
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })));
      // a body that stops short of its announced length never emits 'end'
      res.on('close', () => reject(new Error('NIP-11 response closed early')));
      res.on('error', reject);
    });
    // A hard limit on the whole exchange: a server that trickles bytes must
    // not hold a search open (a socket idle timeout would not catch that).
    const timer = setTimeout(() => req.destroy(new Error('NIP-11 timeout')), 3000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  })) as unknown as typeof fetch;

const cache = new Map<string, { at: number; value: boolean }>();
const TTL_MS = 3_600_000;
const MAX_CACHED_HOSTS = 500;

/**
 * Whether the relay advertises the prefer.* hints in its NIP-11 document
 * (limitation.search_extensions, or "ext prefer.level" in nip50). Asked once
 * per hour and URL; any error counts as "no", so an unknown relay just gets
 * the plain search text.
 */
export async function understandsHints(url: string, fetchFn: typeof fetch = fetchNip11): Promise<boolean> {
  // Per host, and only the root document: a caller must not turn this into
  // GET requests to paths of its choosing or grow the cache with query strings.
  const origin = `https://${new URL(url).host}/`;
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = false;
  try {
    const res = await fetchFn(origin, {
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
  if (cache.size >= MAX_CACHED_HOSTS) cache.clear();
  cache.set(origin, { at: Date.now(), value });
  return value;
}
