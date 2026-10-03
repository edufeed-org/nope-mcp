# nope-mcp: rename + agent-ready public endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename the service from `amb-mcp` to **`nope-mcp`** (with `amb-mcp` kept as an
alternative label) and make its public endpoint easy for other LLMs, agents and services to
find and use: a short root URL (`https://mcp.edufeed.org`), tool annotations, open-licensed
results only, and a server.json for the official MCP Registry.

**Decisions (laoc, 2026-10-02):**

- Search results are **open-licensed only** for now (CC0, PDM/Public Domain, CC BY, CC BY-SA,
  same allowlist the indexer uses for fulltext). NC/ND, "Urheberrecht" and unlicensed
  resources are not returned.
- New primary URL: `https://mcp.edufeed.org` (MCP served at `/` **and** `/mcp`). The existing
  `https://mcp.amb.edufeed.org/mcp` and `https://mcp.oersi.edufeed.org/mcp` keep working
  unchanged; both hosts also accept `/`.
- Rename everywhere: code, package, image, deployment, docs, repos (Forgejo, GitHub mirror,
  nostr/ngit). `amb-mcp` stays as an alias in docs and as an accepted auth audience.

**Non-goals (this plan):** Connectors-directory / ChatGPT submissions, Claude plugin,
`/developers` page, privacy policy, REST/OpenAPI, server-rendered resource pages. They follow
once this is deployed.

## Compatibility contract (must not break)

| Thing | Stays working |
|---|---|
| `https://mcp.amb.edufeed.org/mcp`, `https://mcp.oersi.edufeed.org/mcp` | yes, incl. `?relays=` |
| claude.ai connector (OAuth via Keycloak client `claude-ai`) | yes — PRM still served |
| edufeed-app `/api/enrich` (client-credentials, `aud=amb-mcp`) | yes — audience list accepts `amb-mcp` and `nope-mcp` |
| nope-chatbot `AMB_MCP_URL` | yes — old URL stays valid; switched to new URL in homelab |
| env vars `AMB_RELAYS`, `AMB_EXTRA_RELAYS`, … in the server | unchanged (they name the AMB *relays*, not the service) |
| edufeed-app env `AMB_MCP_*` | read as fallback for new `NOPE_MCP_*` |
| Keycloak client ids/audience mapper `amb-mcp` | untouched (renaming breaks issued configs; audience alias covers the new name) |

---

## Part A — nope-mcp repo (branch `pr/nope-mcp`)

### Task 1: Rename identity

**Files:** `package.json`, `package-lock.json`/`bun.lock` (name field only), `src/server-info.ts`,
`src/http.ts`, `src/index.ts`, `src/stdio.ts`, `src/transport/http.ts` (default `serverName`,
realm string), `docker-compose.yml`, `.env.example`, `README.md`, `CHANGELOG.md`,
`spells/profile.json` (check what the reference is), tests asserting names.

- [ ] Test first: `test/transport/http.test.ts` — `/healthz` returns `name: 'nope-mcp'`.
- [ ] `SERVER_NAME = 'nope-mcp'`, package `name: "nope-mcp"`, description mentions
      "formerly amb-mcp".
- [ ] Log lines "AMB Relay MCP Server" → "nope-mcp"; WWW-Authenticate realm `nope-mcp`.
- [ ] README title `# nope-mcp (formerly amb-mcp)`, all install snippets use
      `https://mcp.edufeed.org`, a note that `mcp.amb.edufeed.org/mcp` remains valid.
- [ ] CHANGELOG `Unreleased`: rename + everything below.
- [ ] Do NOT rewrite historical files under `docs/superpowers/` — they are history.
- [ ] `npm test` green; commit `feat!: rename to nope-mcp (formerly amb-mcp)`.

### Task 2: Serve MCP at `/` and `/mcp`

**Files:** `src/transport/http.ts`, `test/transport/http.test.ts`

