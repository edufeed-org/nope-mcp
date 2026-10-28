# License Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learning resources (kind 30142) under any CC/PD license become fully searchable with passages; all other learning resources become findable by metadata only. Their fulltext is used solely for matching, only when no TDM reservation exists, and is never stored readably or returned.

**Architecture:** amb-indexer enforces the policy. It widens its license allowlist, runs a TDM reservation check before using a restricted resource's body, and indexes restricted text into a non-stored Typesense field. It returns neither `text` nor `snippet` for those resources and closes today's snippet leak at deploy time. amb-mcp classifies licenses into groups. It exposes `license {id,label}` and `accessLevel` on every learning-resource result, and adds a `licenseFilter` parameter capped by an operator ceiling `LICENSE_FILTER_MAX`.

**Tech Stack:** amb-indexer is Go (single `package main`, Typesense 28, BoltDB), tested with `GOWORK=off go test -race ./...` and `./e2e_test.sh`. amb-mcp is TypeScript, tested with vitest (`npm test`). amb-relay is Go.

**Spec:** `docs/superpowers/specs/2026-10-28-license-tiers-design.md` (in amb-mcp)

**Repos:** Part A runs in `/home/laoc/coding/edufeed/amb-indexer`, Part B in `/home/laoc/coding/edufeed/amb-mcp`, Task A6 also touches `amb-relay` and `../homelab`. Each repo gets its own feature branch `feat/license-tiers` (use worktrees). Part A and Part B are independent until release (Task B6).

## Global Constraints

- Tier 1 (`full`): CC0, PDM, CC BY, BY-SA, BY-NC, BY-NC-SA, BY-ND, BY-NC-ND in any version, port, `deed.*`/`legalcode*` form, http or https.
- Tier 2 (`metadata-only`): everything else, including a missing `license:id` and non-CC URIs such as `https://w3id.org/kim/license/attribution`.
- Tier/TDM logic applies to **kind 30142 only**. Other kinds (30023, 30818, 31922/31923, 30143/30144, 30040/30041) keep today's behaviour in both repos.
- No tier-2 fulltext character may be stored readably (Typesense stored fields, Bolt, relay `content`, logs) or reach a client (`text`, `snippet`, highlights, kind 21142, `/ui`, error messages).
- robots.txt: evaluate only the `amb-indexer` group, falling back to `*`. Unreachable or 5xx counts as reserved, 4xx as not reserved. Blocks aimed only at other named crawlers and `X-Robots-Tag: noai` do **not** count.
- TDMRep: `/.well-known/tdmrep.json`, the `tdm-reservation` header, and `<meta name="tdm-reservation" content="1">`. A value of `1` means reserved. A missing tdmrep.json means not reserved. `tdm-policy` is not parsed.
- Host denylist env `TDM_DENY_HOSTS` (CSV), empty by default.
- New amb-indexer default `LICENSE_ALLOWLIST=CC0,CC-BY,CC-BY-SA,CC-BY-NC,CC-BY-NC-SA,CC-BY-ND,CC-BY-NC-ND,publicdomain`.
- amb-mcp `licenseFilter: "open" | "cc-any" | "any"`, default `any`. Env `LICENSE_FILTER_MAX` (same values, default `any`) is a ceiling: wider requests are clamped. Legacy `OPEN_LICENSES_ONLY=true` maps to `open` with a deprecation log line. `get_resource` is never filtered.
- User-Agent product token: `amb-indexer`. Full string: `amb-indexer/1.0 (+https://git.edufeed.org/edufeed/amb-indexer)`, used by every indexer HTTP request including headless.

## Review Focus

1. **Deploy-time leak:** a restricted 30142 chunk indexed before this release (has `license_permissive=false`, a 200-rune `snippet`, no `text_policy`) must return an empty snippet from `search_chunks` immediately, before any reprocessing. Test in A4.
2. **Redirects:** a source URL that redirects to another origin. The TDM check must apply to the final origin as well as the original one. Test in A3.
3. **Missing license tag on 30142:** it must be tier 2 in both repos (not "unknown → full") and must appear in `licenseFilter:"any"` results with `license: null`. Tests in A1 and B1.
4. **Ported or legacy CC URIs** (`…/by-sa/3.0/de/deed.de`, `http://…/legalcode.de`, `…/by-nc/3.0/`): these must classify as tier 1 with a correct label. Test in B1.
5. **Clamped request:** with `LICENSE_FILTER_MAX=open`, a caller passing `licenseFilter:"any"` gets only open results plus `licenseFilterClamped: true`. Test in B2.

