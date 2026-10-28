# License tiers: find every licensed resource, gate output by license

Date: 2026-10-28 · Repos: amb-mcp, amb-indexer (amb-relay/nostrlib: config only) · Ships together

## Why

laoc searched NOPE-MCP for the "Projekt Gendering MINT didaktisch-digital"
materials and got nothing: `resolve_publisher` finds 10 resources, but
`search_resources(creatorName=…)` returns `total: 0`, and topical searches
(`search_content`, `search_passages` on "gendersensible Lehre MINT") never show
them. Verified in the raw events on dev.amb-relay (2026-10-28): all 10 carry
`license:id = https://creativecommons.org/licenses/by-nc-sa/4.0/`, correctly
mapped. The open-only gate (CC0/PDM/BY/BY-SA) in amb-mcp and amb-indexer hides
them by design — and that design is too strict. CC NC/ND variants are a large
share of the corpus (BY-NC-SA 4.0 alone: 4229 of the sampled events in
`test/fixtures/license-ids.json`), and ~6.5k sampled events have no `license:id`
at all.

Second finding (recon, 2026-10-28): **non-open text already leaks.**
amb-indexer fetches and chunks every resource regardless of license and without
any robots.txt/TDM check; it withholds `text` for non-allowlisted licenses but
always stores and returns a 200-rune `snippet` per chunk (`schema.go:156`,
`search.go:414`). nostrlib's chunk rerank turns that snippet into kind-21142
events (`khatru/semantic/snippet.go:21`), which amb-mcp surfaces as
`search_content`'s `snippet`. All-rights-reserved material therefore shows
excerpts today. This design closes that.

## Goals

Two tiers for learning resources (kind 30142), keyed on the `license:id` tag:

**Tier 1 — `accessLevel: "full"`**: any Creative Commons license or the public
domain: CC0, PDM, CC BY, BY-SA, BY-NC, BY-NC-SA, BY-ND, BY-NC-ND (any version,
port, `deed.*`/`legalcode*` form, http or https). Full functionality as open
licenses have today: metadata, link, fulltext index, snippets, passages.

**Tier 2 — `accessLevel: "metadata-only"`**: everything else — all rights
reserved, no `license:id`, unknown/non-CC URIs (e.g.
`https://w3id.org/kim/license/attribution`).
- Findable via metadata (title, description, keywords, creator/publisher, …)
  with a link to the source.
- **Never** any fulltext output: no `text`, no `snippet`, no passages — not from
  the indexer API, not via 21142 events, not via the relay's stored `content`.
- Fulltext is fetched and indexed **only if no machine-readable TDM
  reservation (§ 44b Abs. 3 UrhG)** applies; the check result is stored per
  resource. Even then the text serves ranking/matching only.

**For all tiers**, every learning-resource result in `search_resources`,
`search_content`, `search_passages` and `get_resource` carries:
- `license: { id, label }` — the raw URI and a short label (`"CC BY-NC-SA 4.0"`,
  `"CC0 1.0"`, `"PDM 1.0"`; tier 2 without a CC match: the raw URI as id and a
  label like `"unknown"` / `"none"` when the tag is missing),
- `creator` and `publisher` (names) for attribution,
- `accessLevel: "full" | "metadata-only"`.

