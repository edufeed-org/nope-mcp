import { z } from 'zod';
import { normalizeURL } from 'nostr-tools/utils';
import { SpellError } from '../spells/types.js';

export interface PassageHit {
  chunk_id: string;
  event_id: string;
  event_coord: string;
  chunk_idx: number;
  text?: string;
  snippet: string;
  heading?: string;
  section_path?: string[];
  page?: number;
  source_url?: string;
  score: number;
  amb?: Record<string, unknown>;
}

/**
 * Deliberately shallow: enforce only what the tool's contract depends on
 * (an array of hits, each carrying its parent coord and score) and pass
 * every other field through untouched, so benign indexer additions never
 * break the client. This exists to turn contract drift — an error payload
 * with status 200, a renamed field after version skew — into a clean
 * indexer_error instead of undefined passages downstream.
 */
const responseSchema = z.object({
  hits: z.array(z.object({ event_coord: z.string(), score: z.number() }).passthrough()),
  total: z.number().optional(),
});

function normKey(url: string): string {
  try {
    return normalizeURL(url);
  } catch {
    return url;
  }
}

function parsePairs(spec: string, envName: string, what: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i <= 0) {
      throw new Error(`${envName} entry is not relay=${what}: ${pair}`);
    }
    map.set(normKey(pair.slice(0, i)), pair.slice(i + 1));
  }
  return map;
}

/** Maps AMB relays to their amb-indexer /search_chunks endpoints. */
export class IndexerClient {
  private readonly endpoints: Map<string, string>;
  private readonly perRelayTokens: Map<string, string>;

  constructor(
    endpoints: Map<string, string>,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    perRelayTokens: Map<string, string> = new Map()
  ) {
    this.endpoints = new Map(Array.from(endpoints).map(([k, v]) => [normKey(k), v]));
    this.perRelayTokens = new Map(Array.from(perRelayTokens).map(([k, v]) => [normKey(k), v]));
  }

  /**
   * INDEXER_ENDPOINTS="wss://relay=https://indexer,..." plus INDEXER_API_TOKEN
   * (shared default) and/or INDEXER_API_TOKENS="wss://relay=token,..."
   * (per-relay overrides — each deployed indexer instance has its own token).
   * Every mapped endpoint must end up with a token; a partially tokened
   * config is a boot-time error, not a runtime 401.
   */
  static fromEnv(spec?: string, token?: string, tokensSpec?: string): IndexerClient | null {
    if (!spec || (!token && !tokensSpec)) return null;
    const endpoints = parsePairs(spec, 'INDEXER_ENDPOINTS', 'endpoint');
    for (const [k, v] of endpoints) endpoints.set(k, v.replace(/\/+$/, ''));
    const perRelay = tokensSpec ? parsePairs(tokensSpec, 'INDEXER_API_TOKENS', 'token') : new Map<string, string>();
    for (const relay of endpoints.keys()) {
      if (!token && !perRelay.get(relay)) {
        throw new Error(`no indexer API token for ${relay}: set INDEXER_API_TOKEN or add it to INDEXER_API_TOKENS`);
      }
    }
    return new IndexerClient(endpoints, token ?? '', fetch, perRelay);
  }

  forRelay(relayUrl: string): string | null {
    return this.endpoints.get(normKey(relayUrl)) ?? null;
  }

  private tokenFor(relayUrl: string): string {
    return this.perRelayTokens.get(normKey(relayUrl)) || this.token;
  }

  async searchChunks(
    relayUrl: string,
    body: { q: string; k: number; filter: Record<string, unknown>; alpha?: number }
  ): Promise<{ hits: PassageHit[]; total: number }> {
    const base = this.forRelay(relayUrl);
    if (!base) {
      throw new SpellError('no_indexer', `no passage index configured for relay ${relayUrl}`);
    }
    const bearer = this.tokenFor(relayUrl);
    if (!bearer) {
      throw new SpellError('indexer_error', `no API token configured for indexer at ${base}`);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/search_chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SpellError('indexer_error', `indexer at ${base} unreachable: ${msg}`);
    }
    if (!res.ok) {
      throw new SpellError('indexer_error', `indexer at ${base} answered ${res.status}`);
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SpellError('indexer_error', `indexer at ${base} returned invalid JSON: ${msg}`);
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SpellError(
        'indexer_error',
        `indexer at ${base} returned an unexpected response shape: ${issue.path.join('.') || '(root)'}: ${issue.message}`
      );
    }
    return {
      hits: parsed.data.hits as unknown as PassageHit[],
      total: parsed.data.total ?? parsed.data.hits.length,
    };
  }
}
