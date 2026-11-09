import { nip19, type NostrEvent } from 'nostr-tools';
import { getProfileContent } from 'applesauce-core/helpers';
import { getEventRelay } from '../relay/provenance.js';

/**
 * A Communikey community (kind 10222), projected for find_community.
 * Per the Communikey spec ("Communities = npubs"), `name` and `picture`
 * live on the community pubkey's own kind-0 profile, not on the 10222 —
 * the same resolution edufeed-app does with useProfileMap over community
 * pubkeys. `description` is the 10222's own `description` override tag,
 * falling back to the kind-0 `about`. `profileEvent` is that kind-0, when
 * one was fetched alongside the 10222; without it, `name` falls back to a
 * shortened npub and `picture`/description-fallback are unavailable.
 */
export interface Community {
  pubkey: string;
  npub: string;
  name: string;
  description: string;
  picture?: string;
  relay?: string;
}

export function parseCommunity(event: NostrEvent, profileEvent?: NostrEvent): Community {
  const npub = nip19.npubEncode(event.pubkey);
  const descriptionOverride = event.tags.find(
    (t) => Array.isArray(t) && t[0] === 'description' && typeof t[1] === 'string'
  )?.[1];

  const profile = profileEvent ? getProfileContent(profileEvent) : undefined;
  // kind-0 JSON is untrusted: a non-string field (e.g. `"name": 42`) is ignored.
  const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
  const name = str(profile?.display_name) ?? str(profile?.name);
  const picture = str(profile?.picture);
  const relay = getEventRelay(event);

  return {
    pubkey: event.pubkey,
    npub,
    name: name || `${npub.slice(0, 12)}…`,
    description: descriptionOverride ?? str(profile?.about) ?? '',
    ...(picture ? { picture } : {}),
    ...(relay ? { relay } : {}),
  };
}
