import { nip19, type NostrEvent } from 'nostr-tools';
import { getProfileContent } from 'applesauce-core/helpers';

/** A resolved author candidate. Mirrors KnownAuthor (src/authors.ts) + npub. */
export interface ProfileResult {
  pubkey: string;
  npub: string;
  name?: string;
  nip05?: string;
  about?: string;
  picture?: string;
}

/**
 * Project a kind-0 metadata event into a ProfileResult.
 * Returns null for non-kind-0 events or unparseable content — applesauce's
 * getProfileContent owns the JSON parsing and yields undefined on failure.
 */
export function transformProfileEvent(event: NostrEvent): ProfileResult | null {
  if (event.kind !== 0) return null;

  const content = getProfileContent(event);
  if (!content) return null;

  const result: ProfileResult = {
    pubkey: event.pubkey,
    npub: nip19.npubEncode(event.pubkey),
  };

  const name = content.display_name || content.name;
  if (name) result.name = name;
  if (content.nip05) result.nip05 = content.nip05;
  if (content.about) result.about = content.about;
  if (typeof content.picture === 'string' && content.picture) result.picture = content.picture;

  return result;
}
