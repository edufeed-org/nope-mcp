import type { NostrEvent } from 'nostr-tools';
import { normalizeLicenseUri, OPEN_LICENSE_URIS } from './open.js';

/**
 * License-tier classification for kind-30142 learning resources (laoc,
 * 2026-10-28, docs/superpowers/specs/2026-10-28-license-tiers-design.md).
 * `isOpenLicense` (open.ts) still answers the narrower "is this one of the
 * four historically-allowlisted licenses" question used by search's default
 * filtering; this module answers the broader "which of the four tiers does
 * any license:id fall into" question that drives accessLevel.
 *
 * Groups:
 * - `open`:  CC0, PDM, CC BY, CC BY-SA — the existing open-license set.
 * - `cc`:    every other CC license (BY-NC, BY-SA-NC, BY-ND, BY-NC-ND).
 * - `other`: a present `license:id` that isn't a recognized CC/PD URI.
 * - `none`:  no `license:id` at all.
 * `open` and `cc` both grant full access; `other` and `none` are
 * metadata-only (all-rights-reserved and unknown licenses are treated the
 * same way — we never assume permission).
 */

export type LicenseGroup = 'open' | 'cc' | 'other' | 'none';
export type AccessLevel = 'full' | 'metadata-only';
export type LicenseFilter = 'open' | 'cc-any' | 'any';

export interface LicenseInfo {
  id: string;
  label: string;
}

// CC0/PDM don't carry a license "variant" the way BY/BY-SA/… do.
const PUBLIC_DOMAIN_RE =
  /^https:\/\/creativecommons\.org\/publicdomain\/(zero|mark)\/(\d+(?:\.\d+)?)$/;

// Captures the variant, the version, and an optional 2-3 letter ported
// jurisdiction (de, us, igo, …) that normalizeLicenseUri leaves in place.
// Excludes nc/nd/sa from the port, mirroring OPEN_PATTERNS in open.ts: those
// are license-element tokens, not jurisdictions, so "…/by/4.0/nc" must not
// read as a ported "by" license.
const CC_LICENSE_RE =
  /^https:\/\/creativecommons\.org\/licenses\/(by|by-sa|by-nc|by-nc-sa|by-nd|by-nc-nd)\/(\d+(?:\.\d+)?)(?:\/(?!(?:nc|nd|sa)$)([a-z]{2,3}))?$/;

// The two variants that make up the `open` tier (same set as isOpenLicense).
const OPEN_VARIANTS = new Set(['by', 'by-sa']);

const CC_VARIANT_LABEL: Record<string, string> = {
  by: 'BY',
  'by-sa': 'BY-SA',
  'by-nc': 'BY-NC',
  'by-nc-sa': 'BY-NC-SA',
  'by-nd': 'BY-ND',
  'by-nc-nd': 'BY-NC-ND',
};

/**
 * Classifies a `license:id` URI into a tier and, for `open`/`cc`/`other`, a
 * human-readable label. Reuses normalizeLicenseUri so http/https, trailing
 * slashes and legalcode/deed pages don't change the result. `uri` is kept
 * verbatim as `license.id` — it is not the normalized form.
 */
export function classifyLicense(
  uri: string | undefined
): { group: LicenseGroup; license: LicenseInfo | null } {
  if (!uri || !uri.trim()) return { group: 'none', license: null };

  const norm = normalizeLicenseUri(uri);

  const pd = norm.match(PUBLIC_DOMAIN_RE);
  if (pd) {
    const [, variant, version] = pd;
    const label = variant === 'zero' ? `CC0 ${version}` : `PDM ${version}`;
    return { group: 'open', license: { id: uri, label } };
  }

  const cc = norm.match(CC_LICENSE_RE);
  if (cc) {
    const [, variant, version, port] = cc;
    const label = `CC ${CC_VARIANT_LABEL[variant]} ${version}${port ? ` ${port.toUpperCase()}` : ''}`;
    const group: LicenseGroup = OPEN_VARIANTS.has(variant) ? 'open' : 'cc';
    return { group, license: { id: uri, label } };
  }

  return { group: 'other', license: { id: uri, label: 'unknown' } };
}

