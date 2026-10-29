import type { NostrEvent } from 'nostr-tools';
import { eventLicense, type LicenseFilter } from '../license/classify.js';

/** Which licenses a non-`any` filter admits, for the zero-match hint. */
export const LICENSE_FILTER_SCOPE: Record<Exclude<LicenseFilter, 'any'>, string> = {
  open: 'CC0, Public Domain, CC BY, CC BY-SA',
  'cc-any': 'Creative Commons or Public Domain',
};

/** Summarizes license labels across a set of events, e.g. "10 CC BY-NC-SA 4.0". */
function licenseBreakdown(events: NostrEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    const { group, license } = eventLicense(e);
    const label = license?.label ?? (group === 'none' ? 'no license' : 'unknown license');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(', ');
}

/**
 * Build the zero-match hint for the case where a result set is empty ONLY
 * because the license filter excluded otherwise-matching resources — not
 * because nothing matched the rest of the query (laoc, 2026-10-29, the
 * "Gendering MINT" bug: a creatorName filter matched 10 CC BY-NC-SA
 * resources, but with licenseFilter "open" the total came back 0 and the
 * response wrongly suggested a spelling retry).
 *
 * `excluded` are the resource events that matched everything else but
 * failed `effective`. Respects the operator ceiling (`max`,
 * LICENSE_FILTER_MAX): when it equals `effective` there is no wider value
 * to retry with, so the hint says the matches aren't served here at all
 * rather than suggesting a retry that would just be re-clamped.
 */
export function licenseOnlyZeroHint(
  excluded: NostrEvent[],
  effective: Exclude<LicenseFilter, 'any'>,
  max: LicenseFilter
): string {
  const scope = LICENSE_FILTER_SCOPE[effective];
  const breakdown = licenseBreakdown(excluded);
  const n = excluded.length;
  const plural = n === 1 ? 'resource' : 'resources';
  if (max === effective) {
    return (
      `${n} ${plural} (${breakdown}) match but ${n === 1 ? 'is' : 'are'} under licenses this ` +
      `server doesn't return — the ceiling here is licenseFilter: "${effective}" (${scope} ` +
      `only); they can't be retrieved from this server regardless of licenseFilter.`
    );
  }
  return (
    `${n} ${plural} (${breakdown}) match under licenses other than ${scope} ` +
    `(licenseFilter: "${effective}"); retry with licenseFilter: "${max}" to include them.`
  );
}
