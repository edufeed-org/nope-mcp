# Changelog

All notable changes to nope-mcp (formerly amb-mcp) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x — the API may still change between minors).

## [Unreleased]

### Added

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

### Changed

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
  and to say so when a passage carries only a snippet (license-gated or no
  fulltext yet) instead of guessing.

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
