import type { NostrEvent } from 'nostr-tools';

/**
 * A kind-30142 event's license, with the same tag-parity amb-indexer uses
 * (worker.go readLicenseTag): prefer `license:id`, fall back to the plain
 * `license` tag when `license:id` is absent or empty. Some events on the
 * AMB relays carry only the plain `license` tag (e.g. a single
 * `["license", "https://creativecommons.org/licenses/by/4.0/"]`); without
 * this fallback amb-mcp showed them as unlicensed/metadata-only while the
 * indexer treats them as fully licensed.
 *
 * Note: this is purely a client-side classification fallback. Relay-side
 * `license.id:` field filters (used by search_resources/search_content for
 * no-free-text open/cc-any searches) only match the `license:id` field, so
 * they still cannot surface plain-tag-only events — the post-filter that
 * calls this helper is what catches them.
 */
export function licenseTagValue(event: NostrEvent): string | undefined {
  const id = event.tags.find((t) => t[0] === 'license:id')?.[1];
  if (id) return id;
  return event.tags.find((t) => t[0] === 'license')?.[1] || undefined;
}
