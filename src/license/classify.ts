import type { NostrEvent } from 'nostr-tools';
import { licenseTagValues } from './tag.js';

/**
 * License-tier classification for kind-30142 learning resources (laoc,
 * 2026-10-28, docs/superpowers/specs/2026-10-28-license-tiers-design.md).
 Since 2026-11-01 classification reads ALL `license:id` tags and also
 * recognises DINI AG KIM license-type concepts and free software /
 * documentation licences (see classifyLicenses; the same contract is
 * implemented by amb-indexer license.go). `isOpenLicense` (open.ts) is
 * `group === 'open'` for a single value.
 *
 * Groups:
 * - `open`:  CC0, PDM, CC BY, CC BY-SA, their KIM equivalents (attribution,
 *            attribution+shareAlike, publicDomain) and GPL/LGPL/AGPL/GFDL/
 *            MIT/Apache-2.0/BSD.
 * - `cc`:    every other CC license (BY-NC, BY-NC-SA, BY-ND, BY-NC-ND),
 *            including KIM nonCommercial/noDerivatives compositions.
 * - `other`: a present license value that isn't recognized as one of the
 *            above (incl. KIM noLicense and "Urheberrecht" markers).
 * - `none`:  no license value at all.
 * `open` and `cc` both grant full access; `other` and `none` are
 * metadata-only (all-rights-reserved and unknown licenses are treated the
 * same way — we never assume permission).
 */

export type LicenseGroup = 'open' | 'cc' | 'other' | 'none';

/**
 * User-facing definitions of the license filters / access level, shared by
 * the server instructions and every tool description so they can't drift.
 */
export const LICENSE_TEXT = {
  open:
    'CC0, Public Domain, CC BY, CC BY-SA, their DINI-AG-KIM license-type equivalents, ' +
    'and free software/documentation licenses (GPL, LGPL, AGPL, GFDL, MIT, Apache 2.0, BSD)',
  ccAny: 'all of "open" plus every other Creative Commons license, incl. KIM non-commercial/no-derivatives',
  full: 'Creative Commons, Public Domain and free software/documentation licenses, incl. DINI-AG-KIM license types',
} as const;
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
 * Canonical form for comparison: trimmed, lowercased, https, without a
 * trailing legalcode / deed.* page and without the trailing slash. For the
 * free-licence hosts (gnu.org, opensource.org, apache.org, spdx.org) a
 * trailing `-standalone.html` / `.html` / `.txt` page suffix is dropped too.
 */
export function normalizeLicenseUri(uri: string): string {
  return canonicalLicenseUri(uri).toLowerCase();
}

/** normalizeLicenseUri without the lowercasing (SPDX labels keep their case). */
function canonicalLicenseUri(uri: string): string {
  let out = uri
    .trim()
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/(legalcode[^/]*|deed\.[^/]*)\/?$/i, '')
    .replace(/\/+$/, '');
  if (FREE_LICENSE_HOST_RE.test(out)) {
    out = out.replace(/(?:-standalone\.html|\.html|\.txt)$/i, '');
  }
  return out;
}

const FREE_LICENSE_HOST_RE =
  /^https:\/\/(?:www\.)?(?:gnu\.org|opensource\.org|apache\.org|spdx\.org)\//i;

/** DINI AG KIM license-type concepts (https://w3id.org/kim/license/), lowercased term → canonical term. */
const KIM_LICENSE_RE = /^https:\/\/w3id\.org\/kim\/license\/([a-z-]+)$/;
const KIM_TERMS = new Set([
  'publicdomain', 'attribution', 'sharealike', 'noderivatives',
  'noncommercial', 'noncommercial-noderivatives', 'nolicense',
]);

const GNU_LICENSE_RE = /^https:\/\/(?:www\.)?gnu\.org\/licenses\/(gpl|lgpl|agpl|fdl)-(\d+(?:\.\d+)*)$/;
const GNU_FAMILY_LABEL: Record<string, string> = { gpl: 'GPL', lgpl: 'LGPL', agpl: 'AGPL', fdl: 'GFDL' };
const MIT_RE = /^https:\/\/opensource\.org\/licenses?\/mit$/;
const APACHE_RE = /^https:\/\/(?:www\.)?apache\.org\/licenses\/license-2\.0$/;
const BSD_RE = /^https:\/\/opensource\.org\/licenses?\/bsd-([23])-clause$/;
const SPDX_RE =
  /^https:\/\/spdx\.org\/licenses\/((?:gpl|lgpl|agpl|gfdl)-\d[0-9a-z.+-]*|mit|apache-2\.0|bsd-[23]-clause)$/i;

// de.wikipedia "Urheberrecht (Deutschland)", used by sources as an
// all-rights-reserved marker; parentheses may be URL-encoded.
const ALL_RIGHTS_RESERVED_RE =
  /^https:\/\/de\.wikipedia\.org\/wiki\/urheberrecht_(?:\(|%28)deutschland(?:\)|%29)$/;

type Classified = { group: LicenseGroup; license: LicenseInfo | null };

/** Rule 1: a Creative Commons / Public Domain URI, or null. */
function classifyCc(uri: string): Classified | null {
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
  return null;
}

