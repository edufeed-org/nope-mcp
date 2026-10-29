# Changelog

All notable changes to nope-mcp (formerly amb-mcp) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x — the API may still change between minors).

## [Unreleased]

### Fixed

- `search_resources`/`search_content`: a zero-result response caused only by
  `licenseFilter` (e.g. a `creatorName`/`publisherName` filter matching
  resources that are all under a license outside the filter's scope) no
  longer shows the "exact spelling" actor hint — it now reports how many
  resources matched under other licenses and, when the operator ceiling
  (`LICENSE_FILTER_MAX`) allows it, suggests retrying with a wider
  `licenseFilter`; when the ceiling forbids widening, it says the matches
  are under licenses this server doesn't return instead. The actor-spelling
  hint is now shown only when the actor name truly matched nothing,
  regardless of the license filter.
- Relay queries (`search_resources`, `search_content`, every other relay
  read) no longer get silently truncated at nostr-tools' internal 4.4s
  default EOSE timeout — our own, much longer, query timeout wasn't being
  passed down (`maxWait`/`eoseTimeout`), so any relay slower than that was
  cut off with no `timedOut` diagnostic at all (the likely real cause of
  `sodix` coming back empty under reindex load, answering in 11-17s). On
  top of that, the previous timeout fix (now corrected) also discarded
  events already received when the deadline fired instead of returning
  them, under-counted which relays actually timed out across multiple
  relays, and could resolve a multi-relay query after only the first
  relay's EOSE. The timeout is configurable via `RELAY_QUERY_TIMEOUT_MS`
  (default 25000, up from 10000) and closes the stalled subscription
  instead of leaking it. Zero-result follow-up probes (the license hint
  above, `resolve_publisher`'s did-you-mean fallback) now use a short
  5s budget instead of the full query timeout, so a worst-case empty
  response doesn't chain into tens of seconds of added latency.

## [0.7.0] - 2026-10-29

### Added

- **License tiers for learning resources.** Every learning resource (kind
  30142) is now searchable, not only CC0/PD/BY/BY-SA. Each result carries
  `license` (`{ id, label }`, e.g. "CC BY-NC-SA 4.0", or `null`) and
  `accessLevel`: `"full"` for any Creative Commons license or Public Domain
  (passages and snippets as before), `"metadata-only"` for all-rights-reserved,
  unknown or missing licenses (metadata and link only, never fulltext).
- `licenseFilter` parameter on `search_resources`, `search_content` and
  `search_passages`: `open` (CC0/PD/BY/BY-SA), `cc-any` (all CC + PD) or
  `any` (default). Responses report the applied `licenseFilter` and
  `licenseFilterClamped: true` when narrowed.
- `LICENSE_FILTER_MAX` env: operator ceiling for `licenseFilter` (default
  `any`); wider requests are clamped.
- `search_passages` returns `metadataOnlyMatches` for matching learning
  resources whose license does not allow quoting (no text, with license and
  attribution).
- `get_resource` returns top-level `accessLevel`.

### Changed

- The license is read from `license:id`, falling back to a plain `license`
  tag (parity with amb-indexer).
- `search_content` strips snippet, page, heading, score and source URL from
  metadata-only results even if the relay sent a snippet.

### Deprecated

- `OPEN_LICENSES_ONLY` (maps to `LICENSE_FILTER_MAX=open` when `true`, with a
  log line) and `get_resource`'s `openLicense` (use `accessLevel`).

## [0.6.1] - 2026-10-28

### Fixed

- `package-lock.json` regenerated with npm 10 (the Docker image's npm): the
  0.6.0 lock written by npm 11 omitted a nested `web-streams-polyfill` entry,
  so `npm ci` failed in CI and no 0.6.0 image was published.

## [0.6.0] - 2026-10-28

### Added

- **Office documents as sources.** `extract_metadata` (and `fetchPage`
  with the new `docExtract` callback) reads Word, PowerPoint and Excel in
  OOXML form (docx/pptx/xlsx), OpenDocument text/presentation/spreadsheet
  (odt/odp/ods), legacy binary Word (`.doc`, via word-extractor) and
  legacy binary PowerPoint (`.ppt`, text records of the PowerPoint
  Document stream). Detection is by magic bytes and container contents, so
  a .pptx served under a ".PPT" name or as `application/octet-stream` is
  read correctly. Slides come in numeric order with notes after them;
  animation timing and drawing offsets are dropped. Documents have their
  own size cap (`maxDocumentBytes`, default 64 MiB). Fetch result
  `contentType` gains `'document'` plus `documentKind`.
- Dependencies: `fflate`, `word-extractor`, `cfb`.
- Library entry (`nope-mcp/lib`) exports `extractDocument`, `extractPdfText`
  and the typed fetch errors so SvelteKit callers can enable both.

### Changed

- `fetchPage` classifies every non-text body by its first bytes (PDF, zip/OLE
  document, HTML) regardless of the declared type, rejects bodies early when
  `content-length` exceeds the cap, stops reading at the cap, and bounds the
  body transfer time. `unsupported_type` now only covers bodies no extractor
  can read (images, archives that are not documents, …); a document that
  cannot be parsed (corrupt zip, junk .doc) is reported the same way instead
  of failing the call.
- Hardening: zip parts are inflated only up to 64 MiB per file
  (`page_too_large` otherwise), OOXML text matching is linear and immune to
  empty `<w:t/>`/`<a:t/>` elements, legacy .ppt records are walked
  iteratively with a depth limit, TextBytesAtom text is decoded as
  Windows-1252, out-of-range numeric entities are kept literally, ODF
  annotations and tracked changes are dropped.

## [0.5.1] - 2026-10-28

### Fixed

- Canonical `nostr:naddr1…` identifiers are now byte-exact per NIP-VOCAB
  (TLV order d, author, kind). 0.5.0 used nostr-tools' `naddrEncode`, which
  writes the kind first: it decodes to the same concept but is a different
  string from what nostr-vocab-core, the crawlers and the indexer emit, so
  string comparisons and facet hashes would not have matched.

## [0.5.0] - 2026-10-28

### Changed

- **Canonical NIP-VOCAB concept identifiers.** Concepts loaded from Nostr
  (`naddr1…` vocabularies) are now identified by the canonical relay-less
  `nostr:naddr1…` of their kind-39738 event (NIP-19/NIP-21) when they have no
  `i` URI, and the scheme by the relay-less naddr of its kind-39737 event.
  The raw coordinate `39738:<pubkey>:<d>` is no longer emitted. Inputs in the
  raw, legacy `nostr:<kind>:<pubkey>:<d>` and hinted-naddr forms are still
  accepted by `extract_metadata` and mapped to the canonical id. The
  concept's `d` is kept as SKOS `notation`.
- `extract_metadata` shows the model short aliases (the `d`) for Nostr
  concepts instead of bech32 strings and maps echoed aliases, canonical and
  legacy ids back to canonical ids; duplicates collapse.
- Bible references: the prompt asks for at least a chapter, and bare book
  names ("Mt", "Joh") are dropped from `bibleReferences` after the call;
  other free text still passes through.

### Fixed

- Multi-source `extract_metadata` no longer fails the whole call when a
  source after the first cannot be used: unsupported content types (office
  documents, images), fetch failures and oversized bodies are skipped and
  reported in a new optional `skippedSources: [{url, code, reason}]`. The
  first source stays authoritative and still fails the call.
- `fetchPage` rejects non-HTML, non-PDF bodies with `code: 'unsupported_type'`
  instead of parsing binary as HTML; PDFs are recognised by declared type
  (`application/pdf`, `application/x-pdf`) or by sniffing `%PDF-` in
  octet-stream/download bodies and bodies without a content-type.
- `getVocabulary` accepts the canonical `nostr:naddr1…` scheme id (and
  hinted naddrs) and caches all spellings under one entry; `getConcept`
  returns undefined for Nostr concept ids instead of trying to fetch them.
- Numeric concept aliases ("1", "2" for Klassenstufen) are accepted when
  the model emits them as JSON numbers.

## [0.4.0] - 2026-10-02

### Added

- **MCP Registry manifest** (`server.json`): publishes nope-mcp to the
  official [MCP Registry](https://registry.modelcontextprotocol.io) as
  `org.edufeed/nope-mcp`, pointing at the `https://mcp.edufeed.org/mcp`
  remote. Its `version` always matches `package.json`.
- **Per-connection default relays via the connector URL:** the HTTP transport
  reads a `?relays=` parameter off the `initialize` request, e.g.
  `https://mcp.amb.edufeed.org/mcp?relays=sodix`. The named relays become that
  session's default set; the rest of the deployment's relays stay selectable
  per call. Connector UIs typically offer only a name and a URL field, so the
  URL is the only place a connection can express which corpus it wants.
  Relays answer to their full URL, their hostname, or the first label of their
  hostname; a name the deployment does not serve fails `initialize` with HTTP
  400 rather than silently falling back to the server default. Arbitrary URLs
  are refused — the endpoint never opens sockets to caller-chosen hosts.
- **SODIX relay** (`wss://sodix.edufeed.org`) documented as an
  `AMB_EXTRA_RELAYS` member alongside the OERSI aggregation relay.
- **`list_relays` reports `defaultRelaysSource`** (`server-config` or
  `connector-url`), so a model can tell a deliberately narrowed session from
  the deployment's standard corpus.
- **Per-tool-call logging:** every tool call emits one JSON line on stderr
  (`ts`, `tool`, `ms`, `ok`, `session`, summarized `args`, `error` on
  failure). `LOG_LEVEL` controls it: `info` (default) logs every call,
  `warn`/`error` only failures, `silent` nothing. stdout stays reserved for
  the stdio transport.
  Typed error payloads (`{"error":"relay_unreachable",…}` returned as text) are logged as `ok:false` with the code.
- **MCP served at `/` as well as `/mcp`** (same session map, both paths accept
  POST/GET/DELETE): a plain browser `GET /` — no `Mcp-Session-Id` header, no
  `Accept: text/event-stream` — returns a small JSON info document (`name`,
  `version`, `mcp`, `docs`, `transport`) instead of the usual "unknown
  session" 404; `GET /mcp` is unchanged and always behaves as an MCP session
  request.
- **Host- and path-aware OAuth protected-resource metadata (RFC 9728):** the
  PRM is built per request from the forwarded scheme + host (`trust proxy`
  is now on, since Traefik terminates TLS) and served at both
  `/.well-known/oauth-protected-resource` (`resource: https://<host>/`)
  **and the new** `/.well-known/oauth-protected-resource/mcp` (`resource:
  https://<host>/mcp`); a 401's `WWW-Authenticate` points at whichever PRM
  matches the request path (`/mcp` and `/mcp/` alike). A host outside
  `HTTP_ALLOWED_HOSTS` (when configured) falls back to `OAUTH_RESOURCE_URL`.
  **Behaviour change for existing connector owners:** the root PRM's
  `resource` value changed from `https://<host>/mcp` to `https://<host>/`;
  a connector that cached the old root PRM document needs to re-fetch it.
  Connectors addressing `/mcp` directly are unaffected — that path now has
  its own PRM at `/.well-known/oauth-protected-resource/mcp`.
- **`OAUTH_AUDIENCE` is now a comma-separated list** (default
  `nope-mcp,amb-mcp`); a token whose `aud` contains *any* of them validates,
  so tokens Keycloak still issues with `aud: amb-mcp` keep working under the
  new name.
- **MCP tool annotations** (`readOnlyHint`, `destructiveHint`, etc.) on every
  registered tool, so clients that surface them (e.g. consent prompts)
  classify each call correctly; `signer_status` is annotated as the pure
  read it is, not as a mutator.
- **English opening paragraph in the server `instructions`:**
  `buildServerInstructions({ openLicensesOnly })` now leads with a
  config-aware paragraph describing nope-mcp for any MCP client — not only
  edufeed's German teacher base, since this server is listed in public MCP
  directories — before the existing German routing guidance; it never claims
  the open-license policy is active when `OPEN_LICENSES_ONLY=false`.

### Deploy notes

- Production's `HTTP_ALLOWED_HOSTS` must include `mcp.edufeed.org` — the
  SDK's DNS-rebinding protection rejects any request whose Host is outside
  this list once the list is set.

### Changed

- **Open-licensed results only:** `search_resources`, `search_content` and
  `search_passages` return learning resources (kind 30142) only under CC0,
  the Public Domain Mark, CC BY or CC BY-SA — the allowlist amb-indexer uses
  for fulltext. NC/ND, all-rights-reserved and unlicensed resources are left
  out; articles, wikis, publications, projects, measures and calendar events
  carry no license and stay unfiltered. Searches with free text over-fetch and filter
  client-side, because any relay field filter would disable amb-relay's
  passage rerank; only a `search_resources` call without free text (pure
  metadata filters or a browse) adds `license.id` filters for every stored
  open spelling to the relay query. `get_resource` still resolves any resource
  and reports `openLicense`. `OPEN_LICENSES_ONLY=false` restores unfiltered
  results.
- **Renamed to `nope-mcp`** (formerly `amb-mcp`). The package name, MCP
  server name, HTTP `WWW-Authenticate` realm, and docs now say `nope-mcp`.
  `amb-mcp` remains a documented alias and a valid OAuth audience; existing
  deployments and URLs (`https://mcp.amb.edufeed.org/mcp`) keep working
  unchanged.
- **`search_passages` ranking:** requests vector weight `alpha: 0.7` from the
  indexer instead of its keyword-leaning default 0.3, over-fetches
  `min(limit × 3, 100)` chunks, keeps at most two passages per document and
  drops hits below 10 % of the top score before truncating to `limit`. A
  Christmas escape game no longer tops a peace-education question on the
  strength of the words "GRUNDSCHULE" and "Kinder", and one document no
  longer fills three of ten slots.
- **`search_passages` guidance:** the tool description and the server
  instructions now tell the model to phrase `question` as a topical statement
  naming subject and target group rather than the user's literal sentence,
  and to say so instead of guessing when a passage carries only a snippet.
  The reason given is flag-aware: with `OPEN_LICENSES_ONLY` on, a text-less
  learning-resource passage simply has no fulltext yet, since license-gated
  hits are already dropped before the model sees them; with it off, the
  license-gated possibility is still named.

## [0.3.0] - 2026-08-19

Actor-name search made reliable: multi-word metadata filters were silently
broken (unquoted spaces), and there was no way to discover the exact
publisher spelling the corpus uses. This release fixes the quoting, adds a
resolve_publisher tool plus did-you-mean suggestions on empty actor filters,
and documents the exact-match semantics so agents stop guessing.

### Added

- **`resolve_publisher` tool:** resolves an actor name to the exact
  publisher/creator spelling used in the AMB metadata (e.g. "Lehreladen" →
  "LEHRE LADEN"), since the metadata filters are exact full-string matches.
  Complements `resolve_author`, which covers Nostr signing accounts only.
- **Did-you-mean on empty actor filters:** when `publisherName`/`creatorName`
  matches nothing, `search_resources` now returns `actorCandidates` (similar
  spellings found in the corpus) and a `hint` explaining the exact-match
  semantics, so agents can self-correct instead of dead-ending.

### Fixed

- Field-filter values containing spaces (`publisherName`, `creatorName`,
  `subjectLabel`, `resourceTypeLabel`, `educationalLevelLabel`) are now
  quoted in the NIP-50 search string. Unquoted, the relay tokenizer split
  them into a filter on the first word plus stray free-text terms, so e.g.
  `publisherName: "LEHRE LADEN"` or `educationalLevelLabel: "Sekundarstufe I"`
  returned unrelated results instead of the filtered set.

## [0.2.1] - 2026-08-18

Discoverability follow-up to 0.2.0: LLM clients assumed "configured ⇒
searched" and misread the extra relay as unreachable.

### Changed

- `relay_stats` now covers all selectable relays (default and extra), each
  marked with a `role` field, so per-call-only relays are visibly alive.
- `list_relays` includes a `note` explaining that `extraRelays` are only
  queried via the `relays` parameter.
- Search responses list the selectable relays a search skipped as
  `relaysNotSearched`, next to `relaysSearched`.

## [0.2.0] - 2026-08-18

### Added

- **Per-call relay selection:** `search_content`, `search_resources`, and
  `get_resource` accept an optional `relays` parameter naming relays from the
  selectable set (default ∪ extra); unknown relays are rejected with the list
  of valid ones. Search responses report the queried relays as
  `relaysSearched`.
- **`AMB_EXTRA_RELAYS`** environment variable: relays that are selectable per
  call but not part of the default search set (e.g. the OERSI aggregation
  relay, `wss://oersi.edufeed.org`).
### Changed

- **Breaking:** `list_relays` now returns `defaultRelays` and `extraRelays`
  instead of a single `relays` array.

## [0.1.0] - 2026-08-11

First public release.

### Added

- **Three transports:** Nostr/ContextVM (`src/index.ts`), stdio for local MCP
  clients (`src/stdio.ts`), and Streamable HTTP (`src/http.ts`).
- **Cross-content search** (`search_content`) across educational resources
  (kind 30142), long-form articles (30023), wikis (30818), transferkiosk
  projects/measures (30143/30144), and NKBIP-01 scientific publications
  (30040/30041), with semantic snippet re-ranking and facet-in-query syntax
  (`type:`, `doi:`, `keywords:`, `partOf:`).
- **Resource tools:** `search_resources`, `get_resource` (naddr/d-tag/event-id,
  generic kind dispatch), `browse_subjects`, `browse_resource_types`,
  `browse_educational_levels`, `relay_stats`, `list_relays`, `relay_list_get`.
- **Author tools:** `resolve_author` (kind-0 profile index search) and
  `list_known_authors` (NIP-51 follow sets).
- **Calendar tools:** `search_calendar_events` (NIP-52, temporal/geohash/hashtag
  filters) and `list_calendar_authors`.
- **SKOS vocabulary tools:** read suite (`skos_search`, `skos_get_concept`,
  `skos_get_vocabulary`, …) and authoring/builder suite for publishing
  vocabularies as Nostr events.
- **`extract_metadata`:** URL/PDF → AMB/EKW form-prefill payload with optional
  LLM-grounded SKOS field extraction (`amb`/`ekw`/`konfi` variants), also
  available as a library export (`amb-mcp/lib`).
- **Signing & publishing** (stdio/Nostr transports only): NIP-46 remote signing
  with QR flow, NIP-65 outbox publishing, kind 0 and kind 30142 event builders.
- **OAuth resource server** on the HTTP transport: anonymous read-only sessions,
  `mcp:read`/`mcp:extract` scopes via Keycloak-issued JWTs, protected-resource
  metadata document; write tools are never exposed over HTTP.

### Changed

- `CALENDAR_RELAYS` now defaults to the main AMB relay
  (`wss://relay.edufeed.org`), which serves NIP-52 calendar events itself; a
  separate calendar relay remains supported for split deployments.