---

## Part A — amb-indexer

### Task A1: Widen the tier-1 allowlist

**Files:**
- Modify: `config.go:130-131` (default `LICENSE_ALLOWLIST`), `.env.example:31`, README (env table)
- Test: `license_test.go`, `config_test.go`

**Interfaces:**
- Produces: tier 1 for kind 30142 means `LicensePermissive(cfg.LicenseAllowlist, readLicenseTag(&ev))`. That signature is unchanged and later tasks call it as is.

- [ ] **Step 1: Write failing tests.** In `config_test.go`, `TestDefaultLicenseAllowlistCoversAllCC` asserts that, with the default config, `LicensePermissive` is true for `https://creativecommons.org/licenses/by-nc-sa/4.0/`, `…/by-nc-nd/4.0/`, `…/by-nd/4.0/`, `…/by-nc/3.0/`, `http://creativecommons.org/licenses/by-sa/4.0/legalcode.de`, `…/publicdomain/mark/1.0/` and `…/publicdomain/zero/1.0/`. It is false for `""`, `https://w3id.org/kim/license/attribution` and `Urheberrecht`.
- [ ] **Step 2:** Run `GOWORK=off go test -run 'TestDefaultLicenseAllowlist' ./...`. Expected: FAIL on the NC/ND cases.
- [ ] **Step 3:** Change the default to the Global Constraints value and update `.env.example` and the README.
- [ ] **Step 4:** Run `GOWORK=off go test -race ./...`. Expected: PASS. Fix any existing test that pinned the old default.
- [ ] **Step 5:** Commit `feat: tier-1 license allowlist covers all CC variants`.

### Task A2: TDM checker (denylist, robots.txt, tdmrep.json)

**Files:**
- Create: `tdm.go`, `tdm_test.go`
- Modify: `store.go:14-28` (buckets `tdm_origin`, `tdm`), `config.go` (`TDMDenyHosts []string` from `TDM_DENY_HOSTS`, `TDMCacheTTL` default 24h), `fetch.go:98` (extract `const UserAgent`), `go.mod` (`github.com/temoto/robotstxt`)

**Interfaces:**
- Produces:
  - `type TDMResult struct { Reserved bool \`json:"reserved"\`; Source string \`json:"source"\`; CheckedAt int64 \`json:"checked_at"\` }`, where Source is one of `denylist|robots|tdmrep-file|tdmrep-header|tdmrep-meta|none`.
  - `type TDMChecker struct { HTTP *http.Client; SSRF *SSRFGuard; DenyHosts []string; Cache *TDMOriginCache; TTL time.Duration; Now func() time.Time }`
  - `func (c *TDMChecker) CheckOrigin(ctx context.Context, rawURL string) (TDMResult, error)` checks the denylist, then robots, then tdmrep.json, and stops at the first reservation.
  - `type TDMStore struct{ DB *bbolt.DB }` with `Put(eventID string, r TDMResult) error` and `Get(eventID string) (TDMResult, bool, error)` on bucket `tdm`.
  - `type TDMOriginCache struct{ DB *bbolt.DB }`, which caches robots/tdmrep results per origin in bucket `tdm_origin`, keyed `robots:<origin>` / `tdmrep:<origin>`.
  - `const UserAgent = "amb-indexer/1.0 (+https://git.edufeed.org/edufeed/amb-indexer)"` and `const RobotsAgent = "amb-indexer"`.

- [ ] **Step 1: Write failing tests** in `tdm_test.go`, using httptest servers:
  - `TestTDMDenylist`: with `DenyHosts=["example.org"]`, `https://example.org/x` gives `{Reserved:true, Source:"denylist"}` and makes no HTTP request.
  - `TestTDMRobotsAgentGroup`: robots `User-agent: amb-indexer\nDisallow: /private` makes `/private/a` reserved (`robots`) and leaves `/public` not reserved.
  - `TestTDMRobotsStarFallback`: `User-agent: *\nDisallow: /` makes the URL reserved.
  - `TestTDMRobotsOtherBotsIgnored`: `User-agent: GPTBot\nDisallow: /` combined with `User-agent: *\nAllow: /` gives not reserved.
  - `TestTDMRobots5xxReserved`: robots returning 503 gives reserved (`robots`). `TestTDMRobots404Allowed`: 404 gives not reserved.
  - `TestTDMRepFile`: `/.well-known/tdmrep.json` = `[{"location":"/docs/*","tdm-reservation":1}]` makes `/docs/a.pdf` reserved (`tdmrep-file`) and leaves `/other` not reserved. A 404 for the file gives not reserved.
  - `TestTDMOriginCached`: a second `CheckOrigin` on the same origin within the TTL makes no new HTTP request.