- [ ] Tests first: `initialize` POST to `/` opens a session; the same session id works for
      `GET`/`DELETE` on `/` and on `/mcp` (one shared session map); `/mcp` behaviour
      unchanged; `?relays=` honoured on `/`.
- [ ] Register the POST/GET/DELETE handlers on `['/', '/mcp']` (Express accepts an array path).
- [ ] A plain browser `GET /` (no `Mcp-Session-Id`, `Accept` without `text/event-stream`)
      returns a small JSON info document instead of the 404 session error:
      `{ name, version, mcp: "<origin>/", docs: "<README URL>", transport: "streamable-http" }`.
      Test it.
- [ ] Commit.

### Task 3: Host-aware OAuth metadata (multi-host, multi-path)

RFC 9728 requires the PRM `resource` to match the URL the client connected to. With three
hosts × two paths a single `OAUTH_RESOURCE_URL` is wrong for most of them.

**Files:** `src/transport/http.ts`, `src/transport/prm.ts`, `src/transport/auth.ts`, `src/http.ts`,
`test/transport/prm.test.ts`, `test/transport/auth.test.ts`

- [ ] Tests first:
  - `GET /.well-known/oauth-protected-resource` on host `mcp.edufeed.org` →
    `resource: "https://mcp.edufeed.org/"`.
  - `GET /.well-known/oauth-protected-resource/mcp` (path-suffixed form, currently 404) →
    `resource: "https://<host>/mcp"`.
  - The 401 challenge's `resource_metadata` points at the PRM matching the request path.
  - Host not in `HTTP_ALLOWED_HOSTS` (when set) falls back to `OAUTH_RESOURCE_URL`.
  - JWT verifier accepts `aud` = `amb-mcp` **or** `nope-mcp`.
- [ ] Build the PRM per request from `req.protocol` (trust proxy → `X-Forwarded-Proto`) and the
      Host header; set `app.set('trust proxy', true)` behind Traefik.
- [ ] `OAUTH_AUDIENCE` accepts a comma list; default `nope-mcp,amb-mcp`.
- [ ] Commit.

> Verification note for Part C: after deploy, add `https://mcp.edufeed.org` as a fresh custom
> connector in claude.ai. If claude.ai still forces the OAuth/DCR flow and fails because the
> PRM is advertised, fall back to "lazy auth" (serve the PRM only on the 401 path) — decide
> with laoc, don't guess.

### Task 4: Tool annotations

Every tool gets `title` and `annotations` so directories and clients (Claude, ChatGPT) treat
reads as safe and don't prompt per call.

**Files:** all 16 `src/tools/*.ts` files with `registerTool`, new `test/tools/annotations.test.ts`

- [ ] Test first: build a session server with the full profile (read+extract+write), list
      tools, assert every tool has a non-empty `title` and `annotations.readOnlyHint` defined.
- [ ] Read tools (search_*, get_resource, browse_*, skos_get/search, relay_stats, list_relays,
      relay_list_get, resolve_*, list_*_authors, search_calendar_events):
      `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`.
- [ ] `extract_metadata` (fetches arbitrary URLs): `readOnlyHint: true, openWorldHint: true`.
- [ ] Session-local mutators (`add_relay`, `remove_relay`, skos builder state, signer_*):
      `readOnlyHint: false, destructiveHint: false, openWorldHint: false`.
- [ ] Publishers (`publish_event`, `create_and_publish_*`, `sign_event`, `skos_delete_vocabulary`
      if it publishes a deletion): `readOnlyHint: false, openWorldHint: true`;
      `destructiveHint: true` only for deletions.
- [ ] Commit.

### Task 5: Open-license-only results

The relay ORs repeated values of the same field filter
(`nostrlib/eventstore/typesense30142/query.go` groups by base field and joins with `||`), but
matches exactly — and stored URIs vary (`…/by-sa/4.0/`, `…/by-sa/4.0/legalcode.de`, `http:` vs
`https:`, ported `/3.0/de/`).

