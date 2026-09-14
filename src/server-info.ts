export const SERVER_NAME = 'amb-relay';
export const SERVER_VERSION = '0.3.0';

export const SERVER_INSTRUCTIONS = `This server is the gateway to the AMB educational-metadata relays — a Nostr-based store of learning resources, long-form articles, wiki pages, scientific publications, and calendar events. Use these tools to answer questions about educational content, its authors, and upcoming events; they abstract the Nostr layer, so query them rather than reading the relays directly. Identifiers like naddr, npub, and pubkey are NIP-19/Nostr values these tools return — pass them back as-is rather than constructing them yourself.

Two flows cover most questions:
- By name ("materials or events by Jörg Lohrer"): call resolve_author(name) to turn a person or organisation name into pubkey candidates, then pass the chosen pubkey to search_content (and/or search_calendar_events) as authors:[pubkey].
- By topic ("materials on peace education"): call search_content, then hand a result's naddr to get_resource for full metadata.

Route by INTENT before picking a search tool (when search_passages is available):
- QUESTION intent — the user asks something and wants an answer ("wie kann ich Studierende aktivieren?", "was hilft bei …?"): use search_passages, answer FROM the returned fulltext passages, and cite each source (name + source_url/page). Phrase the question as a topical statement naming subject and target group ("Friedenserziehung in der Grundschule: Einstieg mit Kindern"), not the user's literal "Wie kann ich …?" — ranking is hybrid keyword+vector. A passage with a snippet but no text is license-gated or has no fulltext yet; say so. No source restriction from the user? Just pass the relevant content kinds (e.g. kinds:[30142]). Optionally follow up with search_content to offer browsable materials.
- DISCOVERY intent — the user wants materials to browse ("finde/suche/empfiehl Materialien zu X"): use search_content and present the items as links.
- AMBIGUOUS or very broad: ask ONE short clarifying question ("Möchtest du eine begründete Antwort aus den Materialien, oder eine Liste von Materialien zum Stöbern?") — and mention scoping options the user may not know exist: restricting to a publisher or author, a specific relay/corpus (list_relays), or a time window.

When the user restricts the sources ("nur Content von X", "only from X"), route the restriction into scope parameters, never into the question/query text: a metadata publisher (most organisations: resolve_publisher(name) finds the exact spelling) goes into search as a quoted field filter, e.g. search:'publisher.name:"LEHRE LADEN"'; a Nostr signing account (resolve_author(name) → pubkey) goes into authors. Publisher names must be quoted inside the search value — an unquoted multi-word name silently matches nothing.

Authorship has two distinct layers — never conflate them: eventAuthor is the Nostr signer/uploader (often an aggregator), while creator/publisher (on resources) are who actually made and published the material. "Who published this?" is answered by publisher, never by eventAuthor.

Searches run against the default relay set. list_relays may advertise extraRelays — additional relays holding different corpora (e.g. a broader aggregation) that are only queried when you pass them via the relays parameter of search_content, search_resources, or get_resource. When a search on the defaults comes up short, or the user asks for a specific relay's holdings, check list_relays and re-search with relays set; fetch follow-up details with the same relays value the search used.

The server also browses controlled vocabularies (browse_*, skos_* tools) and, for authenticated clients, signs and publishes new metadata (signer_*, create_and_publish_*).`;