- [ ] **Step 2:** Run `GOWORK=off go test -run TestTDM ./...`. Expected: FAIL (undefined).
- [ ] **Step 3:** Implement `tdm.go`.
  - Denylist matching: the host equals an entry or ends with `"."+entry`.
  - robots is evaluated through `robotstxt.FromStatusAndBytes`, whose RFC 9309 status semantics apply (5xx disallows all, 4xx allows all), via `FindGroup(RobotsAgent).Test(path)`. Network errors count as reserved.
  - tdmrep `location` patterns: `*` matches any run of characters and everything else is literal. The first matching entry wins.
  - All requests send `UserAgent`, pass the SSRF check, and are capped at 512 KiB.
- [ ] **Step 4:** Run `GOWORK=off go test -race ./...`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: TDM reservation checker (denylist, robots.txt, tdmrep.json)`.

### Task A3: Reservation signals from the fetched resource

**Files:**
- Modify: `fetch.go` (`ExtractedDoc` gains `TDMReserved bool`, `TDMSource string`, `FinalURL string`; `Fetch` reads the header and records `resp.Request.URL` as FinalURL), `fetch_html.go` (meta tag), `fetch_headless.go` (send `UserAgent`; meta tag on the rendered HTML)
- Test: `fetch_test.go`, `fetch_headless_test.go`

**Interfaces:**
- Consumes: `UserAgent` (A2).
- Produces: `func tdmFromResponse(h http.Header) bool` and `func tdmFromHTMLMeta(html []byte) bool`. `ExtractedDoc.TDMReserved/TDMSource/FinalURL` are filled by both tier 1 and tier 2.

- [ ] **Step 1: Write failing tests.**
  - `TestFetchTDMHeader`: the response header `tdm-reservation: 1` produces `doc.TDMReserved==true` and `TDMSource=="tdmrep-header"`.
  - `TestFetchTDMMeta`: HTML with `<meta name="tdm-reservation" content="1">` produces `TDMSource=="tdmrep-meta"`. With `content="0"` the doc is not reserved.
  - `TestFetchFinalURLAfterRedirect`: a 302 to a second httptest server leaves `doc.FinalURL` pointing at the second server.
  - `TestHeadlessSendsUserAgent`: the browserless stub receives a User-Agent containing `amb-indexer`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Header parsing is case-insensitive with a trimmed value of `"1"`. Meta matching is case-insensitive on name and content, using the HTML tokenizer already used in `fetch_html.go`.
- [ ] **Step 4:** Run `GOWORK=off go test -race ./...`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: read TDM reservation from response header and meta tag`.

### Task A4: Text policy in schema, build and search (closes the snippet leak)

**Files:**
- Modify: `schema.go:22-47` (fields), `schema.go:115-175` (`BuildChunkDocs`), `tsclient.go` (add `EnsureFields`), `main.go:121` (call `EnsureFields` after `EnsureCollection`), `search.go:169` (`query_by`), `search.go:407-430` (`translateHit`, `SearchHit`), `ambcache.go:16` (add `Publisher`)
- Test: `schema_test.go`, `search_test.go`, `tsclient_test.go`, `ambcache_test.go`

**Interfaces:**
- Produces:
  - `type TextPolicy string` with `const (TextPolicyFull TextPolicy = "full"; TextPolicyMatchOnly TextPolicy = "match_only")`.
  - `BuildChunkDocs(event nostr.Event, sourceURL, contentType string, policy TextPolicy, licensePermissive bool, chunks []Chunk, embeddings [][]float32, amb AMBMetadata) ([]TSChunkDoc, error)`. Content-direct callers pass `TextPolicyFull` when permissive and keep today's behaviour otherwise (see Step 3).
  - `TSChunkDoc` gains `MatchText string \`json:"match_text,omitempty"\`` and `TextPolicy string \`json:"text_policy,omitempty"\``.
  - Schema fields `{"name":"match_text","type":"string","optional":true,"store":false}` and `{"name":"text_policy","type":"string","facet":true,"optional":true}`.
  - `func (t *TSClient) EnsureFields(ctx context.Context, schema map[string]any) error` PATCHes `/collections/{name}` with the schema fields missing from the live collection.
  - `SearchHit` gains `AccessLevel string \`json:"access_level"\`` (`full` | `metadata-only`).
  - `AMBCacheMetadata` gains `Publisher []string \`json:"publisher,omitempty"\``.

