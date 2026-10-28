import type { LicenseFilter } from './license/classify.js';

export const SERVER_NAME = 'nope-mcp';
export const SERVER_VERSION = '0.6.1';

/**
 * The two-tier license/accessLevel sentence, always present: every learning
 * resource carries `license` and `accessLevel` regardless of the server's
 * licenseFilterMax ceiling. The ceiling clause is appended only when the
 * operator has narrowed it below `any` (LICENSE_FILTER_MAX).
 */
function openLicenseSentence(licenseFilterMax: LicenseFilter): string {
  const ceiling =
    licenseFilterMax !== 'any'
      ? ` This server caps every search tool's licenseFilter at '${licenseFilterMax}'; a wider request is narrowed to it, and the response says so.`
      : '';
  return (
    ` Every learning resource carries license ({id, label}, or null when unlicensed) and ` +
    `accessLevel ("full" for Creative Commons and Public Domain licenses, "metadata-only" ` +
    `otherwise); only accessLevel:"full" resources have indexed fulltext, snippets and ` +
    `passages. Present a "metadata-only" resource by its title, description, license and ` +
    `link — never quoted beyond its metadata — and always name the license and the ` +
    `creator/publisher. licenseFilter narrows search_resources, search_content and ` +
    `search_passages to "open" (CC0, Public Domain, CC BY, CC BY-SA), "cc-any" (all Creative ` +
    `Commons licenses and Public Domain) or "any" (default: every resource, including ` +
    `unlicensed and all-rights-reserved); articles, wikis, publications, projects, measures ` +
    `and calendar events carry no license filter and are returned regardless of license.${ceiling}`
  );
}

/**
 * Why a passage might carry only a snippet and no text, ceiling-aware: when
 * the server's licenseFilterMax is below `any`, a metadata-only
 * learning-resource passage was already dropped by the client-side license
 * filter before results were returned (see passageSelection.ts), so a
 * snippet-only hit the model actually sees can only mean missing fulltext —
 * license-gating is no longer a live possibility to mention. When the
 * ceiling is `any`, metadata-only resources are not dropped, so
 * license-gating is still a real explanation.
 */
export function snippetOnlyReason(licenseFilterBelowAny: boolean): string {
  return licenseFilterBelowAny ? 'has no fulltext yet' : 'is either license-gated or has no fulltext yet';
}

/**
 * English opening paragraph aimed at any MCP client, not only edufeed's
 * German teacher base — this server is listed in public MCP directories.
 * Pure function of licenseFilterMax so it never claims a license policy
 * that isn't actually in effect.
 */
function openingParagraph(licenseFilterMax: LicenseFilter): string {
  return (
    `nope-mcp is a search gateway to edufeed's open educational resources on Nostr: learning ` +
    `resources described with AMB metadata — a schema.org/LRMI-based profile for educational ` +
    `content — plus long-form articles, wiki pages, scientific publications, and educational ` +
    `calendar events. The default relay alone holds thousands of learning resources, and the ` +
    `optional extra relays (see list_relays) add tens of thousands more, for well over 100,000 ` +
    `resources across all relays combined.` +
    openLicenseSentence(licenseFilterMax) +
    ` Most requests fall into one of two patterns: finding materials to browse, or getting a ` +
    `direct answer to a question with citations drawn from resources' fulltext — the sections ` +
    `below route each case to the right tool. Use these tools to answer questions about ` +
    `educational content, its authors, and upcoming events rather than reading the relays ` +
    `directly; identifiers like naddr, npub, and pubkey are NIP-19/Nostr values these tools ` +
    `return, so pass them back as-is rather than constructing them yourself. The routing ` +
    `guidance below gives example phrases in German, the language of edufeed's primary user ` +
    `base, but the same tool-call patterns apply to requests in any language.`
  );
}

/**
 * Build the MCP server `instructions` string. Config-aware so it never
 * misdescribes the license policy for a licenseFilterMax other than `any`.
 */
export function buildServerInstructions({ licenseFilterMax }: { licenseFilterMax: LicenseFilter }): string {
  const licenseFilterBelowAny = licenseFilterMax !== 'any';
  return `${openingParagraph(licenseFilterMax)}

Two flows cover most questions:
- By name ("materials or events by Jörg Lohrer"): call resolve_author(name) to turn a person or organisation name into pubkey candidates, then pass the chosen pubkey to search_content (and/or search_calendar_events) as authors:[pubkey].
- By topic ("materials on peace education"): call search_content, then hand a result's naddr to get_resource for full metadata.

Route by INTENT before picking a search tool (when search_passages is available):
- QUESTION intent — the user asks something and wants an answer ("wie kann ich Studierende aktivieren?", "was hilft bei …?"): use search_passages, answer FROM the returned fulltext passages, and cite each source (name + source_url/page). Phrase the question as a topical statement naming subject and target group ("Friedenserziehung in der Grundschule: Einstieg mit Kindern"), not the user's literal "Wie kann ich …?" — ranking is hybrid keyword+vector. A passage with a snippet but no text ${snippetOnlyReason(licenseFilterBelowAny)}; say so. No source restriction from the user? Just pass the relevant content kinds (e.g. kinds:[30142]). Optionally follow up with search_content to offer browsable materials.
- DISCOVERY intent — the user wants materials to browse ("finde/suche/empfiehl Materialien zu X"): use search_content and present the items as links.
- AMBIGUOUS or very broad: ask ONE short clarifying question ("Möchtest du eine begründete Antwort aus den Materialien, oder eine Liste von Materialien zum Stöbern?") — and mention scoping options the user may not know exist: restricting to a publisher or author, a specific relay/corpus (list_relays), or a time window.

When the user restricts the sources ("nur Content von X", "only from X"), route the restriction into scope parameters, never into the question/query text: a metadata publisher (most organisations: resolve_publisher(name) finds the exact spelling) goes into search as a quoted field filter, e.g. search:'publisher.name:"LEHRE LADEN"'; a Nostr signing account (resolve_author(name) → pubkey) goes into authors. Publisher names must be quoted inside the search value — an unquoted multi-word name silently matches nothing.

Authorship has two distinct layers — never conflate them: eventAuthor is the Nostr signer/uploader (often an aggregator), while creator/publisher (on resources) are who actually made and published the material. "Who published this?" is answered by publisher, never by eventAuthor.

Searches run against the default relay set. list_relays may advertise extraRelays — additional relays holding different corpora (e.g. a broader aggregation) that are only queried when you pass them via the relays parameter of search_content, search_resources, or get_resource. When a search on the defaults comes up short, or the user asks for a specific relay's holdings, check list_relays and re-search with relays set; fetch follow-up details with the same relays value the search used.

The server also browses controlled vocabularies (browse_*, skos_* tools) and, for authenticated clients, signs and publishes new metadata (signer_*, create_and_publish_*).`;
}