New optional parameter `licenseFilter: "open" | "cc-any" | "any"` on
`search_resources`, `search_content`, `search_passages` (default `"any"`):
- `open` = CC0 / PDM / BY / BY-SA (today's behaviour),
- `cc-any` = all of tier 1,
- `any` = tier 1 + tier 2.

## Non-goals

- Kinds other than 30142 (articles, wikis, publications 30040/30041, projects,
  measures, calendar) keep their current behaviour — no license filter,
  `LICENSE_EXEMPT_KINDS` unchanged. In amb-indexer, the tier logic, the TDM
  check, the snippet suppression and the migration rule all apply to kind
  30142 only; content-direct kinds keep `license_denied` + snippet as today
  (their body is public in the event anyway). (my call)
- No interpretation of human-readable terms of use. Instead a manual host
  denylist (below), empty at launch.
- kind-1063 license attestations for uploaded files (`license-events-nope.md`)
  — separate topic.
- No change to ranking weights / alpha.

## Anti-goals (failure even if it "works")

- Tier-2 fulltext stored in readable form anywhere (Typesense stored fields,
  Bolt, relay `content`, logs).
- Any tier-2 character from the fetched fulltext reaching a client — through
  `text`, `snippet`, Typesense highlights, 21142 events, relay `content`,
  the indexer `/ui`, or error messages.
- Fetching/mining a tier-2 resource whose source declares a TDM reservation.
- Tier-2 resources silently missing again, or showing up with no hint why they
  have no passage.

## Design

### amb-indexer (Go) — where the policy is enforced

**1. License classification** (`license.go`). Replace the binary
`LicensePermissive` decision with a tier: `full` if `NormalizeLicense` yields
`CC0`, `publicdomain` or any `CC-*` variant from the set above; otherwise
`restricted`. `LICENSE_ALLOWLIST` keeps working as the configurable source of the
tier-1 set; its default becomes
`CC0,CC-BY,CC-BY-SA,CC-BY-NC,CC-BY-NC-SA,CC-BY-ND,CC-BY-NC-ND,publicdomain`
(and the homelab `env.indexer.j2` template is updated accordingly). Exempt kinds
stay `full`.

**2. TDM reservation check — tier 2 only, before the body is used.** For a
restricted resource, before tier-1/2/3 fetch (`worker.go:146-201`):
- **Host denylist**: new env `TDM_DENY_HOSTS` (CSV of hostnames, suffix match on
  registrable domain is the builder's call; empty default). Hit → reserved,
  source `denylist`. No network request.
- **robots.txt** (RFC 9309), cached per origin (Bolt bucket, 24 h TTL):
  evaluate the group for the indexer's product token `amb-indexer`, falling back
  to `*`. Disallow for the resource path → reserved, source `robots`. Blocks
  aimed only at other named crawlers (GPTBot, CCBot, Google-Extended, …) are
  **not** treated as a reservation for us, nor are `X-Robots-Tag: noai`-style
  headers (laoc, 2026-10-28: "let's not be so cautious").
  Unreachable / 5xx → reserved (RFC 9309 "complete disallow"); 4xx → no
  reservation.
- **TDMRep** (W3C TDM Reservation Protocol): `/.well-known/tdmrep.json` per
  origin (cached like robots; 404 → absent), then the `tdm-reservation` HTTP
  response header of the resource itself, then for HTML the
  `<meta name="tdm-reservation" content="1">` tag. Value `1` → reserved, source
  `tdmrep-file` / `tdmrep-header` / `tdmrep-meta`. A `tdm-policy` link does not
  lift the reservation (we don't parse policies).
- Fetching the resource to read its header/meta is permitted; if reserved,
  the body is discarded before chunking/embedding.
- The headless tier (browserless) must not run for a reserved resource, and
  must send the same UA (today `fetch_headless.go` sets none — fix).
- `nostr:` sources (event content) are not web sources: no robots/TDMRep check,
  but they are still tier 2 for output if restricted.

**Stored result per resource**: new Bolt bucket `tdm` keyed by event id →
`{reserved bool, source string, checked_at int64}`, plus a chunk-level Typesense
field (see 3). Re-checked whenever the event is (re)processed; an admin endpoint
`POST /admin/tdm/recheck` (by host or event) re-runs the check. Periodic
re-check cadence is the builder's call (suggest 30 days).

**3. What gets stored and returned.** New chunk field `text_policy`
(`full` | `match_only`), replacing the meaning of `license_permissive` (keep that
field written for one release for compatibility, or migrate — builder's call).
- Tier 1: as today's permissive path (`text` + `snippet` stored and returned).
- Tier 2, no reservation: chunks are indexed for keyword matching and embedded,
  but **the text is not stored** (laoc, 2026-10-28). Use a separate Typesense
  field (e.g. `match_text`, `"store": false`, supported by the deployed
  Typesense 28) for match-only chunks, included in `query_by`; `text` stays
  empty and `snippet` is stored empty; `text_policy = match_only`. So the
  verbatim text is unreadable from the index by construction, and the
  fetched body is discarded after chunking/embedding (§ 44b Abs. 2).
  `translateHit` additionally returns neither `text` nor `snippet` for
  `match_only` (backstop). Highlights: confirm no highlight is produced from
  `match_text` (non-stored fields should not highlight; verify and test).
- Tier 2, reserved: **no chunks** for the resource; any existing chunks for the
  coord are deleted. Status `tdm_reserved`.
- `setcontent` to the relay: text only for tier 1; empty for tier 2 (as today's
  `license_denied`). Status `license_denied` for match-only, new
  `tdm_reserved` for reserved — amb-relay's `content_store.go` gets the new
  constant (status is a free string there; add it for documentation/metrics).
- `search_chunks` response: each hit gains `access_level`
  (`full` | `metadata-only`) and keeps `amb.license`. Optional request filter
  `text_policy` added to the filter allowlist (`search.go:265`) so amb-mcp can
  ask for `licenseFilter` scopes server-side where useful.
- Check `/ui` and `cmd/mcp` for paths that display `text`/`snippet` of
  match-only chunks; gate them the same way.

**4. Migration of existing data.** Every currently indexed restricted resource
was fetched without a TDM check and has a 200-rune snippet stored. On deploy:
- Include a policy version in the idempotency hash (`worker.go:107`, today
  `sha256(url+model)`) so restricted events reprocess once; tier-1 events whose
  outcome changes (NC/ND now full) also need reprocessing to gain `text`. Whether
  to bump the hash for all events or only non-open ones is the builder's call
  (embedding cost vs. simplicity).
- Until a restricted resource is reprocessed, `translateHit` must already
  suppress its snippet (gate on the stored license, not on new fields), so the
  leak closes at deploy time, not after the backfill.

### amb-relay / nostrlib

No logic change: `BuildSnippetEvent` already skips empty snippets, and the relay
only stores what `setcontent` sends. Config: none. Add the `tdm_reserved` status
constant. Optional hardening (builder's call): have nostrlib's
`searcher_http.go` also drop snippets when `access_level == metadata-only`.

### amb-mcp (TypeScript) — tool surface

**`src/license/`**: replace the open/not-open boolean with
`classifyLicense(uri?) → { group: 'open' | 'cc' | 'other' | 'none', label, id }`
and `accessLevel(group) → 'full' | 'metadata-only'` (`open`/`cc` → full).
Label derivation from the CC URI (variant + version + optional port, e.g.
`CC BY-SA 3.0 DE`). Lists of stored spellings for relay-side filtering:
`OPEN_LICENSE_URIS` (exists) and new `CC_LICENSE_URIS`, both derived from and
kept in lock-step with `test/fixtures/license-ids.json` (refresh the fixture).

**`licenseFilter` parameter** (default `any`) on the three search tools:
- `search_resources`: without free text, `open`/`cc-any` add the matching
  `license.id:` tokens relay-side (as today); `any` adds none. With free text,
  over-fetch and post-filter client-side (as today). Client-side post-filter
  always runs for `open`/`cc-any`.
- `search_content`: client-side filter on 30142 results; other kinds untouched.
- `search_passages`: client-side on hits (`passageSelection.ts`), plus the
  indexer filter where it narrows the query.
- Replace env `OPEN_LICENSES_ONLY` with `LICENSE_FILTER_MAX`
  (`open|cc-any|any`, default `any`). It is an operator **ceiling**, not a
  preference: a per-call `licenseFilter` can only narrow it (a wider request is
  clamped, and the response says so in `hint`). Tool descriptions mention the
  ceiling when it is below `any`. A legacy `OPEN_LICENSES_ONLY=true` maps to
  `open` with a deprecation log line, so existing deployments keep their policy.
  `get_resource` stays unfiltered. Update README, `.env.example`, and the
  homelab `nope-mcp` compose template.

**Result shape**:
- `search_resources` / `get_resource` (`SimplifiedAMBResource`): `license`
  becomes `{ id, label }` (null when missing — still present so the model sees
  it), add `accessLevel`. `get_resource` keeps `openLicense` for one release
  (deprecated) next to `accessLevel`.
- `search_content` `ResourceResult`: add `license`, `accessLevel`; for
  `metadata-only` drop `snippet`/`page`/`heading` even if a 21142 event arrived
  (defence in depth).
- `search_passages`: tier-1 hits as today, with `license`, `accessLevel`,
  creator/publisher (from `amb` enrichment; fall back to get_resource-style
  lookup if absent — builder's call). Tier-2 hits that matched are **not**
  dropped silently: they are listed in a separate `metadataOnlyMatches` array
  (naddr, title, license, accessLevel, creator/publisher, sourcePage — no text),
  so the model can point to them and knows why there is no passage. (my call)
- The existing rule "a hit without `text` is not released" stays as a safety
  net.

**Descriptions and hints** — all strings stating "only CC0/PD/BY/BY-SA":
`src/server-info.ts` (instructions, `snippetOnlyReason`),
`src/tools/search.ts` (description + zero-match actor hint at L77-80),
`src/tools/searchContent.ts`, `src/tools/searchPassages.ts`,
`src/tools/get.ts` (`openLicenseNote`). New wording explains the two tiers,
`accessLevel`, `licenseFilter`, and that the model must attribute (license +
creator/publisher) and must not quote metadata-only resources beyond their
metadata.

## Constraints

- Ships as one coordinated release: amb-indexer (+ backfill trigger) first or
  simultaneously with amb-mcp; amb-mcp must not show `accessLevel: full` for a
  resource whose passages the indexer still withholds — `full` is derived from
  the license, and the indexer's new default allowlist makes them consistent.
- Tests: amb-mcp vitest (`npm test`); amb-indexer `GOWORK=off go test -race ./...`
  plus `e2e_test.sh` (extend its `license_denied` case with NC/ND → full,
  unlicensed → match-only with empty snippet, TDM-reserved → no chunks).
- Each tier-2 leak path in the anti-goals gets a test.
- Release via tags per repo (amb-mcp: Nostr-canonical, minor bump to 0.7.0).

## Calls I made (check these)

- Tier 2 includes non-CC "attribution" URIs like `w3id.org/kim/license/attribution`
  (the issue lists only CC variants for tier 1).
- robots.txt unreachable/5xx counts as reserved; tdmrep.json missing does not.
- Reserved resources get no chunks at all (not even metadata chunks).
- `metadataOnlyMatches` in `search_passages` rather than mixing text-less hits
  into `passages`.
- `OPEN_LICENSES_ONLY` replaced by `LICENSE_FILTER_MAX` as an operator ceiling
  that per-call `licenseFilter` can only narrow; `openLicense` kept one release
  as deprecated.
- Tier/TDM logic in amb-indexer applies to kind 30142 only.

## Left to the builder

Host-denylist matching rule, TDM re-check cadence, `license_permissive`
migration vs. coexistence, reprocess scope for the hash bump, nostrlib hardening,
exact label format for ported CC licenses.
