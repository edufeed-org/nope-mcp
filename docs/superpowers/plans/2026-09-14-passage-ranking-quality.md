# Passage Ranking Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `search_passages` return passages a model can actually ground an answer on: vector-leaning ranking, one document no longer crowding out the rest, observable tool calls on both services.

**Architecture:** amb-indexer gains a per-request `alpha` (Typesense vector weight) rendered inside `vector_query` as Typesense documents, keeping the relay's rerank path at its tuned default. amb-mcp requests vector-leaning ranking, over-fetches, then applies a per-document cap and a relative score floor before returning `limit` passages. Both services log each search call on one line.

**Tech Stack:** Go 1.2x (amb-indexer, `go test ./...`), TypeScript + vitest (amb-mcp, `npm test`), Typesense 28 hybrid search.

**Spec:** Findings memo in `~/.claude/projects/-home-laoc-coding-edufeed-amb-mcp/memory/project_search_passages_quality.md` (2026-09-14 investigation). Summary: the chat "Wie kann ich das Thema Frieden in der Grundschule einführen?" routed correctly to `search_passages`, but Typesense rank fusion with alpha 0.3 (= vector weight 0.3, keyword 0.7) put a Christmas escape game first because its chunk contains the boilerplate words GRUNDSCHULE/Kinder; 3 of 10 passages came from that one document; no floor.

## Global Constraints

- Typesense semantics: `alpha` is the weight of the VECTOR rank; `rank_fusion_score = (1-alpha)/keyword_rank + alpha/vector_rank`. Default 0.3.
- The relay's own chunk-rerank (nostrlib khatru/semantic) calls the same `/search_chunks` and applies a 0.5 floor tuned to alpha 0.3. Its behaviour must not change: default alpha stays 0.3 when the request omits it.
- stdio transport uses stdout for the protocol: all amb-mcp logging goes to stderr (`console.error`).
- No new dependencies in either repo.
- Commits end with the attribution block given in the session (Co-Authored-By + Claude-Session lines).

---

## Repo A: amb-indexer (`/home/laoc/coding/edufeed/amb-indexer`)

### Task A1: Per-request `alpha`, rendered inside `vector_query`

**Files:**
- Modify: `search.go` (SearchRequest, Search body construction, formatVectorQuery, doc comment)
- Test: `search_test.go`

**Interfaces:**
- Produces: `SearchRequest.Alpha *float64` (JSON `alpha`, optional, clamped to [0,1], default `DefaultAlpha = 0.3`); `formatVectorQuery(field string, vec []float32, k int, alpha float64) string` renders `field:([...], k:N, alpha:0.7)`.

- [ ] **Step 1: Write the failing tests** in `search_test.go`

```go
func TestSearch_DefaultAlphaInsideVectorQuery(t *testing.T) {
	emb := &stubEmbedder{vec: []float32{0.1}}
	ts := &stubTS{result: TSSearchResult{}}
	qe := &QueryEngine{Embedder: emb, TS: ts, Collection: "c"}
	if _, err := qe.Search(context.Background(), SearchRequest{Q: "x", K: 5}); err != nil {
		t.Fatal(err)
	}
	if _, present := ts.lastBody["alpha"]; present {
		t.Errorf("alpha must not be a top-level param (Typesense reads it inside vector_query)")
	}
	vq, _ := ts.lastBody["vector_query"].(string)
	if !strings.Contains(vq, "alpha:0.3") {
		t.Errorf("default alpha missing from vector_query: %q", vq)
	}
}

func TestSearch_RequestAlphaClamped(t *testing.T) {
	cases := []struct{ in, want float64 }{{0.7, 0.7}, {1.5, 1}, {-1, 0}}
	for _, c := range cases {
		emb := &stubEmbedder{vec: []float32{0.1}}
		ts := &stubTS{result: TSSearchResult{}}
		qe := &QueryEngine{Embedder: emb, TS: ts, Collection: "c"}
		a := c.in
		if _, err := qe.Search(context.Background(), SearchRequest{Q: "x", K: 5, Alpha: &a}); err != nil {
			t.Fatal(err)
		}
		vq, _ := ts.lastBody["vector_query"].(string)
		want := fmt.Sprintf("alpha:%s", strconv.FormatFloat(c.want, 'g', -1, 64))
		if !strings.Contains(vq, want) {
			t.Errorf("alpha %v: vector_query %q lacks %q", c.in, vq, want)
		}
	}
}
```