**Files:** new `src/license/open.ts`, `src/relay/filters.ts`, `src/tools/search.ts`,
`src/tools/searchContent.ts`, `src/tools/searchPassages.ts`, tests under `test/license/`,
`test/relay/`, `test/tools/`

- [ ] Inventory first: collect the distinct `license:id` values actually stored on
      `amb-relay`, `oersi`, `sodix` (Typesense facet on `license.id` via the relay host, or
      `nak req -k 30142` sampling) and save the list as a test fixture.
- [ ] `isOpenLicense(uri)`: normalise (https, strip `legalcode*`, `deed.*`, trailing slash,
      lowercase) then match `creativecommons.org/publicdomain/(zero|mark)/…` and
      `creativecommons.org/licenses/(by|by-sa)/<ver>[/<jurisdiction>]`. Tests from the fixture
      (each fixture URI classified; NC/ND/Urheberrecht/empty → false).
- [ ] `OPEN_LICENSE_URIS`: the stored variants from the fixture that classify open — appended
      as repeated `license.id:<uri>` NIP-50 filters to kind-30142 searches so the relay ranks
      only open resources (keeps `limit` meaningful).
- [ ] Safety net: post-filter every 30142 result through `isOpenLicense` (covers variants not
      in the list).
- [ ] Scope: applies to learning resources (30142) in `search_resources`, `search_content`,
      `search_passages`. Other kinds (articles 30023, wiki 30818, publications) carry no
      license tag today → they are **included as-is** (laoc, 2026-10-02).
      Mixed-kind `search_content`: if field filters force the relay into resource-only mode
      (`amb-relay/content_registry.go` `searchHasFieldFilters`), run the 30142 leg with the
      license filter and the other kinds without, then merge by relay rank.
- [ ] `get_resource` by naddr is not filtered (explicit lookup), but returns
      `openLicense: boolean`.
- [ ] Config: `OPEN_LICENSES_ONLY` env, default `true` (single switch for later).
- [ ] Tool descriptions + server instructions: state that results are open-licensed only.
- [ ] Commit.

### Task 6: Instructions + links for outside clients

**Files:** `src/server-info.ts`, `src/utils/transform.ts` (link base)

- [ ] Server instructions: open with one English paragraph (what nope-mcp is, corpus size
      order of magnitude, open licenses only, two main flows); keep the German routing examples.
- [ ] Tests for instructions content stay green / updated.
- [ ] Commit.

### Task 7: MCP Registry manifest

**Files:** new `server.json`, README section "Registry"