/** The lowercased KIM license-type term of a value, or null when it isn't a known KIM concept. */
function kimTerm(uri: string): string | null {
  const term = normalizeLicenseUri(uri).match(KIM_LICENSE_RE)?.[1];
  return term && KIM_TERMS.has(term) ? term : null;
}

/** Rule 2: compose the SET of KIM terms into one classification. */
function classifyKim(id: string, terms: Set<string>): Classified {
  const unknown: Classified = { group: 'other', license: { id, label: 'unknown' } };
  if (terms.has('nolicense')) return { group: 'other', license: { id, label: 'Keine Lizenz (KIM)' } };
  if (terms.has('publicdomain')) {
    return terms.size === 1 ? { group: 'open', license: { id, label: 'Public Domain (KIM)' } } : unknown;
  }
  // attribution is implied: every CC ≥4.0 licence is BY.
  const nc = terms.has('noncommercial') || terms.has('noncommercial-noderivatives');
  const nd = terms.has('noderivatives') || terms.has('noncommercial-noderivatives');
  const sa = terms.has('sharealike');
  if (sa && nd) return unknown; // contradictory
  const variant = `by${nc ? '-nc' : ''}${sa ? '-sa' : ''}${nd ? '-nd' : ''}`;
  const group: LicenseGroup = OPEN_VARIANTS.has(variant) ? 'open' : 'cc';
  return { group, license: { id, label: `${variant.toUpperCase()} (KIM)` } };
}

/** Rule 3: a free software / documentation licence label, or null. */
function freeLicenseLabel(uri: string): string | null {
  const canon = canonicalLicenseUri(uri);
  const norm = canon.toLowerCase();
  const gnu = norm.match(GNU_LICENSE_RE);
  if (gnu) return `${GNU_FAMILY_LABEL[gnu[1]]}-${gnu[2]}`;
  if (MIT_RE.test(norm)) return 'MIT';
  if (APACHE_RE.test(norm)) return 'Apache-2.0';
  const bsd = norm.match(BSD_RE);
  if (bsd) return `BSD-${bsd[1]}-Clause`;
  const spdx = canon.match(SPDX_RE);
  if (spdx) return spdx[1]; // the SPDX id as written
  return null;
}

/**
 * Classifies ALL of an event's license values (trimmed, empty ones dropped,
 * in tag order) into a tier and label — the shared amb-mcp/amb-indexer
 * contract (laoc, 2026-11-01). First rule that matches wins:
 * 1. the first Creative Commons / Public Domain URI decides;
 * 2. DINI AG KIM license-type concepts, composed as a set into a CC variant
 *    (e.g. [attribution, shareAlike] → "BY-SA (KIM)", open;
 *    [attribution, nonCommercial] → "BY-NC (KIM)", cc; noLicense and
 *    contradictory sets → other); id = the first KIM value;
 * 3. the first free software / documentation licence (GPL, LGPL, AGPL, GFDL,
 *    MIT, Apache-2.0, BSD, SPDX ids of those) → open;
 * 4. the de.wikipedia "Urheberrecht (Deutschland)" marker → other,
 *    "Alle Rechte vorbehalten";
 * 5. otherwise other/"unknown" with the first value; no values → none.
 * `license.id` is always a value verbatim, not its normalized form.
 */
export function classifyLicenses(uris: readonly (string | undefined)[]): Classified {
  const values = uris.map((u) => u?.trim() ?? '').filter((u) => u.length > 0);
  if (values.length === 0) return { group: 'none', license: null };

  for (const v of values) {
    const cc = classifyCc(v);
    if (cc) return cc;
  }

  const kimValues = values.filter((v) => kimTerm(v) !== null);
  if (kimValues.length > 0) {
    return classifyKim(kimValues[0], new Set(kimValues.map((v) => kimTerm(v)!)));
  }

  for (const v of values) {
    const label = freeLicenseLabel(v);
    if (label) return { group: 'open', license: { id: v, label } };
  }

  const arr = values.find((v) => ALL_RIGHTS_RESERVED_RE.test(normalizeLicenseUri(v)));
  if (arr) return { group: 'other', license: { id: arr, label: 'Alle Rechte vorbehalten' } };

  return { group: 'other', license: { id: values[0], label: 'unknown' } };
}

/**
 * License values from an untyped payload field (e.g. an indexer hit's
 * `amb.license`): a string, or an array of strings for multi-tag events.
 */