Also update the existing assertion in `TestSearch_*` at `search_test.go:120-122` (`ts.lastBody["alpha"] != 0.3`) to assert the key is absent, and the `formatVectorQuery` test at line ~308 to pass an alpha and expect `k:3, alpha:0.3`.

- [ ] **Step 2: Run to verify failure**: `go test ./... -run 'TestSearch|formatVectorQuery' -v` → compile error (no `Alpha` field / wrong arity).

- [ ] **Step 3: Implement** in `search.go`

```go
// DefaultAlpha is Typesense's default hybrid weight: 0.3 of the fused score
// comes from the VECTOR rank, 0.7 from the keyword rank. The relay's rerank
// path relies on this default (its 0.5 relevance floor is tuned to it), so it
// stays the fallback when a request sends no alpha.
const DefaultAlpha = 0.3

type SearchRequest struct {
	Q      string         `json:"q"`
	K      int            `json:"k"`
	Filter map[string]any `json:"filter,omitempty"`
	// Alpha is the weight of the vector rank in Typesense rank fusion
	// (0 = keyword only, 1 = vector only). Optional; clamped to [0,1].
	Alpha *float64 `json:"alpha,omitempty"`
}

func effectiveAlpha(a *float64) float64 {
	if a == nil { return DefaultAlpha }
	switch {
	case *a < 0: return 0
	case *a > 1: return 1
	}
	return *a
}
```

In `Search`: replace the body's `"alpha": 0.3` line by nothing, and call `formatVectorQuery("embedding", qVec, k, effectiveAlpha(req.Alpha))`. In `formatVectorQuery`, after `k:N` append `, alpha:` + `strconv.FormatFloat(alpha, 'g', -1, 64)`. Rewrite the misleading doc comment bullet: "alpha is the VECTOR weight (Typesense semantics); 0.3 = keyword-dominant".

- [ ] **Step 4: Run** `go test ./...` → PASS.
- [ ] **Step 5: Commit** `feat(search): per-request alpha, rendered inside vector_query`.

### Task A2: Log every /search_chunks call with query, filter and hit count

**Files:**
- Modify: `http_server.go` (`searchHandler`)
- Test: `http_server_test.go`

- [ ] **Step 1: Failing test** — wrap the handler, capture `log` output via `log.SetOutput(&buf)` (restore with `t.Cleanup`), POST `{"q":"frieden","k":3,"filter":{"kinds":[30142]},"alpha":0.7}` against `searchHandler(qe)` with stub engine returning 2 hits; assert the buffer contains `search_chunks q="frieden" k=3 alpha=0.7 filter={"kinds":[30142]} hits=2`.
- [ ] **Step 2: Run** → FAIL (no such log line).
- [ ] **Step 3: Implement**: in `searchHandler` after a successful `qe.Search`, `filterJSON, _ := json.Marshal(req.Filter)`; `log.Printf("search_chunks q=%q k=%d alpha=%v filter=%s hits=%d %s", req.Q, k, effectiveAlpha(req.Alpha), filterJSON, len(resp.Hits), time.Since(start))` where `start := time.Now()` is taken before Search and `k` mirrors the engine's clamp (`if req.K<=0 {10}`; `>100 → 100`). Empty filter logs `filter=null`; that is fine.
- [ ] **Step 4: Run** `go test ./...` → PASS.
- [ ] **Step 5: Commit** `feat(http): log query, filter and hit count per search_chunks call`.

### Task A3: Document `alpha` in README

- [ ] Add `"alpha": 0.7, // optional, vector weight 0..1, default 0.3` to the request examples at README.md ~line 248 and ~357, plus one sentence under the `/search_chunks` description.
- [ ] Commit `docs: document the alpha request field`.

---

## Repo B: amb-mcp (`/home/laoc/coding/edufeed/amb-mcp`)

### Task B1: Vector-leaning fetch, per-document cap, relative floor

