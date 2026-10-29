import type { NostrEvent } from 'nostr-tools';
import { licenseTagValue } from './tag.js';

/**
 * Open-license policy for search results (laoc, 2026-10-02): learning
 * resources (kind 30142) are returned only under CC0, the Public Domain Mark,
 * CC BY or CC BY-SA — the allowlist amb-indexer uses to expose fulltext
 * (LICENSE_ALLOWLIST "CC0,CC-BY,CC-BY-SA,publicdomain"). NC/ND, "Urheberrecht"
 * and unlicensed resources are not open.
 */

const OPEN_PATTERNS = [
  /^https:\/\/creativecommons\.org\/publicdomain\/(zero|mark)\/\d+(\.\d+)?$/,
  // Optional ported-jurisdiction segment (de, us, igo, …) — never a license
  // element: `…/by/4.0/nc` must not read as an open port.
  /^https:\/\/creativecommons\.org\/licenses\/(by|by-sa)\/\d+(\.\d+)?(\/(?!(?:nc|nd|sa)$)[a-z]{2,3})?$/,
];

/**
 * Canonical form for comparison: trimmed, lowercased, https, without a
 * trailing legalcode / deed.* page and without the trailing slash.
 */
export function normalizeLicenseUri(uri: string): string {
  return uri
    .trim()
    .toLowerCase()
    .replace(/^http:\/\//, 'https://')
    .replace(/\/(legalcode[^/]*|deed\.[^/]*)\/?$/, '')
    .replace(/\/+$/, '');
}

/** True for CC0, PDM, CC BY and CC BY-SA URIs in any version, port or page form. */
export function isOpenLicense(uri: string | undefined): boolean {
  if (!uri || !uri.trim()) return false;
  const norm = normalizeLicenseUri(uri);
  return OPEN_PATTERNS.some((re) => re.test(norm));
}

/**
 * A kind-30142 event's license classified by isOpenLicense; missing = not
 * open. Reads `license:id`, falling back to the plain `license` tag
 * (licenseTagValue, amb-indexer parity).
 */
export function eventHasOpenLicense(event: NostrEvent): boolean {
  return isOpenLicense(licenseTagValue(event));
}

/**
 * The exact `license:id` strings stored on the AMB relays that classify open
 * (inventory: test/fixtures/license-ids.json, sampled 2026-10-02), used as
 * `license.id:` filters by search_resources only when the search has no free
 * text (see buildFilter). The relay matches field filters exactly, so every
 * stored spelling is listed; a test keeps this in lock-step with the fixture.
 * An open variant missing here is only left out relay-side — the
 * isOpenLicense post-filter never lets a non-open one through.
 */
export const OPEN_LICENSE_URIS: readonly string[] = [
  'https://creativecommons.org/licenses/by-sa/4.0/',
  'https://creativecommons.org/licenses/by/4.0/',
  'https://creativecommons.org/licenses/by-sa/3.0/',
  'https://creativecommons.org/publicdomain/zero/1.0/',
  'http://creativecommons.org/licenses/by-sa/4.0/legalcode.de',
  'https://creativecommons.org/licenses/by-sa/3.0/de/',
  'https://creativecommons.org/licenses/by/3.0/',
  'https://creativecommons.org/publicdomain/mark/1.0/',
  'http://creativecommons.org/licenses/by/4.0/legalcode.de',
  'https://creativecommons.org/licenses/by-sa/3.0/us/',
  'http://creativecommons.org/licenses/by-sa/4.0/',
  'http://creativecommons.org/licenses/by/4.0/',
  'https://creativecommons.org/licenses/by-sa/2.5/',
  'https://creativecommons.org/licenses/by-sa/3.0/de/deed.de',
  'https://creativecommons.org/licenses/by/3.0/de/',
  'https://creativecommons.org/licenses/by/4.0/deed.de',
  'https://creativecommons.org/licenses/by-sa/2.0/',
  'https://creativecommons.org/licenses/by/2.0/',
  'https://creativecommons.org/licenses/by-sa/2.0/de/',
  'https://creativecommons.org/licenses/by/2.5/',
  'https://creativecommons.org/licenses/by-sa/4.0/deed.de',
];
