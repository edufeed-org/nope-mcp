/**
 * Load a SKOS ConceptScheme from a Nostr `naddr` (NIP-19), via NIP-VOCAB v0.2.
 *
 * NIP-VOCAB v0.2 publishes a vocabulary as **two kinds of events**:
 *  - kind 39737 — ConceptScheme (one event per scheme, identified by
 *    the address `kind:pubkey:d`).
 *  - kind 39738 — Concept (one event per concept; references its scheme
 *    via an `a` tag with the scheme's coordinate).
 *
 * Decode the naddr, fetch the scheme event by `{kind, authors, #d}`,
 * fetch all concept events via `{kind, #a: [schemeCoord]}`, and project
 * the result onto the existing `ParsedVocabulary` shape so downstream
 * code (`vocabSnapshot`, validator, etc.) keeps working unchanged.
 *
 * Concept `id` strategy: prefer the SKOS-style external URI from the
 * `i` tag (e.g. `https://w3id.org/kim/hcrt/text`), fall back to the
 * Nostr coordinate. Form payloads stored downstream tend to round-trip
 * the URI verbatim, so this matches what the form picker expects.
 *
 * Relay client is dependency-injected — production callers construct
 * an `AMBRelayClient` over the union of naddr's relay hints + caller
 * fallbacks; tests pass a fake.
 */

import { nip19 } from 'nostr-tools';
import { canonicalNostrUri } from '../lib/conceptId.js';
import type { Filter, NostrEvent } from 'nostr-tools';
import { AMBRelayClient } from '../relay/client.js';
import type {
  LocalizedString,
  ParsedVocabulary,
  SKOSConcept,
  SKOSConceptScheme
} from './types.js';

const SCHEME_KIND = 39737;
const CONCEPT_KIND = 39738;

/** Minimal relay query surface — what the loader needs and what tests can fake. */
export interface RelayQuery {
  queryEvents(filter: Filter): Promise<NostrEvent[]>;
}

export interface NostrVocabLoaderOptions {
  /** Extra relays to try when the naddr's hints are missing/unreachable. */
  fallbackRelays?: string[];
  /** Inject a relay client (e.g. from tests). When omitted, an `AMBRelayClient` is constructed. */
  relayClient?: RelayQuery;
}

/** Group `[value, lang]` tags by language into a single LocalizedString. */
function tagsToLocalizedString(tags: string[][], name: string): LocalizedString {
  const out: LocalizedString = {};
  for (const t of tags) {
    if (t[0] === name && t[1] && t[2]) out[t[2]] = t[1];
  }
  return out;
}

/** Each `[value, lang]` tag becomes its own LocalizedString — preserves NIP-VOCAB's "n distinct alt labels" semantics. */
function tagsToLocalizedStringArray(tags: string[][], name: string): LocalizedString[] {
  const out: LocalizedString[] = [];
  for (const t of tags) {
    if (t[0] === name && t[1] && t[2]) out.push({ [t[2]]: t[1] });
  }
  return out;
}

function buildScheme(event: NostrEvent, identifier: string): SKOSConceptScheme {
  const title = tagsToLocalizedString(event.tags, 'prefLabel');
  const description = tagsToLocalizedString(event.tags, 'description');
  return {
    id: canonicalNostrUri(SCHEME_KIND, event.pubkey, identifier),
    type: 'ConceptScheme',
    title,
    ...(Object.keys(description).length > 0 ? { description } : {}),
    hasTopConcept: []
  };
}

function buildConcept(event: NostrEvent): SKOSConcept | null {
  const d = event.tags.find((t) => t[0] === 'd')?.[1];
  if (!d) return null;
  // NIP-VOCAB: the `i` URI when the concept has one, else the canonical
  // relay-less nostr:naddr of the event. The `d` is kept as notation (the
  // identifier within the scheme) — short enough for an LLM to echo.
  const externalUri = event.tags.find((t) => t[0] === 'i')?.[1];
  const id = externalUri ?? canonicalNostrUri(event.kind, event.pubkey, d);
  const prefLabel = tagsToLocalizedString(event.tags, 'prefLabel');
  if (Object.keys(prefLabel).length === 0) return null;
  const altLabel = tagsToLocalizedStringArray(event.tags, 'altLabel');
  return {
    id,
    type: 'Concept',
    notation: [d],
    prefLabel,
    ...(altLabel.length > 0 ? { altLabel } : {})
  };
}

export async function loadVocabularyFromNaddr(
  naddr: string,
  opts: NostrVocabLoaderOptions = {}
): Promise<ParsedVocabulary> {
  const decoded = nip19.decode(naddr);
  if (decoded.type !== 'naddr') {
    throw new Error(`Expected naddr, got ${decoded.type}`);
  }
  const { kind, pubkey, identifier, relays: hintedRelays } = decoded.data;
  if (kind !== SCHEME_KIND) {
    throw new Error(`naddr points at kind ${kind}; expected ${SCHEME_KIND} (ConceptScheme)`);
  }

  const schemeCoord = `${SCHEME_KIND}:${pubkey}:${identifier}`;

  let client = opts.relayClient;
  if (!client) {
    const relays = [...(hintedRelays ?? []), ...(opts.fallbackRelays ?? [])];
    if (relays.length === 0) {
      throw new Error('No relays configured: naddr has no hints and no fallbackRelays provided');
    }
    client = new AMBRelayClient(relays);
  }

  const [schemeEvents, conceptEvents] = await Promise.all([
    client.queryEvents({
      kinds: [SCHEME_KIND],
      authors: [pubkey],
      '#d': [identifier]
    } as Filter),
    client.queryEvents({
      kinds: [CONCEPT_KIND],
      '#a': [schemeCoord]
    } as Filter)
  ]);

  const schemeEvent = schemeEvents[0];
  if (!schemeEvent) {
    throw new Error(`ConceptScheme event not found for ${schemeCoord}`);
  }

  const scheme = buildScheme(schemeEvent, identifier);
  const concepts = new Map<string, SKOSConcept>();
  for (const e of conceptEvents) {
    const c = buildConcept(e);
    if (c) concepts.set(c.id, c);
  }

  return { scheme, concepts };
}