**Files:**
- Modify: `src/indexer/client.ts` (`searchChunks` body type gains `alpha?: number`)
- Modify: `src/tools/searchPassages.ts` (deps type, `runSearchPassages`)
- Create: `src/tools/passageSelection.ts`
- Test: `test/tools/passageSelection.test.ts`, `test/tools/searchPassages.test.ts`

**Interfaces:**
- Produces in `passageSelection.ts`:
  ```ts
  export const PASSAGE_ALPHA = 0.7;          // vector weight sent to the indexer
  export const OVERFETCH_FACTOR = 3;         // k = min(limit*3, 100)
  export const MAX_PASSAGES_PER_DOC = 2;     // per event_coord
  export const MIN_SCORE_RATIO = 0.1;        // drop hits < 10% of the top score
  export function selectPassages(hits: PassageHit[], limit: number): PassageHit[]
  ```
  `selectPassages` keeps input order (indexer already sorts by fused score desc), skips a hit once its `event_coord` has `MAX_PASSAGES_PER_DOC` kept, skips hits with `score < MIN_SCORE_RATIO * hits[0].score`, stops at `limit`.

- [ ] **Step 1: Failing tests** `test/tools/passageSelection.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { selectPassages, MAX_PASSAGES_PER_DOC, MIN_SCORE_RATIO } from '../../src/tools/passageSelection.js';
import type { PassageHit } from '../../src/indexer/client.js';

const hit = (coord: string, score: number, idx = 0): PassageHit =>
  ({ chunk_id: `${coord}:${idx}`, event_id: 'e', event_coord: coord, chunk_idx: idx, snippet: 's', score } as PassageHit);

describe('selectPassages', () => {
  it('caps passages per document and keeps order', () => {
    const hits = [hit('A', 0.7, 1), hit('A', 0.35, 2), hit('A', 0.3, 3), hit('B', 0.25), hit('A', 0.2, 4), hit('C', 0.15)];
    const out = selectPassages(hits, 10);
    expect(out.map((h) => h.event_coord)).toEqual(['A', 'A', 'B', 'C']);
    expect(out.filter((h) => h.event_coord === 'A')).toHaveLength(MAX_PASSAGES_PER_DOC);
  });
  it('drops hits below the relative floor', () => {
    const out = selectPassages([hit('A', 1.0), hit('B', 0.2), hit('C', 0.1), hit('D', 0.09)], 10);
    expect(out.map((h) => h.event_coord)).toEqual(['A', 'B', 'C']);
    expect(0.09).toBeLessThan(MIN_SCORE_RATIO * 1.0);
  });
  it('truncates to limit', () => {
    const out = selectPassages([hit('A', 1), hit('B', 0.9), hit('C', 0.8)], 2);
    expect(out).toHaveLength(2);
  });
  it('empty input → empty output', () => {
    expect(selectPassages([], 5)).toEqual([]);
  });
});
```

In `test/tools/searchPassages.test.ts` change the first test's expectation to
`{ q: 'klimawandel', k: 30, filter: { kinds: [30142] }, alpha: 0.7 }` and add:

```ts
it('over-fetches, then caps per document and truncates to limit', async () => {
  const coordA = `30142:${'a'.repeat(64)}:d1`, coordB = `30142:${'b'.repeat(64)}:d2`;
  const mk = (c: string, s: number, i: number) => ({ ...HIT, event_coord: c, chunk_idx: i, chunk_id: `${c}:${i}`, score: s });
  const d = deps({ searchChunks: vi.fn(async () => ({ hits: [mk(coordA, 0.7, 1), mk(coordA, 0.35, 2), mk(coordA, 0.3, 3), mk(coordB, 0.25, 0)], total: 4 })) });
  const out = await runSearchPassages(d, { question: 'q', kinds: [30142], limit: 3 }, undefined);
  expect(d.searchChunks).toHaveBeenCalledWith(RELAY, expect.objectContaining({ k: 9, alpha: 0.7 }));
  expect(out.passages.map((p) => p.event_coord)).toEqual([coordA, coordA, coordB]);
});
```