- [ ] **Step 1: Spike — verify Typesense 28 `store:false` semantics** against the e2e Typesense container (`typesense/typesense:28.0`). Create a throwaway collection with a `store:false` string field, upsert a doc, query it via `query_by` on that field, and confirm three things: the doc matches, the field is absent from `document`, and `highlights` contain no text from it. Record the result in the commit message of Step 5. **If it does not match, or if highlights leak, stop and report back.** The design depends on it.
- [ ] **Step 2: Write failing tests.**
  - `TestBuildChunkDocsMatchOnly`: `policy=match_only` gives `Text==""`, `Snippet==""`, `MatchText==chunk.Text`, `TextPolicy=="match_only"`.
  - `TestBuildChunkDocsFull`: `Text` and `Snippet` are set and `MatchText==""`.
  - `TestTranslateHitMatchOnly`: a doc with `text_policy:"match_only"` gives empty `Text` and `Snippet` and `AccessLevel=="metadata-only"`.
  - `TestTranslateHitLegacyRestricted30142`: a doc with **no** `text_policy`, `kind:30142`, `license_permissive:false` and `snippet:"abc"` gives `Snippet==""` and `AccessLevel=="metadata-only"`. This is the deploy-time leak.
  - `TestTranslateHitLegacyRestrictedArticle`: the same doc with `kind:30023` keeps `Snippet=="abc"` (other kinds unchanged).
  - `TestSearchQueryByIncludesMatchText`: the Typesense body's `query_by` contains `match_text` and `query_by_weights` has one weight per field, with match_text weighted like text (4).
  - `TestEnsureFieldsPatchesMissing`: a stub TS server returns a collection without `match_text`/`text_policy`, and the test asserts a PATCH whose body contains exactly those two fields.
  - `TestAMBCachePublisher`: `Publisher` is read from the `publisher:name` tags.
- [ ] **Step 3: Implement.**
  - In `translateHit`, the hit counts as restricted when `text_policy=="match_only"`, or when `text_policy` is absent and `kind==30142 && !license_permissive`. A restricted hit gets `Text=""`, `Snippet=""` and `AccessLevel="metadata-only"`. Otherwise `Text` follows `license_permissive` as today and `AccessLevel="full"`.
  - Content-direct (`worker.go:292+`): pass `TextPolicyFull` if permissive. Otherwise pass a third internal value that keeps today's shape (snippet stored, no text). Simplest: have `BuildChunkDocs` treat `policy==""` as the legacy behaviour.
- [ ] **Step 4:** Run `GOWORK=off go test -race ./...`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: match-only text policy; never return restricted 30142 snippets`.

### Task A5: Worker wiring (tier decision, TDM gate, reprocess)

**Files:**
- Modify: `worker.go:60-270` (fetch path), `main.go` (construct `TDMChecker`, `TDMStore`, wire them into `Worker`)
- Test: `worker_test.go`

**Interfaces:**
- Consumes: `LicensePermissive` (A1), `TDMChecker.CheckOrigin`, `TDMStore` (A2), `ExtractedDoc.TDMReserved/FinalURL` (A3), `TextPolicy`, `BuildChunkDocs` (A4).
- Produces: relay setcontent status `tdm_reserved`, and `const textPolicyVersion = "2"`, mixed into the 30142 idempotency hash as `sha256(url + "\x00" + model + "\x00" + textPolicyVersion)`. Only kind 30142 is affected, so its events reprocess once after deploy.

- [ ] **Step 1: Write failing tests** with the existing worker fakes:
  - `TestWorkerNCNDIsFull`: a 30142 under `by-nc-sa/4.0` gets chunks with `TextPolicy=="full"` and setcontent with text and status `fetched`.
  - `TestWorkerRestrictedNoReservation`: a 30142 with no license tag gets chunks with `match_only` and setcontent with `""` and `license_denied`, and `TDMStore` holds `{Reserved:false, Source:"none"}`.
  - `TestWorkerRestrictedRobotsReserved`: the robots disallow means **no Fetcher call**, `FilterDelete` is called with `coord_hash:=…`, setcontent gets `""` and `tdm_reserved`, `TDMStore` holds `{Reserved:true, Source:"robots"}`, and the hash is recorded.
  - `TestWorkerRestrictedHeaderReserved`: the fetch returns `TDMReserved` from the header, so the body is discarded, no upsert happens and the status is `tdm_reserved`.
  - `TestWorkerRestrictedRedirectOriginChecked`: when the doc's `FinalURL` is on another origin, `CheckOrigin` also runs for that origin, and a reservation there means `tdm_reserved`.
  - `TestWorkerRestrictedSkipsHeadlessWhenReserved`: when the pre-check reserves, the headless stub is never called.
  - `TestWorkerPolicyVersionReprocesses`: a 30142 event whose stored hash is the old `sha256(url+"\x00"+model)` is reprocessed, not skipped.
  - `TestWorkerNostrSourceNoTDMCheck`: a restricted 30142 with a `nostr:` source makes no `CheckOrigin` call and gets `match_only` chunks.
  - `TestWorkerContentDirectUnchanged`: an unlicensed 30023 keeps today's chunk shape and hash.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement** in `Process`, kind 30142 only, after the license gate (step 3, `worker.go:117`):
  - Tier 1: `tier1 := LicensePermissive(...)`.
  - If `!tier1` and the source is not `nostr:`, run `CheckOrigin(sourceURL)` before the fetch tiers. If reserved, take the reserved path.
  - After a successful fetch, if `doc.TDMReserved`, or `doc.FinalURL` has a different origin and `CheckOrigin(doc.FinalURL)` reserves, take the reserved path.
  - The reserved path does: `FilterDelete coord_hash`, `SetContent(..., "", now, "tdm_reserved", sourceURL)`, `TDMStore.Put`, `Hashes.Put`, `advanceCursor`.
  - Otherwise policy is `TextPolicyFull` if tier1 and `TextPolicyMatchOnly` if not. `TDMStore.Put` runs for every restricted 30142.
  - Other kinds keep the existing code path and hash.
- [ ] **Step 4:** Run `GOWORK=off go test -race ./...`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: TDM-gated indexing for restricted learning resources`.

