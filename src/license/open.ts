import type { NostrEvent } from 'nostr-tools';
import { classifyLicense, classifyLicenses } from './classify.js';
import { licenseTagValues } from './tag.js';

/**
 * Open-license policy for search results (laoc, 2026-10-02; widened
 * 2026-11-01): a license is "open" exactly when classifyLicenses puts it in
 * the `open` group — CC0, the Public Domain Mark, CC BY, CC BY-SA, their
 * DINI AG KIM license-type equivalents, and free software / documentation
 * licences (GPL, LGPL, AGPL, GFDL, MIT, Apache 2.0, BSD). NC/ND,
 * "Urheberrecht" and unlicensed resources are not open.
 */

export { normalizeLicenseUri, OPEN_LICENSE_URIS } from './classify.js';

/** True when a single license value classifies `open` (classifyLicense). */
export function isOpenLicense(uri: string | undefined): boolean {
  return classifyLicense(uri).group === 'open';
}

/**
 * Whether a kind-30142 event's license classifies `open`, over ALL its
 * `license:id` tags (so [kim/attribution, kim/nonCommercial] is not open),
 * falling back to the plain `license` tag (licenseTagValues, amb-indexer
 * parity); missing = not open.
 */
export function eventHasOpenLicense(event: NostrEvent): boolean {
  return classifyLicenses(licenseTagValues(event)).group === 'open';
}