- [ ] `server.json` (schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`):
      `name: "org.edufeed/nope-mcp"`, title, description (English, mentions OER, AMB,
      open licenses), `version` = package version,
      `remotes: [{ type: "streamable-http", url: "https://mcp.edufeed.org/mcp" }]`,
      `repository` = GitHub mirror URL.
- [ ] Test: `server.json` version equals `package.json` version.
- [ ] Commit. (Publishing = Part D.)

### Task 8: Release

- [ ] Bump to `0.4.0`, CHANGELOG section, `npm test` + `npm run build` green.
- [ ] Open the PR via ngit after the repo rename (Part D) so it lands in `nope-mcp`.

---

## Part B — homelab (separate branch, laoc deploys)

- [ ] Rename role `amb-mcp` → `nope-mcp` (vars `amb_mcp_*` → `nope_mcp_*`), playbook
      `deploy_nope_mcp.yml`; keep `deploy_amb_mcp.yml` as a one-line `import_playbook` shim.
- [ ] Image `git.edufeed.org/edufeed/nope-mcp` (CI of the renamed repo pushes it; keep the old
      image tag until the first new build exists).
- [ ] Traefik router of the default instance: `Host(mcp.edufeed.org) || Host(mcp.amb.edufeed.org)`;
      oersi instance unchanged. `HTTP_ALLOWED_HOSTS` gets `mcp.edufeed.org`.
- [ ] Container/dir names: `/opt/nope-mcp`, `/opt/nope-mcp-oersi` — migrate without losing
      `.env`; old containers stopped by the play.
- [ ] Rate limit: raise for the shared Anthropic/OpenAI egress (key on IP + session where
      Traefik allows; at minimum average 10/s, burst 60). Check crowdsec rule note
      (`roles/crowdsec/defaults/main.yml:29`) still applies to the new host.
- [ ] `EDUFEED_APP_BASE_URL=https://edufeed.org` on prod instances (links currently point at dev).
- [ ] `inventory/group_vars/all/main.yml` service list: add `mcp.edufeed.org`.
- [ ] `nope-chatbot` env + `deploy_edufeed_app.yml`: switch to `NOPE_MCP_URL=https://mcp.edufeed.org/mcp`
      (after Part C is deployed; old var keeps working meanwhile).
- [ ] **laoc:** DNS A record `mcp.edufeed.org → 89.58.9.7` (currently NXDOMAIN).

## Part C — edufeed-app (branch `pr/nope-mcp-rename`)

- [ ] `src/lib/server/ambMcpClient.js` → `nopeMcpClient.js`, `ambMcpToken.js` → `nopeMcpToken.js`,
      `getAmbMcpToken` → `getNopeMcpToken`; tests renamed/updated.
- [ ] Env: read `NOPE_MCP_URL`/`NOPE_MCP_TOKEN_URL`/`NOPE_MCP_CLIENT_ID`/`NOPE_MCP_CLIENT_SECRET`/
      `NOPE_MCP_SCOPE`, falling back to the `AMB_MCP_*` names. Test the fallback.
- [ ] `.env.example`, `CLAUDE.md` (Server API Endpoints) updated; comments mentioning amb-mcp
      say nope-mcp.
- [ ] Later (Phase 2, own PR): `static/llms.txt`, `/.well-known/mcp-registry-auth`, developers page.

## Part D — repos, registry, local config (needs laoc for signed/maintainer acts)

- [ ] Forgejo: rename `edufeed/amb-mcp` → `edufeed/nope-mcp` via API (old URL redirects).
- [ ] GitHub mirror `edufeed-org/amb-mcp` → `edufeed-org/nope-mcp` (redirects).
- [ ] nostr: **laoc** publishes a new ngit repo announcement `nope-mcp` (same maintainers/
      relays) and updates the old `amb-mcp` announcement description to point at it.
- [ ] Update remotes in the local clone; move the directory `~/coding/edufeed/amb-mcp` →
      `nope-mcp` (+ `.worktrees`) only when no session has worktrees open.
- [ ] Local Claude config: `~/.claude.json` MCP entries `amb-mcp` → `nope-mcp`, `amb-dev` →
      `nope-dev` (and `~/.config/amb-mcp-dev` path); add `mcp.edufeed.org` to the trusted
      domains in `~/.claude/settings.json`.
- [ ] **laoc:** rename the claude.ai connector "amb mcp" → "nope-mcp" and point it at
      `https://mcp.edufeed.org`.
- [ ] MCP Registry: generate Ed25519 key, serve `v=MCPv1; k=ed25519; p=<pub>` at
      `https://edufeed.org/.well-known/mcp-registry-auth` (edufeed-app static), then
      `mcp-publisher login http --domain edufeed.org` + `mcp-publisher publish`. Key stored
      like the other agent secrets (`~/.config/…`, 0600), never printed.
- [ ] Update auto-memory entries naming amb-mcp.

## Verification

- `npm test` (nope-mcp), `pnpm test` targeted + `pnpm check` (edufeed-app).
- Live after deploy: anonymous `initialize` + `tools/list` on all of
  `https://mcp.edufeed.org/`, `https://mcp.edufeed.org/mcp`, `https://mcp.amb.edufeed.org/mcp`,
  `https://mcp.oersi.edufeed.org/mcp`; every tool annotated; a `search_content` call returns
  no non-open 30142 results; `/api/enrich` on dev still extracts; claude.ai connector works.