### Task A6: E2E, relay status constant, deployment config

**Files:**
- Modify: `e2e_test.sh` (event 4 block, around L445), amb-indexer README (policy section, `TDM_DENY_HOSTS`)
- Modify: `/home/laoc/coding/edufeed/amb-relay/content_store.go:10-16` (add `ContentStatusTDMReserved = "tdm_reserved" // TDM reservation (§44b UrhG); no text, no chunks`)
- Modify: `/home/laoc/coding/homelab/roles/amb-relay/templates/env.indexer.j2` (`LICENSE_ALLOWLIST` to the new default; `TDM_DENY_HOSTS=`)

- [ ] **Step 1: Extend `e2e_test.sh`.** The script serves fixtures from a local server. Add:
  - (a) A 30142 under `CC-BY-NC-SA-4.0`. Assert that `search_chunks` returns a hit with non-empty `text` and `access_level:"full"`.
  - (b) Event 4 (proprietary). Assert that its chunks exist, every hit has an empty `snippet` and no `text`, `access_level:"metadata-only"`, and that a keyword unique to its body still finds it.
  - (c) A proprietary 30142 whose fixture host's robots.txt disallows `amb-indexer`. Assert status `tdm_reserved` and zero chunks for its coord.
  - (d) A Typesense export (`/collections/amb_chunks_30142/documents/export`) contains no `match_text` values.
- [ ] **Step 2:** Run `./e2e_test.sh`. Expected: PASS for all cases.
- [ ] **Step 3:** In amb-relay, add the constant, then run `GOWORK=off go test ./...`. Expected: PASS.
- [ ] **Step 4:** Commit in each repo: amb-indexer `test: e2e for license tiers and TDM`, amb-relay `feat: tdm_reserved content status`, homelab `feat(amb-indexer): license tiers allowlist, TDM_DENY_HOSTS`.

---

## Part B — amb-mcp

### Task B1: License classification

**Files:**
- Create: `src/license/classify.ts`, `test/license/classify.test.ts`
- Modify: `src/license/open.ts` (keep `isOpenLicense`, `OPEN_LICENSE_URIS`, `normalizeLicenseUri`; remove `parseOpenLicensesOnly` in B2)

**Interfaces:**
- Produces:
  - `type LicenseGroup = 'open' | 'cc' | 'other' | 'none'`
  - `type AccessLevel = 'full' | 'metadata-only'`
  - `type LicenseFilter = 'open' | 'cc-any' | 'any'`
  - `interface LicenseInfo { id: string; label: string }`
  - `classifyLicense(uri: string | undefined): { group: LicenseGroup; license: LicenseInfo | null }`. For `none` the license is `null`. For `other` it is `{ id: uri, label: 'unknown' }`.
  - `accessLevelFor(group: LicenseGroup): AccessLevel`
  - `matchesLicenseFilter(group: LicenseGroup, filter: LicenseFilter): boolean`
  - `eventLicense(event: NostrEvent): { group: LicenseGroup; license: LicenseInfo | null; accessLevel: AccessLevel }`, which reads `license:id`.
  - `CC_LICENSE_URIS: readonly string[]`: every fixture id that classifies `open` or `cc` (a superset of `OPEN_LICENSE_URIS`).