- [ ] **Step 2: Run** `npx vitest run test/tools` → FAIL (module missing; k mismatch).
- [ ] **Step 3: Implement**
  - `src/indexer/client.ts`: body type `{ q: string; k: number; filter: Record<string, unknown>; alpha?: number }`.
  - `src/tools/passageSelection.ts` per the interface above (pure function, no I/O).
  - `src/tools/searchPassages.ts`: same body type in `SearchPassagesDeps.searchChunks`; replace
    ```ts
    const k = Math.min(params.limit ?? 10, 25);
    const res = await deps.searchChunks(deps.relay, { q: params.question, k, filter: scope.chunkFilter });
    return { passages: res.hits, ... }
    ```
    with
    ```ts
    const limit = Math.min(params.limit ?? 10, 25);
    const k = Math.min(limit * OVERFETCH_FACTOR, 100);
    const res = await deps.searchChunks(deps.relay, { q: params.question, k, filter: scope.chunkFilter, alpha: PASSAGE_ALPHA });
    return { passages: selectPassages(res.hits, limit), ... }
    ```
- [ ] **Step 4: Run** `npm test` → all PASS.
- [ ] **Step 5: Commit** `feat(search_passages): vector-leaning ranking, per-document cap and score floor`.

### Task B2: Per-tool-call logging

**Files:**
- Create: `src/tools/logging.ts`
- Modify: `src/session.ts` (call `instrumentToolLogging(server)` before `registerTools`)
- Test: `test/tools/logging.test.ts`

**Interfaces:**
```ts
export interface ToolLogLine { ts: string; tool: string; ms: number; ok: boolean; session?: string; error?: string; args: Record<string, unknown> }
export function summarizeArgs(args: unknown, maxString = 120): Record<string, unknown>
export function instrumentToolLogging(server: Pick<McpServer, 'registerTool'>, sink: (line: ToolLogLine) => void = defaultSink): void
```
`defaultSink` writes `JSON.stringify(line)` via `console.error`; it is silent when `process.env.LOG_LEVEL` is `silent`, and logs only `ok:false` lines when `LOG_LEVEL` is `warn` or `error`.

- [ ] **Step 1: Failing test** `test/tools/logging.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { instrumentToolLogging, summarizeArgs, type ToolLogLine } from '../../src/tools/logging.js';

function fakeServer() {
  const registered: Record<string, (...a: any[]) => any> = {};
  return {
    registered,
    registerTool(name: string, _cfg: unknown, cb: (...a: any[]) => any) { registered[name] = cb; return {} as any; },
  };
}

describe('instrumentToolLogging', () => {
  it('logs name, duration, ok and summarized args for a successful call', async () => {
    const lines: ToolLogLine[] = [];
    const s = fakeServer();
    instrumentToolLogging(s as any, (l) => lines.push(l));
    s.registerTool('search_passages', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    await s.registered.search_passages({ question: 'x'.repeat(300), kinds: [30142] }, { sessionId: 'sess-1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'search_passages', ok: true, session: 'sess-1' });
    expect((lines[0].args.question as string).length).toBeLessThanOrEqual(121);
    expect(lines[0].args.kinds).toEqual([30142]);
  });
  it('marks isError results and thrown errors as ok:false, rethrowing', async () => {
    const lines: ToolLogLine[] = [];
    const s = fakeServer();
    instrumentToolLogging(s as any, (l) => lines.push(l));
    s.registerTool('a', {}, async () => ({ isError: true, content: [] }));
    s.registerTool('b', {}, async () => { throw new Error('boom'); });
    await s.registered.a({}, {});
    await expect(s.registered.b({}, {})).rejects.toThrow('boom');
    expect(lines.map((l) => l.ok)).toEqual([false, false]);
    expect(lines[1].error).toBe('boom');
  });
});

describe('summarizeArgs', () => {
  it('truncates long strings and abbreviates long arrays', () => {
    const out = summarizeArgs({ s: 'a'.repeat(500), arr: Array.from({ length: 50 }, (_, i) => i), n: 3 });
    expect((out.s as string).endsWith('…')).toBe(true);
    expect(out.arr).toEqual({ length: 50, head: [0, 1, 2, 3, 4] });
    expect(out.n).toBe(3);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `src/tools/logging.ts`: patch `server.registerTool` with a wrapper that replaces the callback: record `start = performance.now()`, `try { result = await cb(args, extra) }`, compute `ok = !result?.isError`, emit line, rethrow on error. `summarizeArgs`: non-object → `{ value }`; strings > max → slice + `…`; arrays longer than 5 → `{ length, head: first 5 }`; nested objects → `JSON.stringify` truncated to max. Wire `instrumentToolLogging(server)` in `buildSessionServer` right after `new McpServer(...)`.
- [ ] **Step 4: Run** `npm test` → PASS. Also run `npm run build` (tsc) to be sure the patched signature type-checks.
- [ ] **Step 5: Commit** `feat(tools): log every tool call with duration, outcome and summarized args`.

### Task B3: Guidance and docs

**Files:**
- Modify: `src/tools/searchPassages.ts` (description), `src/server-info.ts` (QUESTION intent bullet), `README.md` (search_passages section ~272-300 and env table), `CHANGELOG.md` (Unreleased).

- [ ] Description addition (after "Keep `question` topic-only."): `Ranking is hybrid keyword+vector, so phrase the question as a topical statement that names the subject and the target group ("Friedenserziehung in der Grundschule: Einstieg in das Thema Frieden mit Kindern"), not as the user's literal sentence ("Wie kann ich …?"). Results are capped at two passages per document; a passage with only a snippet and no text is either license-gated or has no fulltext yet — say so instead of guessing.`
- [ ] Same sentence, shortened, in `SERVER_INSTRUCTIONS` QUESTION bullet.
- [ ] README: document alpha 0.7, over-fetch, 2-per-document cap, 10% floor, the tool-call log line format and `LOG_LEVEL` values (`info` default, `warn`/`error` = failures only, `silent`).
- [ ] CHANGELOG Unreleased: three bullets (ranking, logging, guidance).
- [ ] Run `npm test`, commit `docs: passage ranking, query phrasing guidance, tool-call logging`.

