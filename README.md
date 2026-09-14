# AMB Relay MCP Server

An MCP (Model Context Protocol) server for querying educational resources from AMB (Allgemeines Metadatenprofil für Bildungsressourcen) Nostr relays.

## Repository

The canonical repository lives on Nostr ([NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md)) — browse it on [gitworkshop.dev](https://gitworkshop.dev/laoc.xyz/amb-mcp), or clone with the [ngit](https://gitworkshop.dev/ngit) remote helper:

```bash
git clone nostr://laoc.xyz/relay.ngit.dev/amb-mcp
```

Mirrors: [git.edufeed.org/edufeed/amb-mcp](https://git.edufeed.org/edufeed/amb-mcp) · [github.com/edufeed-org/amb-mcp](https://github.com/edufeed-org/amb-mcp). Issues and PRs are welcome on any of the three — Nostr PRs arrive as `pr/*` branches.

Releases are tagged (`v0.1.0`, …) and listed in [CHANGELOG.md](CHANGELOG.md).

## Features

### Query & Browse
- Cross-content full-text search (`search_content`) across educational resources, long-form articles, wikis, transferkiosk projects/measures, and NKBIP-01 scientific publications in one ranked call
- Grounded passage retrieval (`search_passages`) — answers a question from the corpus's fulltext with citations, scoped by a grimoire spell (kind 777) or inline scope; requires the indexer
- Semantic snippet passages from chunk re-ranking surfaced per result when the relay's re-ranking is active
- Full-text search with NIP-50
- Filter by publisher, creator, subject, resource type, educational level
- Browse available subjects, resource types, and educational levels
- Resolve author/organisation names to pubkeys (`resolve_author`) for author-scoped queries
- NIP-52 calendar event search with temporal, geohash, and hashtag filters
- SKOS controlled-vocabulary lookup and search (`skos_*`)
- Get individual resources by identifier
- Relay statistics and info

### URL → Form-Prefill Metadata
- `extract_metadata(url, variant, skosSchemes?)` — fetch a public web page and produce a complete AMB/EKW form-prefill payload. Returns OpenGraph fallback by default; with `ANTHROPIC_API_KEY` set, an LLM grounded in the configured SKOS vocabularies fills SKOS-typed fields with concept IDs and per-field evidence quotes.
- Library export: `import { extractMetadata } from 'amb-mcp/lib'` for direct in-process use (e.g. SvelteKit server routes).

### Signing & Publishing
- NIP-46 remote signing (bunker) with QR code connection flow
- Sign and publish arbitrary Nostr events
- Create and publish kind 0 (profile/metadata) events
- Create and publish kind 30142 (AMB educational resource) events
- NIP-42 relay authentication support
- Multi-user session isolation

## Installation

```bash
bun install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Environment variables

| Name | Used by | Default | Description |
|------|---------|---------|-------------|
| `AMB_RELAYS` | all transports | `wss://relay.edufeed.org` | Comma-separated AMB relay URLs. Queried by every content tool (`search_content`, `search_resources`, `get_resource`, `browse_*`, `resolve_author`, `relay_stats`) and used as default publish targets for the signing tools. |
| `AMB_EXTRA_RELAYS` | all transports | _(empty)_ | Comma-separated AMB relay URLs that are *selectable but not searched by default*. `search_content`, `search_resources`, and `get_resource` accept a `relays` parameter naming relays from `AMB_RELAYS` ∪ `AMB_EXTRA_RELAYS` (anything else is rejected); `list_relays` advertises both groups as `defaultRelays`/`extraRelays`. Use this to expose alternative corpora (e.g. the OERSI and SODIX aggregation relays, `wss://oersi.edufeed.org,wss://sodix.edufeed.org`) on request without merging them into every search. Over HTTP this list also feeds the `?relays=` connector parameter — see [Choosing a connector's default relays](#choosing-a-connectors-default-relays). |
| `AMB_AUTHOR_SETS` | all transports | _(empty)_ | Comma-separated `naddr` identifiers of NIP-51 follow sets (kind 30000). Loaded once at startup into the author directory served by `list_known_authors`; the returned pubkeys can then be passed to `search_*` tools as `authors`. |
| `CALENDAR_RELAYS` | all transports | `wss://relay.edufeed.org` | Comma-separated NIP-52 calendar relay URLs for `search_calendar_events`. The AMB relay serves calendar events itself, so the default is the same relay; set this only for split deployments with a dedicated calendar relay. |
| `CALENDAR_AUTHOR_SETS` | all transports | _(empty)_ | Same as `AMB_AUTHOR_SETS`, but for the calendar author directory served by `list_calendar_authors`. |
| `INDEXER_ENDPOINTS` | `search_passages` | _(unset — tool disabled)_ | Comma-separated `wss://relay=https://indexer` pairs mapping each AMB relay to its amb-indexer base URL. Enables `search_passages`. |
| `INDEXER_API_TOKEN` | `search_passages` | _(unset)_ | Bearer token for the indexer's `/search_chunks` (shared default for all endpoints). |
| `INDEXER_API_TOKENS` | `search_passages` | _(unset)_ | Per-relay token overrides, comma-separated `wss://relay=token` pairs — each deployed indexer instance has its own token. Every `INDEXER_ENDPOINTS` entry must be covered by this or `INDEXER_API_TOKEN`; a partially tokened config fails at startup. |
| `SPELL_RELAYS` | `search_passages` | `wss://relay.edufeed.org` | Relays to fetch kind-777 spells (and kind-3 contact lists) from. |
| `LOG_LEVEL` | all transports | `info` | Per-tool-call logging on **stderr** (stdout belongs to the stdio transport). Every call emits one JSON line: `{"ts":"2026-09-14T12:00:00.000Z","tool":"search_passages","ms":412,"ok":true,"session":"<id>","args":{"question":"…","kinds":[30142]}}` — `ok` is `false` for `isError` results, thrown errors, and text results whose JSON body carries an `error` code (typed failures such as `relay_unreachable`) — `error` then holds the message or code; strings in `args` are cut at 120 chars, arrays longer than five collapse to `{length, head}`. `info` (default) logs every call, `warn`/`error` log failures only, `silent` disables the lines. |
| `EDUFEED_APP_BASE_URL` | all transports | _(unset)_ | Frontend base URL (no trailing slash, e.g. `https://app.edufeed.org`). When set, results from `search_content`, `search_resources`, `get_resource`, and `search_calendar_events` include a `url` field pointing at the edufeed-app viewer page (`<base>/<naddr>`) so LLM clients can render direct links. Unset means no `url` field. |
| `SERVER_PRIVATE_KEY` | `src/index.ts` (+ discovery scripts) | **required** for Nostr transport | Nostr private key (`nsec` or hex) that is the server's own ContextVM identity. The derived pubkey is what clients connect to via `cvmi use <pubkey>`. Not read by the stdio or HTTP transports. |
| `RELAYS` | `src/index.ts` (+ discovery scripts) | `wss://relay.contextvm.org`, `wss://cvm.otherstuff.ai` | Comma-separated relay URLs for ContextVM transport announcements and request/response traffic. Not read by the stdio or HTTP transports. |
| `ANTHROPIC_API_KEY` | `extract_metadata` | _(unset)_ | Enables LLM-grounded SKOS field extraction. When unset the tool degrades gracefully to OpenGraph/JSON-LD-only output. |
| `ANTHROPIC_MODEL` | `extract_metadata` | `claude-sonnet-4-6` | Override the Anthropic model used for extraction. |
| `SKOS_SCHEMES` | `extract_metadata` | _(unset)_ | JSON map `{ "<form-field>": "<scheme-uri>" }` of default vocabularies used when the caller does not pass `skosSchemes` explicitly. |
| `VOCAB_RELAYS` | `extract_metadata` | falls back to `AMB_RELAYS` | Relays used to resolve `naddr1…` SKOS scheme identifiers to relay-hosted vocabularies. |
| `SCHEME_NADDR_*` | `extract_metadata` | _(unset)_ | Per-vocabulary naddr overrides (e.g. `SCHEME_NADDR_HCRT`, `SCHEME_NADDR_SCHULFAECHER`) mapping well-known scheme URIs to relay-hosted SKOS vocabularies. See `.env.example` for the full list. |
| `HTTP_*`, `OAUTH_*` | `src/http.ts` only | see below | HTTP bind and OAuth resource-server settings — documented under [Option 4](#option-4-run-with-streamable-http-transport). |
| `EMBED_TOKEN` | `docker-compose.yml` only | _(unset)_ | Token for the embedding service used by the bundled local test relay. Not read by the server itself. |

## Usage

### Option 1: Add to Claude Code (Recommended)

```bash
claude mcp add amb-relay -- bun run /path/to/amb-mcp/src/stdio.ts
```

This uses the default public relay (`wss://relay.edufeed.org`). To point at another relay — e.g. the local docker relay from [Development](#test-against-local-relay) — add `-e AMB_RELAYS=ws://localhost:3337`.

### Option 2: Run with cvmi (ContextVM)

Start the server:
```bash
cvmi serve -- bun run src/stdio.ts
```

Connect from another machine:
```bash
cvmi use <server-pubkey>
```

### Option 3: Run standalone with Nostr transport

```bash
bun run src/index.ts
```

### Option 4: Run with Streamable HTTP transport

For web-based MCP clients (Claude.ai connectors, MCP Inspector, custom browser apps):

```bash
bun run src/http.ts   # dev
node dist/http.js     # production (after `npm run build`)
```

| Variable | Default | Description |
|---|---|---|
| `HTTP_PORT` | `3000` | Port to bind. |
| `HTTP_HOST` | `0.0.0.0` | Bind host. Use `127.0.0.1` to limit to a local proxy. |
| `HTTP_ALLOWED_HOSTS` | _(unset)_ | Comma-separated Host allow-list. Enables DNS-rebinding protection when set. |
| `HTTP_ALLOWED_ORIGINS` | _(unset)_ | Comma-separated Origin allow-list. |
| `OAUTH_ISSUER` | `https://auth.edufeed.org/realms/edufeed` | OIDC issuer whose tokens are accepted. |
| `OAUTH_AUDIENCE` | `amb-mcp` | Required `aud` claim in access tokens. |
| `OAUTH_JWKS_URI` | `<issuer>/protocol/openid-connect/certs` | JWKS endpoint for token signature verification. |
| `OAUTH_RESOURCE_URL` | `https://mcp.amb.edufeed.org/mcp` | Public resource URL advertised in the OAuth protected-resource metadata document. |

**Authentication model:** the HTTP transport is an OAuth 2.0 resource server.

- A request **without** an `Authorization` header gets an anonymous **read-only** session (`mcp:read`): search, get, browse, resolve, SKOS lookups.
- A request with a **valid JWT** (issued by `OAUTH_ISSUER` for audience `OAUTH_AUDIENCE`) is granted the token's scopes: `mcp:read` and/or `mcp:extract` (the budget-spending `extract_metadata` tool). An invalid token is rejected with 401.
- **Write/signing tools are never exposed over HTTP** — they are only available on the stdio and Nostr transports. Insufficient scope means the tool is simply absent from `tools/list`.

The server exposes:

- `POST /mcp` — JSON-RPC requests (initialize, tool calls, etc.)
- `GET /mcp` — server-push SSE stream for the current session
- `DELETE /mcp` — terminate the current session
- `GET /healthz` — unauthenticated liveness probe

Example handshake with `curl`:

```bash
# 1. initialize (anonymous = read-only session), capture the Mcp-Session-Id response header
curl -i http://localhost:3000/mcp -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2. reuse the session id for tools/list, tools/call, etc.
curl http://localhost:3000/mcp -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Session-Id: <id-from-step-1>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# To use extract_metadata, add an OAuth token to the *initialize* request:
#   -H "Authorization: Bearer $ACCESS_TOKEN"
# (scopes are fixed at session init; a token on later requests does not upgrade the session)
```

Smoke-test with [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

#### Choosing a connector's default relays

Most connector UIs (Claude.ai's "Add custom connector", for one) give you two
fields: a name and a URL. So the URL is where a connection states which relays
it wants searched by default:

```
https://mcp.amb.edufeed.org/mcp?relays=sodix
https://mcp.amb.edufeed.org/mcp?relays=amb-relay,sodix,oersi
```

The relays named in `?relays=` become that session's **default** set — searched
on every `search_content` / `search_resources` call. Every other relay the
deployment serves stays in the **extra** set: `list_relays` still advertises it,
and a tool call can still reach it through its own `relays` parameter. Without
the parameter, the session uses the server's configured default set, exactly as
before.

Names resolve against the relays the deployment already serves
(`AMB_RELAYS` ∪ `AMB_EXTRA_RELAYS`). Each relay answers to three forms:

| Form | Example |
|---|---|
| Full URL | `wss://sodix.edufeed.org` |
| Hostname | `sodix.edufeed.org` |
| First hostname label | `sodix` |

A short label claimed by two relays is dropped rather than guessed at — use the
hostname for those. The names are per deployment: `list_relays` on a plain
session shows exactly which relays a server offers, and a rejected `?relays=`
lists every name it accepts. A name the deployment does not serve fails the `initialize`
request with HTTP 400 and a JSON-RPC error listing the names it does accept;
the connection is never silently pointed at the server default. Arbitrary relay
URLs are **not** accepted, so a public endpoint cannot be used to make the
server open WebSocket connections to hosts of the caller's choosing.

`list_relays` reports `defaultRelaysSource: "connector-url"` on such a session,
so a model can tell a deliberately narrowed corpus from the deployment's
standard one.

#### Public deployment

A managed instance is hosted at:

```
https://mcp.amb.edufeed.org/mcp
```

It serves three relays — `amb-relay` (`wss://amb-relay.edufeed.org`, the
default), plus `oersi` and `sodix` as per-call extras — so
`…/mcp?relays=sodix` gives a connector that searches the SODIX corpus by
default. See [Choosing a connector's default relays](#choosing-a-connectors-default-relays).

It speaks the same streamable-HTTP protocol as the local server. **Read tools are public** — a request with no `Authorization` header gets a read-only session (search/get/browse/resolve). The budget-spending `extract_metadata` tool requires a valid OAuth token carrying the `mcp:extract` scope; tokens are issued by the Keycloak realm out-of-band — ask the operator. The handshake is otherwise identical to the curl example above; just substitute the URL and drop the `Authorization` header for read-only use.

The public endpoint is rate-limited per source IP at the edge (Traefik) — `search_passages` in particular embeds each query on the in-stack CPU service, so bursts are throttled. Normal interactive use is unaffected.

## Available Tools

Tools are grouped into three profiles:

- **Read** — search, get, browse, resolve, SKOS lookups, calendar. Available on all transports; served anonymously over HTTP.
- **Extract** — `extract_metadata`. Over HTTP requires an OAuth token with the `mcp:extract` scope.
- **Write** — signer, publish, relay management, and SKOS vocabulary builder tools. Only exposed on the stdio and Nostr transports, never over HTTP.

### search_content

Topic search across **all** content types in one ranked call — educational
resources (30142), long-form articles (30023), wikis (30818), transferkiosk
projects (30143), transferkiosk measures (30144), and NKBIP-01 scientific
publications (30040 indices + 30041 sections — academic articles, books).
Results are interleaved and ranked by semantic passage match; each carries
the matched passage (`snippet`) when the relay's chunk re-ranking is active.

**Discovery vs. question intent.** When `search_passages` is available (the
indexer is configured), the two tools split by intent: `search_content` is
for **discovery** — the user wants materials to browse ("finde/empfiehl
Materialien zu X"), and you present the items as links. For a **question**
the user wants answered from the sources ("wie/warum/was hilft bei X?"), use
`search_passages` instead. When the indexer is not configured,
`search_content` is the default entry point for natural-language questions.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `query` | string | Free-text topic |
| `types` | string[] | Subset of `["resource","article","wiki","project","measure","publication"]` (default: all) |
| `language` | string | Label language (default `de`) |
| `since` / `until` | number | Unix timestamp bounds |
| `authors` | string[] | Author pubkeys (hex) |
| `limit` | number | Max results, 1-250 (default 20) |
| `community` | string | Return content shared into this community (hex pubkey or npub) |
| `relays` | string[] | Restrict to specific relays — by full URL or short name (`oersi`, `sodix`). See [`list_relays`](#list_relays). |

Each result: `{ type, kind, title, url?, naddr?, snippet?, score?, ...type-specific }`.
For upcoming events on the same topic, follow up with `search_calendar_events`.

If a selected relay times out or is unreachable, the response adds
`relaysIncomplete` (the affected relays) and a `warning` — an empty or short
result under that warning is **not** proof the corpus is empty. Absent those
fields, every relay answered.

### search_passages

Grounded RAG: retrieves the best-matching **fulltext passages** for a
question and returns them with citations (source resource, page, heading,
source URL) — answer the user *from* the passages and cite each source. This
is the default tool for question-shaped queries; use `search_content` for
discovery. Requires the indexer (`INDEXER_ENDPOINTS`); absent that config the
tool is not registered.

Scope is **required** (the tool never runs an unscoped search) but usually
trivial — with no source restriction, pass the content kinds. A restriction
routes into scope: a metadata **publisher** (`resolve_publisher` finds the
exact spelling) into `search` as a quoted field filter
(`publisher.name:"LEHRE LADEN"`); a Nostr **signer** (`resolve_author`) into
`authors`. Scope can also come from a published **grimoire spell** (kind 777)
passed by `nevent`/event id; every response echoes the canonical spell for
the scope so it can be published and reused. Spells may use `$me`/`$contacts`,
resolved to the caller (pass `me` when the transport is anonymous).

**Ranking.** The indexer runs a Typesense hybrid search; `search_passages`
requests vector weight `alpha: 0.7` (the indexer's own default is the
keyword-leaning 0.3, kept for the relay's rerank path), so the semantic rank
leads and boilerplate keyword matches ("GRUNDSCHULE", "Kinder") stop winning.
It over-fetches `min(limit × 3, 100)` chunks, then keeps at most **two
passages per document** (`event_coord`), drops hits below **10 % of the top
score**, and returns the first `limit`. Phrase `question` as a topical
statement naming subject and target group
("Friedenserziehung in der Grundschule: Einstieg in das Thema Frieden mit
Kindern") rather than the user's literal sentence ("Wie kann ich …?"). A
passage with only a snippet and no text is either license-gated or has no
fulltext indexed yet.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `question` | string | The question/topic to find grounding passages for |
| `spell` | string | Published spell: `nevent`, note id, or 64-hex event id (alternative to inline scope) |
| `authors` | string[] | Inline scope: signer pubkeys (hex/npub/`$me`/`$contacts`) |
| `kinds` | number[] | Inline scope: content kinds (e.g. `[30142]`) |
| `tag` | object | Inline scope: one tag filter, `{ letter, values }` |
| `search` | string | Inline scope: NIP-50 term selecting the events in scope (quote multi-word field values) |
| `since` / `until` | string | Inline scope: absolute Unix seconds or relative (`7d`, `1mo`, `now`) |
| `me` | string | Who `$me` refers to (npub/hex); defaults to the calling identity |
| `relays` | string[] | Relay selection (full URL or short name); first mapped relay is used |
| `limit` | number | Passages to return, 1-25 (default 10) |

Failure is explicit, never a silent unscoped search: `empty_scope` (the relay
answered but nothing matched), `relay_unreachable` (the content relay did not
answer — retry), `spell_not_found`, `no_indexer`, `indexer_error`.

**Facet-in-query syntax:** relay-side facets ride inside `query` as NIP-50
field filters rather than as separate parameters — append them to the
free-text term and the relay resolves them server-side. Examples: `type:academic`
(publication display type), `doi:10.1234/abcd.5678` (bare DOI, no `doi:` prefix
in the stored value), `keywords:<term>` (topic words), or `partOf:30143:<pubkey>:<d>` (publications/measures that
belong to a given project coord). These can be combined with a topic term,
e.g. `query: "seminardidaktik partOf:30143:<pubkey>:<d>"`.

### search_resources

Search for educational resources using full-text search and metadata filters.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `query` | string | Free-text search query |
| `publisherName` | string | Filter by publisher name |
| `creatorName` | string | Filter by creator/author name |
| `subjectLabel` | string | Filter by subject label (e.g., "Mathematik") |
| `resourceTypeLabel` | string | Filter by resource type (e.g., "Video", "Kurs") |
| `educationalLevelLabel` | string | Filter by educational level |
| `language` | string | Language for labels (default: "de") |
| `authors` | string[] | Filter by author pubkeys (hex) — e.g. from `resolve_author` or `list_known_authors` |
| `since` / `until` | number | Unix timestamp bounds on resource creation time |
| `limit` | number | Max results, 1-250 (default: 20) |
| `relays` | string[] | Restrict to specific relays — by full URL or short name (`oersi`, `sodix`) |

The `subjectLabel` / `resourceTypeLabel` / `educationalLevelLabel` filters are
**exact** label matches (case-insensitive), not free text — a phrase that
isn't a stored label returns 0. Put topic words in `query`; use `browse_*`
to discover valid labels. `publisherName` / `creatorName` are exact too, but
suggest near spellings (`actorCandidates`) on a zero-match.

### get_resource

Retrieve a single piece of content by naddr, d-tag identifier, or event ID.
An naddr from any `search_content` result resolves — resources, articles,
wikis, projects, measures, and publications alike; non-resource kinds come
back in the same shape as their `search_content` result (`{ type, kind,
title, ... }`), not the full AMB resource shape. A bare `identifier`/`eventId`
lookup (no `naddr`) always resolves the full educational-resource metadata
(kind 30142), including creator/publisher and educational properties.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `identifier` | string | Resource d-tag (URL identifier) — resolves kind 30142 only |
| `author` | string | Author pubkey for disambiguation |
| `eventId` | string | Direct Nostr event ID lookup — resolves kind 30142 only |
| `naddr` | string | NIP-19 naddr from a `search_content` result — preferred; works for any content type |

#### Response shape (search_resources and get_resource)

Each returned resource includes the standard AMB fields plus:

- `nostr.naddr` — NIP-19 addressable identifier (`kind=30142`, pubkey, d-tag). Useful for any Nostr client.
- `url` — direct link to the edufeed-app page for this resource. **Only present when `EDUFEED_APP_BASE_URL` is configured.** LLM clients should cite this as a markdown link (`[name](url)`) when recommending the resource so users can open it.

`search_content`, `search_resources`, and `search_calendar_events` add
`relaysIncomplete` + a `warning` when a selected relay timed out or was
unreachable — under that warning an empty result is not proof the corpus is
empty, so tell the user a source was unreachable and offer to retry. When
every relay answers, neither field appears.

### resolve_author

Resolve an organisation or person **name** to candidate pubkeys using the relay's
kind-0 author-profile index (NIP-50 search). This is the entry point for
name-driven questions ("recent articles by Jörg Lohrer"): resolve the name, pick
the best candidate, then pass its pubkey to `search_content({ authors: [pubkey] })`
or `search_calendar_events`. Returns up to `limit` candidates ranked by relevance.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `name` | string | Org or person name to resolve |
| `limit` | number | Max candidates, 1-25 (default 10) |

### list_known_authors

List known educational-resource authors loaded from the configured follow sets
(NIP-51 kind 30000, see `AMB_AUTHOR_SETS`). Returns names, pubkeys, and NIP-05
identifiers. Distinct from `resolve_author`, which searches the relay-wide
profile index rather than hand-curated sets.

### browse_subjects

List available subjects/topics with resource counts.

### browse_resource_types

List available learning resource types (Video, Course, Worksheet, etc.).

### browse_educational_levels

List available educational levels (Primary, Secondary, Higher Education, etc.).

### relay_stats

Get relay information including name, description, and supported NIPs.

### list_relays

List all AMB relays configured for the current session, split into
`defaultRelays` (searched on every query) and `extraRelays` (selectable per
call). A `relays` parameter (on `search_content`, `search_resources`,
`get_resource`, `search_passages`) names relays from either group by full
URL **or short name** — the hostname or first label (`oersi`, `sodix`,
`amb-relay`), case-insensitive; an ambiguous label shared by two relays
resolves only by its longer forms. `defaultRelaysSource` says whose choice the default set was —
`server-config`, or `connector-url` when the connection URL named it via
[`?relays=`](#choosing-a-connectors-default-relays). The write profile
additionally exposes `add_relay` / `remove_relay` to adjust the session's relay
set at runtime (per-session over HTTP; process-wide on stdio).

### relay_list_get

Fetch a user's NIP-65 relay list (kind 10002). See
[NIP-65 Outbox Model](#nip-65-outbox-model) below for the response shape.

### SKOS vocabulary tools

Read tools for controlled vocabularies hosted as Nostr events or referenced by URI:

- `skos_list_vocabularies` — list vocabularies known to the server
- `skos_get_vocabulary` / `skos_get_vocabulary_status` — fetch a scheme with its concepts / check availability
- `skos_get_concept` — fetch a single concept with labels and relations
- `skos_search` — search concepts across vocabularies by label

The write profile adds a vocabulary **builder** suite (`skos_create_vocabulary`,
`skos_add_concept`, `skos_update_concept`, `skos_remove_concept`,
`skos_set_relationship`, `skos_add_mapping`, `skos_import_turtle`,
`skos_export_turtle`, `skos_delete_vocabulary`) for authoring SKOS vocabularies
and publishing them as Nostr events.

### extract_metadata

Fetch one or more public web pages (or PDFs) and produce an AMB/EKW form-prefill
payload. Returns OpenGraph/JSON-LD fallback by default; with `ANTHROPIC_API_KEY`
set, an LLM grounded in the configured SKOS vocabularies fills SKOS-typed fields
with concept IDs and per-field evidence quotes. Also available as a library
export: `import { extractMetadata } from 'amb-mcp/lib'`.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `url` | string | Public http(s) URL to extract (use `urls` for multiple sources) |
| `urls` | string[] | Multiple source URLs merged into one extraction (e.g. several PDFs) |
| `variant` | string | Form variant: `amb` (default), `ekw` (adds religious-education fields), `konfi` (adds Konfi-Arbeit fields) |
| `skosSchemes` | object | Map of form field → SKOS scheme URI, overriding `SKOS_SCHEMES` |

Fetching is SSRF-aware (private/loopback ranges are blocked).

### search_calendar_events

Search for NIP-52 calendar events (date-based 31922, time-based 31923). Supports
temporal filters, geohash location filtering, and hashtag filtering.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `query` | string | Free-text topic. **Caveat:** when combined with time/geo range filters the relay prioritises the range server-side and ignores this field — for "events about X next week" pass the time range and filter returned events by topic client-side. |
| `startAfter` / `startBefore` | number | Unix timestamp bounds for event start |
| `endAfter` / `endBefore` | number | Unix timestamp bounds for event end |
| `geohash` | string | Geohash prefix for location-based search |
| `hashtags` | string[] | Filter by hashtags |
| `authors` | string[] | Author pubkeys (hex) |
| `kinds` | number[] | Event kinds to query (default: `[31922, 31923]`) |
| `since` / `until` | number | Unix timestamp bounds on event creation time |
| `limit` | number | Max results, 1-250 (default 20) |

Each event carries `naddr` (NIP-19 addressable identifier) and, when
`EDUFEED_APP_BASE_URL` is set, `url` (the edufeed-app viewer at `<base>/<naddr>`).
Prefer citing `url` over `sourcePage`, since the viewer shows fuller event details.

### list_calendar_authors

List known calendar event authors loaded from configured follow sets (NIP-51 kind 30000).
Returns author names, pubkeys, and NIP-05 identifiers. Use the returned pubkeys with
`search_calendar_events(authors: [...])` to filter events by author.

---

## Signing and Publishing

The MCP server supports signing and publishing Nostr events via NIP-46 remote signing (bunker).

### Connecting a Signer

#### Option 1: QR Code Flow (Recommended)

1. Call `signer_init` to generate a nostrconnect:// URL and QR code
2. Scan the QR code with your bunker app (Amber, nsecBunker, etc.)
3. Call `signer_await` to wait for the connection to complete

#### Option 2: Bunker URL

If you have a bunker:// URL from your signer app, use `signer_connect` directly.

#### Option 3: Private Key (Development Only)

For testing, use `signer_connect` with an nsec and `allowInsecure=true`. **Never use this in production.**

### Signer Tools

### signer_init

Generate a QR code for connecting a signer app.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `relays` | string[] | Relays for NIP-46 communication (defaults to AMB relays) |
| `name` | string | Client name shown in the bunker app |
| `permissions` | string[] | Requested permissions (e.g., `["sign_event:0", "sign_event:30142"]`) |

Returns:
- `sessionId` - Session ID for `signer_await`
- `nostrconnectUrl` - The nostrconnect:// URL
- `qrCode` - ASCII QR code for terminal display

### signer_await

Wait for a bunker app to connect after scanning the QR code.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `sessionId` | string | Session ID from `signer_init` |
| `timeout` | number | Timeout in seconds (default: 120) |

### signer_connect

Connect directly using a bunker URL or private key.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `bunkerUrl` | string | bunker:// URL from your signer app |
| `nsec` | string | Private key (nsec or hex) - **development only** |
| `allowInsecure` | boolean | Required when using nsec |

### signer_disconnect

Disconnect the current signer session.

### signer_status

Check the current signer connection status.

Returns:
- `connected` - Whether a signer is connected
- `userPubkey` - The connected user's public key
- `connectedAt` - ISO timestamp of connection time

---

## Publishing Tools

### sign_event

Sign an unsigned Nostr event using the connected signer.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `kind` | number | Event kind (e.g., 0 for metadata, 1 for note) |
| `content` | string | Event content |
| `tags` | string[][] | Event tags as array of arrays |

### publish_event

Publish a pre-signed Nostr event to relays.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `event` | object | Signed Nostr event with id, pubkey, created_at, kind, tags, content, sig |
| `relays` | string[] | Relays to publish to (defaults to AMB relays) |
| `useOutbox` | boolean | Use NIP-65 outbox model for relay selection (default: true) |

### create_and_publish_metadata

Build, sign, and publish a kind 0 profile metadata event.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `name` | string | Display name |
| `about` | string | Bio/description |
| `picture` | string | Avatar URL |
| `banner` | string | Banner image URL |
| `nip05` | string | NIP-05 identifier (e.g., user@domain.com) |
| `lud16` | string | Lightning address |
| `website` | string | Website URL |
| `relays` | string[] | Relays to publish to |
| `useOutbox` | boolean | Use NIP-65 outbox model for relay selection (default: true) |

### create_and_publish_resource

Build, sign, and publish a kind 30142 AMB educational resource event.

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `identifier` | string | Unique identifier (d-tag) for the resource |
| `name` | string | Resource name/title |
| `description` | string | Resource description |
| `url` | string | Resource URL |
| `image` | string | Image/thumbnail URL |
| `type` | string[] | Resource types (e.g., `["LearningResource", "VideoObject"]`) |
| `inLanguage` | string[] | Language codes (e.g., `["de", "en"]`) |
| `about` | object[] | Subject concepts with `id` and optional `prefLabel` |
| `learningResourceType` | object[] | Learning resource types from HCRT vocabulary |
| `educationalLevel` | object[] | Educational level concepts |
| `creator` | object[] | Content creators with `name`, `type`, `id` |
| `publisher` | object[] | Publishers with `name`, `type`, `id` |
| `license` | object | License with `id` (URL) and optional `name` |
| `isAccessibleForFree` | boolean | Whether the resource is free to access |
| `datePublished` | string | Publication date (ISO 8601) |
| `relays` | string[] | Relays to publish to |
| `useOutbox` | boolean | Use NIP-65 outbox model for relay selection (default: true) |

---

## NIP-65 Outbox Model

Publishing tools use the NIP-65 outbox model by default for intelligent relay selection:

1. **Author's write relays** - Fetched from kind 10002 events
2. **Tagged users' read relays** - For p-tagged mentions, fetches their read relays
3. **Default relays** - Falls back to configured AMB relays

This ensures events are delivered to relays where both the author publishes and where tagged users expect to receive events.

### relay_list_get

Fetch a user's NIP-65 relay list (kind 10002).

Parameters:
| Name | Type | Description |
|------|------|-------------|
| `pubkey` | string | Public key to fetch relay list for (defaults to connected signer) |

Returns:
- `pubkey` - The queried public key
- `readRelays` - Array of relay URLs marked as read
- `writeRelays` - Array of relay URLs marked as write
- `totalRead` - Count of read relays
- `totalWrite` - Count of write relays

---

## Available Resources

| URI | Description |
|-----|-------------|
| `amb://schema` | AMB JSON-LD schema |
| `amb://vocabularies/subjects` | Subject vocabulary |
| `amb://vocabularies/resource-types` | Learning resource types vocabulary |
| `amb://vocabularies/educational-levels` | Educational levels vocabulary |
| `amb://relay-info` | NIP-11 relay information |

## Deployment

The server has three entry points; pick the one that matches your client:

- **`src/index.ts`** (default `CMD`) — Nostr/ContextVM transport. No HTTP port. Clients reach it by addressing its pubkey on the configured ContextVM `RELAYS`. Requires `SERVER_PRIVATE_KEY`.
- **`src/stdio.ts`** — stdio transport for `cvmi serve` and Claude Code as a local subprocess.
- **`src/http.ts`** — Streamable HTTP transport on `HTTP_PORT` (default `3000`). Use for web-based MCP clients. See [Option 4](#option-4-run-with-streamable-http-transport) above for env vars and the handshake.

### Prerequisites on the host

- Node ≥ 20 (or Bun ≥ 1.1) for runtime.
- Outbound WebSocket access to the configured AMB and ContextVM relays.
- Outbound HTTPS for the `extract_metadata` tool (target pages and, optionally, the Anthropic API).
- Network access to `git.edufeed.org` during install — the `amb-nostr-converter` dependency is fetched as a published tarball from the edufeed npm registry (see `package.json`).

### Build & run

```bash
bun install              # or: npm install
bun run build            # tsc -> dist/
node dist/index.js       # production entry; uses Nostr transport
```

For development without a build step: `bun run src/index.ts`.

### Identity & secrets

- `SERVER_PRIVATE_KEY` is the server's persistent Nostr identity. **Losing or rotating it changes the pubkey clients use to address the server**, so treat it as long-lived state. Mint one with `nak key generate` (or any Nostr keygen) and store it via your secret manager — never commit it.
- The matching pubkey is what users pass to `cvmi use <pubkey>`. Print it once after first start so operators can record it.
- `ANTHROPIC_API_KEY`, if used, should be scoped to this service; the `extract_metadata` tool will spend tokens on every call where SKOS grounding is requested.

### State & persistence

The server itself is stateless on disk — all state lives on the configured relays. The only thing that needs to persist across restarts is the env file containing `SERVER_PRIVATE_KEY`. No volume is required for the MCP container.

### Discovery

On startup with Nostr transport, the server publishes a ContextVM announcement to `RELAYS`. To remove an old announcement (e.g. after rotating the key or decommissioning), use `scripts/unpublish-server.ts`.

### Operational notes

- **Logging:** plain stdout/stderr. Capture via your process supervisor (systemd journal, Docker logs, etc.).
- **Healthcheck:** the Nostr and stdio entry points have no HTTP healthcheck — liveness ≈ "process is up and the relay subscription has not errored", integrate at the supervisor level. The HTTP entry point exposes `GET /healthz` (unauthenticated) for probes.
- **`extract_metadata` egress:** the tool fetches arbitrary URLs supplied by callers. Fetching is SSRF-aware (private/loopback ranges blocked) but you should still consider running it behind an egress proxy if your homelab restricts outbound traffic.
- **Resource footprint:** small — a single Node process with a handful of WebSocket connections. No database, no cache directory.

## Development

### Run tests

```bash
bun run test        # vitest, no network needed
```

### Test against local relay

`docker-compose.yml` in this repo starts a local AMB relay (with Typesense) on
`ws://localhost:3337` — it expects a sibling checkout of `amb-relay` at
`../amb-relay` for the image build:

```bash
docker compose up -d
AMB_RELAY_URL=ws://localhost:3337 bun run scripts/test-client.ts
```

## Scripts

- `scripts/ask.ts` — pose a natural-language question to `search_content` and print the structured result an LLM client would receive
- `scripts/test-client.ts` — quick relay-client smoke test (relay info, queries, transforms)
- `scripts/smoke-search-content.ts` / `scripts/smoke-extract-metadata.ts` — live smoke tests against the dev relay
- `scripts/unpublish-server.ts` — remove server from public ContextVM discovery
- `scripts/delete-announcements.ts` — attempt to delete announcement events

## Architecture

```
src/
├── index.ts          # Nostr/ContextVM transport entry point
├── stdio.ts          # Stdio transport entry point (for cvmi/Claude Code)
├── http.ts           # Streamable HTTP transport entry point (OAuth resource server)
├── session.ts        # Per-session MCP server factory (relay clients + tool profile)
├── server-info.ts    # Server name/version constants
├── authors.ts        # NIP-51 follow-set author directories
├── transport/
│   ├── http.ts       # Express app + StreamableHTTPServerTransport wiring
│   ├── auth.ts       # JWT verification (JWKS)
│   └── prm.ts        # OAuth protected-resource metadata document
├── relay/            # AMB relay client + NIP-50 filter builders
├── calendar/         # NIP-52 calendar filters + transforms
├── content/          # Multi-kind content transforms + snippet handling (search_content)
├── profiles/         # Kind-0 profile transforms (resolve_author)
├── skos/             # SKOS vocabulary client, parser, cache, Nostr loader
├── lib/              # extract_metadata library (fetch, PDF, LLM, vocab grounding)
├── signer/           # NIP-46 signing, publishing, NIP-65 relay lists, event builders
├── tools/            # One module per MCP tool (registered via tools/index.ts profiles)
├── resources/        # amb:// MCP resources (schema, vocabularies, relay info)
├── types/            # AMB TypeScript types
└── utils/            # Event → AMB resource transforms, community helpers
```

## License

This is free and unencumbered software released into the public domain. See [UNLICENSE](UNLICENSE) for details.
