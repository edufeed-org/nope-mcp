import { tokenizeSearch, isFieldFilterToken } from '../relay/filters.js';

/**
 * Cross-relay ranking: a cheap lexical title/description match next to the
 * relay's snippet score, so results from several relays merge into one list
 * (each relay ranks only its own hits) and `limit` applies after the merge.
 */

const STOPWORDS = new Set([
  // de (folded)
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'und', 'oder',
  'mit', 'fuer', 'von', 'auf', 'aus', 'bei', 'nach', 'zum', 'zur', 'ueber', 'wie', 'was', 'ist',
  'sind', 'sich', 'auch', 'nicht', 'im',
  // en
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'how', 'what', 'into',
]);

const FOLD: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Folded lowercase tokens ≥ 3 chars (no stopwords), plus 2-char all-caps acronyms (KI, AI, VR, IT). */
export function tokenize(text: unknown): string[] {
  // Defensive: fields come from untrusted event JSON (a kind-0 `name` may be a number).
  if (typeof text !== 'string') return [];
  return text
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((raw) => raw.length >= 3 || (raw.length === 2 && raw === raw.toUpperCase() && raw !== raw.toLowerCase()))
    .map((raw) => raw.toLowerCase().replace(/[äöüß]/g, (c) => FOLD[c]))
    .filter((t) => !STOPWORDS.has(t));
}

export interface LexicalFields {
  title?: string;
  description?: string;
  keywords?: string[];
}

/** 1 for an exact token match, 0.5 when both tokens are ≥ 7 chars and share the first 6 (no stemmer). */
function matchIn(token: string, field: Set<string>): number {
  if (field.has(token)) return 1;
  if (token.length < 7) return 0;
  const stem = token.slice(0, 6);
  for (const f of field) if (f.length >= 7 && f.startsWith(stem)) return 0.5;
  return 0;
}

/**
 * Matched unique query tokens / query tokens; a title hit counts 1, a
 * description/keyword hit 0.5, a 6-char prefix match half of that. Callers
 * scoring many items pass the query's `tokenize` set, tokenized once.
 */
export function lexicalScore(query: string | Set<string>, fields: LexicalFields): number {
  const q = typeof query === 'string' ? new Set(tokenize(query)) : query;
  if (q.size === 0) return 0;
  const title = new Set(tokenize(fields.title ?? ''));
  const rest = new Set(tokenize([fields.description ?? '', ...(fields.keywords ?? [])].join(' ')));
  let sum = 0;
  for (const t of q) sum += Math.max(matchIn(t, title), matchIn(t, rest) * 0.5);
  return Math.min(sum / q.size, 1);
}

interface Rankable {
  title?: string;
  name?: string;
  description?: string;
  summary?: string;
  excerpt?: string;
  topics?: string[];
  about?: string[];
  score?: number;
  relay?: string;
  createdAt?: number;
  nostr?: { createdAt: number };
}

/**
 * Merges the relays' answers into one list and slices to `limit`: by `fit`
 * (how well an item fits the level the question named, see search/intent.ts)
 * when given, then by evidence of the topic (`lexical`: query words in title,
 * description and keywords; a matched passage counts like a description
 * match; zero-evidence hits last, never dropped),
 * then by the item's position within its own relay, so relays interleave
 * round-robin; arrival order breaks the rest.
 *
 * A relay's snippet `score` does not order the merged list. It is 0.7/rank
 * inside that relay, so adding it across relays let rank 1 of a small relay
 * beat every hit of a large one.
 *
 * `browse` (the relays got no NIP-50 search at all, so each answered
 * newest-first) sorts by creation time, newest first, instead.
 * Mutates the items (sets `lexical`); callers pass freshly built results.
 */
export function rankResults<T extends Rankable>(
  items: T[],
  query: string | undefined,
  limit: number,
  browse = false,
  fit?: (item: T) => number
): Array<T & { lexical?: number }> {
  if (browse) {
    const created = (i: T) => i.createdAt ?? i.nostr?.createdAt ?? 0;
    return [...items].sort((a, b) => created(b) - created(a)).slice(0, limit);
  }
  const seen = new Map<string | undefined, number>();
  const pos = new Map<T, number>();
  for (const i of items) {
    const n = seen.get(i.relay) ?? 0;
    pos.set(i, n);
    seen.set(i.relay, n + 1);
  }
  const byRelayPos = (a: T, b: T) => pos.get(a)! - pos.get(b)!;
  // NIP-50 field filters (type:academic, doi:…) are not words of the topic.
  const tokens = new Set(tokenize(tokenizeSearch(query ?? '').filter((t) => !isFieldFilterToken(t)).join(' ')));
  const byFit = (a: T, b: T) => (fit ? fit(b) - fit(a) : 0);
  if (tokens.size === 0) return [...items].sort((a, b) => byFit(a, b) || byRelayPos(a, b)).slice(0, limit);
  // A passage the relay matched is evidence too: such a hit ranks with the
  // description matches instead of sinking below them for lack of a title hit.
  const evidence = (i: T & { lexical: number }) => Math.max(i.lexical, i.score != null ? 0.5 : 0);
  return items
    .map((i) =>
      Object.assign(i, {
        lexical: lexicalScore(tokens, {
          title: i.title ?? i.name,
          description: i.description ?? i.summary ?? i.excerpt,
          keywords: [...(i.topics ?? []), ...(i.about ?? [])],
        }),
      })
    )
    .sort((a, b) => byFit(a, b) || evidence(b) - evidence(a) || byRelayPos(a, b))
    .slice(0, limit);
}