---

## Repo C: Deployment and data checks (this session, after A and B are pushed)

- [ ] Push amb-indexer `main` → Forgejo Actions builds `git.edufeed.org/edufeed/amb-indexer:main`; wait for the run to finish (`curl -s -H "Authorization: token $(cat ~/.config/claude-forgejo/token)" https://git.edufeed.org/api/v1/repos/edufeed/amb-indexer/actions/runs?limit=1`).
- [ ] Push amb-mcp `main` to `origin` (nostr + Forgejo + GitHub); wait for `amb-mcp:main`.
- [ ] Redeploy: `cd ~/coding/homelab && ansible-playbook playbooks/deploy_amb_mcp.yml --tags amb-mcp-edufeed` and the indexer-only path of `deploy_amb_relay.yml` for the edufeed instance (check tags first; avoid restarting relay/typesense/embed if the role supports pulling just the indexer).
- [ ] Verify: replay `search_passages` with the original question; expect the top score to be `0.7` for a vector-rank-1 hit ("Friedensfähig oder kriegstüchtig?" or similar), no document more than twice, and `docker logs amb-mcp` showing the JSON tool line; `docker logs amb-relay-indexer` showing `search_chunks q=… alpha=0.7 … hits=…`.
- [ ] Fulltext check: for the coords that returned chunk 0 only (`https://friedensbildung.ekir.de/.../Sammelmappe-Friedensbausteine-web.pdf`, `https://material.rpi-virtuell.de/material/friedenserziehung-in-der-schule/`, `…-schule-2/`, `https://konfi-arbeit.de/.../2020-Friedensdekade-kooperative-Spiele.pdf`) fetch the event with `nak req -k 30142 -t d=<url> wss://amb-relay.edufeed.org` and check whether `content` (indexer-written fulltext) is empty; grep the indexer logs / dead-letter for the URL to see why.
- [ ] "Test Konfi" (kind 30142, pubkey `1c5ff3ca…`, d = the RPI_Impluse_2-2025_07_Morgen_bestimme_ich.pdf URL): deletion needs that key. Hand laoc the exact `nak event -k 5 -t a=30142:1c5ff3ca…:<d> …` command to run with the `!` prefix.