export function licenseValuesOf(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Classifies a single license URI — classifyLicenses with one value. Note
 * that `license.id` is the trimmed value, not its normalized form.
 */
export function classifyLicense(uri: string | undefined): Classified {
  return classifyLicenses([uri]);
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

const LICENSE_FILTER_RANK: Record<LicenseFilter, number> = { open: 0, 'cc-any': 1, any: 2 };

function isLicenseFilter(value: string): value is LicenseFilter {
  return Object.hasOwn(LICENSE_FILTER_RANK, value);
}

/**
 * The operator ceiling for search license filtering, read once at startup.
 * `LICENSE_FILTER_MAX` (open | cc-any | any, default any) wins; an invalid
 * value throws so a typo can't silently widen or narrow what is served.
 * The legacy `OPEN_LICENSES_ONLY` (true unless false/0/no/off) is honoured
 * only when LICENSE_FILTER_MAX is unset — true maps to `open`, false to
 * `any` — and its presence always logs one deprecation line via `warn`.
 */
export function parseLicenseFilterMax(
  env: { LICENSE_FILTER_MAX?: string; OPEN_LICENSES_ONLY?: string },
  warn: (m: string) => void = console.warn
): LicenseFilter {
  const legacy = env.OPEN_LICENSES_ONLY?.trim().toLowerCase();
  const max = env.LICENSE_FILTER_MAX?.trim().toLowerCase();

  if (legacy) {
    warn(
      'OPEN_LICENSES_ONLY is deprecated; use LICENSE_FILTER_MAX=open|cc-any|any instead' +
        (max ? ' (ignored: LICENSE_FILTER_MAX is set).' : '.')
    );
  }

  if (max) {
    if (!isLicenseFilter(max)) {
      throw new Error(
        `Invalid LICENSE_FILTER_MAX "${env.LICENSE_FILTER_MAX}": expected open, cc-any or any.`
      );
    }
    return max;
  }
  if (legacy) return ['false', '0', 'no', 'off'].includes(legacy) ? 'any' : 'open';
  return 'any';
}

/**
 * Applies the operator ceiling to a requested filter (ordered open < cc-any
 * < any). No request means the ceiling itself; a wider request is narrowed
 * to the ceiling and reported as clamped.
 */
export function clampLicenseFilter(
  requested: LicenseFilter | undefined,
  max: LicenseFilter
): { effective: LicenseFilter; clamped: boolean } {
  if (requested === undefined) return { effective: max, clamped: false };
  if (LICENSE_FILTER_RANK[requested] > LICENSE_FILTER_RANK[max]) {
    return { effective: max, clamped: true };
  }
  return { effective: requested, clamped: false };
}

/**
 * A kind-30142 event's license, classified with its access level over ALL
 * its `license:id` tags (classifyLicenses), falling back to the plain
 * `license` tag when there is none (licenseTagValues, amb-indexer parity).
 */
export function eventLicense(
  event: NostrEvent
): { group: LicenseGroup; license: LicenseInfo | null; accessLevel: AccessLevel } {
  const { group, license } = classifyLicenses(licenseTagValues(event));
  return { group, license, accessLevel: accessLevelFor(group) };
}

/**
 * The exact `license:id` strings stored on the AMB relays that classify open
 * (inventory: test/fixtures/license-ids.json), plus the DINI AG KIM terms
 * that classify open on their own (attribution, shareAlike, publicDomain),
 * used as `license.id:` filters by search_resources only when the search has
 * no free text (see buildFilter). The relay matches field filters exactly,
 * so every stored spelling is listed; a test keeps this in lock-step with
 * the fixture. An open variant missing here is only left out relay-side —
 * the classifyLicenses post-filter never lets a non-open one through.
 *
 * The relay indexes only one `license.id` per event, so a multi-tag KIM
 * event such as [attribution, nonCommercial] can pass this prefilter on
 * "attribution"; the multi-tag post-filter (eventLicense) then drops it.
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
  // DINI AG KIM license types that classify open on their own
  'https://w3id.org/kim/license/attribution',
  'https://w3id.org/kim/license/shareAlike',
  'https://w3id.org/kim/license/publicDomain',
  // Free software / documentation licences (stored spellings, oersi)
  'https://www.gnu.org/licenses/fdl-1.3.html',
  'https://www.gnu.org/licenses/gpl-3.0',
  'https://opensource.org/licenses/MIT',
  'https://opensource.org/license/mit',
  'https://www.apache.org/licenses/LICENSE-2.0',
  'https://www.gnu.org/licenses/gpl-3.0.html',
  'https://www.gnu.org/licenses/fdl-1.3',
  'https://www.gnu.org/licenses/gpl-3.0.txt',
  'http://www.gnu.org/licenses/gpl-3.0',
  'https://opensource.org/license/bsd-3-clause',
  'https://www.gnu.org/licenses/gpl-3.0-standalone.html',
];

/**
 * Every exact `license:id` spelling stored on the AMB relays (inventory:
 * test/fixtures/license-ids.json) that classifies `open` or `cc`, plus every
 * KIM term that can classify open/cc — a superset of OPEN_LICENSE_URIS
 * extending it with the BY-NC/BY-ND/BY-NC-SA/BY-NC-ND spellings and the KIM
 * nonCommercial/noDerivatives terms. Same purpose as OPEN_LICENSE_URIS: an
 * exact-match list for relay-side `license.id:` field filters, which only
 * match stored spellings verbatim; classifyLicenses is the source of truth
 * and never lets a non-open/cc event through even if its spelling is here.
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
  // DINI AG KIM license types that classify cc (alone or composed)
  'https://w3id.org/kim/license/nonCommercial',
  'https://w3id.org/kim/license/noDerivatives',
  'https://w3id.org/kim/license/nonCommercial-noDerivatives',
];