/** `open`/`cc` unlock full access; `other`/`none` are metadata-only. */
export function accessLevelFor(group: LicenseGroup): AccessLevel {
  return group === 'open' || group === 'cc' ? 'full' : 'metadata-only';
}

/** Whether a classified group satisfies a requested license filter ceiling. */
export function matchesLicenseFilter(group: LicenseGroup, filter: LicenseFilter): boolean {
  if (filter === 'open') return group === 'open';
  if (filter === 'cc-any') return group === 'open' || group === 'cc';
  return true; // 'any' admits open, cc, other and none
}

/** A kind-30142 event's `license:id` tag, classified with its access level. */
export function eventLicense(
  event: NostrEvent
): { group: LicenseGroup; license: LicenseInfo | null; accessLevel: AccessLevel } {
  const { group, license } = classifyLicense(event.tags.find((t) => t[0] === 'license:id')?.[1]);
  return { group, license, accessLevel: accessLevelFor(group) };
}

/**
 * Every exact `license:id` spelling stored on the AMB relays (inventory:
 * test/fixtures/license-ids.json, sampled 2026-10-02) that classifies `open`
 * or `cc` — a superset of OPEN_LICENSE_URIS extending it with the sampled
 * BY-NC/BY-ND/BY-NC-SA/BY-NC-ND spellings. Same purpose as OPEN_LICENSE_URIS:
 * an exact-match list for relay-side `license.id:` field filters, which only
 * match stored spellings verbatim; classifyLicense's regex is the source of
 * truth and never lets a non-CC spelling through even if it's missing here.
 */
export const CC_LICENSE_URIS: readonly string[] = [
  ...OPEN_LICENSE_URIS,
  'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  'https://creativecommons.org/licenses/by-nc-nd/4.0/',
  'https://creativecommons.org/licenses/by-nc/4.0/',
  'https://creativecommons.org/licenses/by-nc/3.0/',
  'https://creativecommons.org/licenses/by-nd/4.0/',
  'https://creativecommons.org/licenses/by-nc-nd/3.0/de/',
  'https://creativecommons.org/licenses/by-nc-sa/3.0/',
  'https://creativecommons.org/licenses/by-nc-nd/3.0/',
  'https://creativecommons.org/licenses/by-nc-nd/3.0/us/',
  'https://creativecommons.org/licenses/by-nc-nd/2.5/ch/',
  'https://creativecommons.org/licenses/by-nc-nd/3.0/gr/',
  'https://creativecommons.org/licenses/by-nc-sa/3.0/de/',
  'https://creativecommons.org/licenses/by-nd/3.0/de/',
  'http://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.de',
  'https://creativecommons.org/licenses/by-nc-sa/2.5/',
  'https://creativecommons.org/licenses/by-nc-sa/3.0/gr/',
  'https://creativecommons.org/licenses/by-nc/3.0/de/',
  'http://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.de',
  'https://creativecommons.org/licenses/by-nc-sa/2.0/',
  'http://creativecommons.org/licenses/by-nc-nd/3.0/es/',
  'http://creativecommons.org/licenses/by-nc-nd/3.0/us/',
  'http://creativecommons.org/licenses/by-nd/4.0/legalcode.de',
  'https://creativecommons.org/licenses/by-nd/3.0/',
  'http://creativecommons.org/licenses/by-nc-sa/3.0/',
  'http://creativecommons.org/licenses/by-nc/4.0/legalcode.de',
  'http://creativecommons.org/licenses/by-nd/3.0/',
  'http://creativecommons.org/licenses/by-nd/3.0/us/',
  'https://creativecommons.org/licenses/by-nc-sa/3.0/us/',
];