- [ ] **Step 1: Write failing tests.**
  - Labels: `by-nc-sa/4.0/` gives `{group:'cc', label:'CC BY-NC-SA 4.0'}`. `by-sa/3.0/de/deed.de` gives `{group:'open', label:'CC BY-SA 3.0 DE'}`. `http://…/by-sa/4.0/legalcode.de` gives `'CC BY-SA 4.0'`. `publicdomain/zero/1.0/` gives `'CC0 1.0'`. `publicdomain/mark/1.0/` gives `'PDM 1.0'`. `by-nc/3.0/` gives `cc`. `by-nd/4.0/` gives `cc`. `https://w3id.org/kim/license/attribution` gives `{group:'other', license:{id, label:'unknown'}}`. `undefined` and `''` give `{group:'none', license:null}`.
  - Every `licenseIds[].id` in `test/fixtures/license-ids.json` classifies as `open` or `cc` exactly when it is in `CC_LICENSE_URIS`.
  - `matchesLicenseFilter`: `open` admits only `open`; `cc-any` admits `open` and `cc`; `any` admits all four groups.
  - `accessLevelFor`: `open` and `cc` give `full`; `other` and `none` give `metadata-only`.
- [ ] **Step 2:** Run `npx vitest run test/license`. Expected: FAIL.
- [ ] **Step 3:** Implement. Reuse `normalizeLicenseUri`. The CC regex captures the variant in `(by|by-sa|by-nc|by-nc-sa|by-nd|by-nc-nd)`, the version, and an optional 2–3 letter port that is uppercased in the label.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: classify learning-resource licenses into tiers`.

### Task B2: Config ceiling and search_resources

**Files:**
- Modify: `src/index.ts:38,66,73`, `src/stdio.ts:28,49,56`, `src/session.ts:33-51`, `src/tools/index.ts:45-74`, `src/relay/filters.ts:30-42,166-171`, `src/tools/search.ts`, `src/license/open.ts` (remove `parseOpenLicensesOnly`), `README.md:82`, `.env.example:90`
- Test: `test/tools/searchResources.test.ts`, `test/relay/openLicenseFilter.test.ts`, `test/license/classify.test.ts`

**Interfaces:**
- Consumes: B1.
- Produces:
  - `parseLicenseFilterMax(env: { LICENSE_FILTER_MAX?: string; OPEN_LICENSES_ONLY?: string }, warn?: (m: string) => void): LicenseFilter`
  - `clampLicenseFilter(requested: LicenseFilter | undefined, max: LicenseFilter): { effective: LicenseFilter; clamped: boolean }`, ordered `open < cc-any < any`.
  - The option `licenseFilterMax: LicenseFilter` replaces `openLicensesOnly` everywhere (session, registerTools, each register fn, `buildServerInstructions`).
  - `SearchParams.licenseFilter?: LicenseFilter` replaces `openLicensesOnly`.
  - `ResourceSearchResult` gains `licenseFilter: LicenseFilter` and `licenseFilterClamped?: true`.
  - `SimplifiedAMBResource.license` becomes `LicenseInfo | null` (always present), plus `accessLevel: AccessLevel`. `toSimplifiedResource` fills both from the event's `license:id` via `classifyLicense`.

- [ ] **Step 1: Write failing tests.**
  - `parseLicenseFilterMax`: unset gives `any`. `LICENSE_FILTER_MAX=cc-any` gives `cc-any`. `OPEN_LICENSES_ONLY=true` with LICENSE_FILTER_MAX unset gives `open` and calls warn once. An invalid value throws at startup.
  - `clampLicenseFilter('any','open')` gives `{effective:'open', clamped:true}`. `clampLicenseFilter(undefined,'cc-any')` gives `{effective:'cc-any', clamped:false}`.
  - `buildFilter` without free text: `open` pushes exactly the `OPEN_LICENSE_URIS` tokens, `cc-any` pushes the `CC_LICENSE_URIS` tokens, and `any` pushes no `license.id:` token and no over-fetch. With free text and `cc-any`, `filter.limit` is over-fetched and there are no license tokens.
  - `runResourceSearch` with stub events under `by-nc-sa/4.0`, `by/4.0` and no license:
    - `any` returns all 3. The NC-SA one has `license:{id:…,label:'CC BY-NC-SA 4.0'}` and `accessLevel:'full'`. The unlicensed one has `license:null` and `accessLevel:'metadata-only'`.
    - `open` returns 1.
    - With the ceiling `open` and requested `any`, it returns 1 with `licenseFilterClamped:true`.
  - The Gendering MINT regression: a `creatorName` search over the 10 BY-NC-SA events with the default filter returns 10.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `licenseFilter: z.enum(['open','cc-any','any']).optional()` to the input schema.
  - The post-filter runs when the effective filter is not `any`, using `matchesLicenseFilter(eventLicense(e).group, effective)`.
  - Replace the zero-match hint sentence at `search.ts:77-80` with: when the effective filter is not `any`, `" Only resources under <open: 'CC0, Public Domain, CC BY, CC BY-SA' | cc-any: 'Creative Commons or Public Domain'> licenses were searched (licenseFilter: <value>); resources under other licenses or without a license are left out."`
  - Description: replace the "Only openly licensed…" sentence with the two-tier text: every learning resource is returned by default, each carries `license` and `accessLevel`, `licenseFilter` narrows (`open` = CC0/PD/BY/BY-SA, `cc-any` = all CC and PD, `any` = also unlicensed and all-rights-reserved), and creator/publisher must be named when citing. When the ceiling is below `any`, append "This server limits results to licenseFilter '<max>'."
  - Update `README.md` (replace the `OPEN_LICENSES_ONLY` row with `LICENSE_FILTER_MAX`, mentioning the legacy mapping) and `.env.example`.
- [ ] **Step 4:** Run `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: licenseFilter with operator ceiling; search_resources returns all tiers`.

### Task B3: search_content and get_resource

**Files:**
- Modify: `src/tools/searchContent.ts`, `src/content/types.ts:33-44`, `src/content/transform.ts` (resource branch), `src/tools/get.ts:41-54,119-155`, `src/server-info.ts:4-21,54-62`
- Test: `test/tools/searchContent.test.ts`, `test/tools/getResource.test.ts`, `test/server-info.test.ts`

**Interfaces:**
- Consumes: B1, plus `clampLicenseFilter` and `licenseFilterMax` (B2).
- Produces:
  - `ResourceResult` gains `license: LicenseInfo | null` and `accessLevel: AccessLevel`.
  - The `runContentSearch` params take `licenseFilter: LicenseFilter` (effective), and its result gains `licenseFilter` and `licenseFilterClamped?`.
  - `get_resource` for kind 30142 returns `{ resource, accessLevel, openLicense }`. `resource.license` and `resource.accessLevel` come from B2. `openLicense` is kept and its description says "deprecated; use accessLevel".
  - `buildServerInstructions({ licenseFilterMax })`.

- [ ] **Step 1: Write failing tests.**
  - search_content with a BY-NC-ND resource, an unlicensed resource that has a 21142 snippet event and `page`/`heading`, and an article:
    - `any` returns all 3. The unlicensed resource has `accessLevel:'metadata-only'` and **no** `snippet`, `page` or `heading`. The BY-NC-ND resource keeps its snippet and has `license.label:'CC BY-NC-ND 4.0'`.
    - `open` returns only the article (other kinds are never filtered).
  - get_resource on an unlicensed 30142 returns `accessLevel:'metadata-only'`, `openLicense:false` and `resource.license:null`.
  - server-info: with `licenseFilterMax:'any'` the instructions no longer contain "limited to open licenses" and do mention `accessLevel` and `licenseFilter`. With `'open'` they state the ceiling.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Strip the snippet for metadata-only results after `attachSnippets`.
  - Over-fetch (`CONTENT_LICENSE_OVERFETCH_FACTOR`) only when the effective filter is not `any`.
  - Rewrite the license sentence in the search_content description, `openLicenseNote` and `openLicenseSentence` / `snippetOnlyReason` in `server-info.ts` to the two-tier wording. Snippets and passages exist only for `accessLevel:"full"` resources. Metadata-only resources may be presented by title, description, license and link, never quoted beyond their metadata. Always name the license and the creator/publisher when presenting a learning resource.
- [ ] **Step 4:** Run `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: license and accessLevel on search_content and get_resource`.

### Task B4: search_passages

**Files:**
- Modify: `src/tools/passageSelection.ts:13-14,43-55`, `src/tools/searchPassages.ts:205-232,240-275`
- Test: `test/tools/passageSelection.test.ts`, `test/tools/searchPassages.test.ts`

**Interfaces:**
- Consumes: B1, B2. The indexer hit gains `access_level` (A4), and `amb` carries `license`, `creator`, `publisher`, `name`.
- Produces:
  - `type ReleasedPassage = PassageHit & { accessLevel: 'full'; license?: LicenseInfo | null; creator?: string[]; publisher?: string[] }`. `license`, `creator` and `publisher` are set for 30142 hits only.
  - `interface MetadataOnlyMatch { naddr: string; title?: string; license: LicenseInfo | null; accessLevel: 'metadata-only'; creator?: string[]; publisher?: string[]; sourcePage?: string }`
  - `partitionPassageHits(hits: PassageHit[], filter: LicenseFilter): { released: PassageHit[]; metadataOnly: PassageHit[] }`
  - The tool result becomes `{ passages: ReleasedPassage[], metadataOnlyMatches: MetadataOnlyMatch[], licenseFilter, licenseFilterClamped?, scope }`.

- [ ] **Step 1: Write failing tests.**
  - `partitionPassageHits`:
    - A 30142 hit with `text` and `amb.license` BY-NC-SA goes to released.
    - A 30142 hit with `access_level:'metadata-only'` goes to metadataOnly even if it carries a non-empty snippet (defence in depth).
    - A 30142 hit without text and without access_level goes to metadataOnly.
    - A 30023 hit without text stays released (other kinds unchanged).
    - With `open`, the BY-NC-SA hit is dropped from both lists.
    - With `cc-any`, metadataOnly is empty.
  - `runSearchPassages`: the metadata-only entries are deduplicated per `event_coord`, capped at `limit`, and never contain `text`, `snippet`, `heading` or `page`. Released 30142 passages carry `license.label` and `creator` from `amb`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Replace `isOpenPassageHit` with `partitionPassageHits`.
  - `LICENSE_OVERFETCH_FACTOR` applies whenever the effective filter is not `any`, and always when metadata-only hits are partitioned out. Keep it simple: always over-fetch with factor 2.
  - `selectPassages` runs on released only.
  - Build `naddr` from `event_coord` with `nip19.naddrEncode` and the relay hint `deps.relay`, the way existing code builds naddrs. Take `title` from `amb.name`.
  - Rewrite the description (`searchPassages.ts:257-262`): passages come from Creative Commons/Public Domain learning resources and from articles and other kinds. Other matching learning resources appear in `metadataOnlyMatches` without text, because their license does not permit quoting. Cite license and creator/publisher with every passage.
- [ ] **Step 4:** Run `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: search_passages releases CC passages, lists metadata-only matches`.

### Task B5: Live check against dev

- [ ] **Step 1:** Run the MCP locally (`npm run dev` per README, or the stdio build) against `wss://dev.amb-relay.edufeed.org` with the A-part indexer deployed to dev. Call `search_resources(creatorName="Projekt Gendering MINT didaktisch-digital", relays=["amb-relay"])`. Expected: `total: 10`, each with `license.label:"CC BY-NC-SA 4.0"` and `accessLevel:"full"`.
- [ ] **Step 2:** Call `search_passages(question="gendersensible Lehre MINT")`. Expected: passages from the Gendering MINT resources once the indexer has reprocessed them, each with license and creator.
- [ ] **Step 3:** Call `search_content(query="…")` on a query that hits an unlicensed resource. Expected: `accessLevel:"metadata-only"` and no `snippet`.

### Task B6: Release (coordinated)

- [ ] **Step 1:** Merge `feat/license-tiers` in amb-indexer, amb-relay and homelab, then deploy the indexer and relay. The idempotency bump reprocesses every 30142, so watch the indexer metrics until the backlog drains.
- [ ] **Step 2:** In amb-mcp, bump to `0.7.0` (package.json, lockfile with npm 10, `SERVER_VERSION`), merge, tag `v0.7.0` and push per the repo's Nostr-canonical release flow. Update the homelab `nope-mcp` compose template: drop `OPEN_LICENSES_ONLY` and leave `LICENSE_FILTER_MAX` unset (meaning `any`).
- [ ] **Step 3:** Repeat Task B5 against production.

---

## Deviations from the spec (decided while planning)

- The spec's `POST /admin/tdm/recheck` is replaced by the existing `POST /admin/refetch/<event-id>`. It re-runs `Process`, which re-runs the TDM check. A host-wide recheck is left out (YAGNI) until needed.
- The spec's optional indexer request filter `text_policy` is not added. amb-mcp filters client-side, as it does today.
- `license_permissive` keeps being written alongside `text_policy`. There is no migration.
