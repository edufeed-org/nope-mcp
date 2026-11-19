/**
 * Search intent: which everyday words of a question describe the wanted
 * material (level, grade, resource type) rather than its topic.
 *
 * The same rules and the same behaviour as nope-relay (search_intent.go,
 * search_rules.go). The rules are one JSON document, shared as a kind-30078
 * Nostr event (see rulesStore.ts); `rules.de.json` is the built-in copy.
 * nope-mcp parses the question itself and passes the result to the relays as
 * `prefer.*` NIP-50 hints, and uses it to merge their answers by level fit.
 */
import rulesJson from './rules.de.json' with { type: 'json' };
import { isFieldFilterToken } from '../relay/filters.js';

interface WordConcepts {
  words: string[];
  concepts: string[];
}

export interface SearchRules {
  stopwords: Set<string>;
  commands: Set<string>;
  levelWords: Map<string, string[]>;
  /** first word -> second word -> concepts ("sekundarstufe" "i") */
  levelPhrases: Map<string, Map<string, string[]>>;
  gradeWords: Set<string>;
  gradeImplies: { from: number; to: number; concepts: string[] }[];
  typeWords: Map<string, string[]>;
  contextWords: Map<string, string[]>;
}

const KEYS = ['version', 'stopwords', 'commands', 'levels', 'levelPhrases', 'grades', 'types', 'context'];

function words(list: unknown, what: string): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`search rules: ${what} is not a list`);
  for (const w of list) {
    if (typeof w !== 'string' || w.trim() === '' || /[ "]/.test(w)) throw new Error(`search rules: invalid ${what} ${JSON.stringify(w)}`);
  }
  return list.map((w: string) => w.toLowerCase());
}

/** Concept ids end up in search strings: none may be empty or carry a space or quote. */
function concepts(list: unknown): string[] {
  if (!Array.isArray(list)) throw new Error('search rules: concepts is not a list');
  for (const id of list) {
    if (typeof id !== 'string' || id === '' || /[ "]/.test(id)) throw new Error(`search rules: invalid concept id ${JSON.stringify(id)}`);
  }
  return list as string[];
}

function wordMap(entries: unknown): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of (entries as WordConcepts[] | undefined) ?? []) {
    const ids = concepts(e.concepts);
    for (const w of words(e.words, 'word')) m.set(w, ids);
  }
  return m;
}

/**
 * Validate a rules document. Throws on anything it does not fully understand
 * (unknown key, other version, empty word, an id that could inject search
 * tokens): a half-read rules event must never change search.
 */
export function parseRules(json: unknown): SearchRules {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('search rules: not an object');
  const doc = json as Record<string, any>;
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) throw new Error(`search rules: unknown key ${k}`);
  if (doc.version !== 1) throw new Error(`search rules: unsupported version ${doc.version}`);
  const stopwords = words(doc.stopwords, 'stopword');
  if (stopwords.length === 0) throw new Error('search rules: no stopwords');
  const levelPhrases = new Map<string, Map<string, string[]>>();
  for (const p of doc.levelPhrases ?? []) {
    const ids = concepts(p.concepts);
    for (const first of words(p.first, 'word')) {
      const second = levelPhrases.get(first) ?? new Map<string, string[]>();
      for (const s of words(p.second, 'word')) second.set(s, ids);
      levelPhrases.set(first, second);
    }
  }
  const gradeImplies = (doc.grades?.implies ?? []).map((r: any) => {
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 1 || r.to < r.from) throw new Error('search rules: grade range');
    return { from: r.from, to: r.to, concepts: concepts(r.concepts) };
  });
  return {
    stopwords: new Set(stopwords),
    commands: new Set(words(doc.commands, 'command')),
    levelWords: wordMap(doc.levels),
    levelPhrases,
    gradeWords: new Set(words(doc.grades?.words, 'word')),
    gradeImplies,
    typeWords: wordMap(doc.types),
    contextWords: wordMap(doc.context),
  };
}

export const defaultRules: SearchRules = parseRules(rulesJson);

let active: SearchRules = defaultRules;
/** The rules in use: the built-in ones until a rules event was loaded (rulesStore.ts). */
export const activeRules = (): SearchRules => active;
export const setActiveRules = (rules: SearchRules): void => {
  active = rules;
};

export interface Intent {
  /** The search text without the words that were interpreted or stripped. */
  text: string;
  /** educationalLevel concept ids. */
  levels: string[];
  grade?: string;
  /** learningResourceType concept ids, in order of appearance. */
  types: string[];
}

/** Like the relay's searchTokens: split on spaces, keep quoted segments verbatim. */
function rawTokens(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i++;
    if (i >= s.length) break;
    const start = i;
    // a token that starts with a quote ends at the closing quote, as in the relay
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end >= 0) {
        i = end + 1;
        tokens.push(s.slice(start, i));
        continue;
      }
    }
    while (i < s.length && s[i] !== ' ') {
      if (s[i] === '"') {
        const end = s.indexOf('"', i + 1);
        if (end >= 0) {
          i = end + 1;
          continue;
        }
      }
      i++;
    }
    tokens.push(s.slice(start, i));
  }
  return tokens;
}

const trimWord = (t: string) => t.replace(/[,.;:!?]+$/, '');
const freeText = (t: string) => !t.startsWith('"') && !isFieldFilterToken(t);
const addAll = (to: string[], ids: string[]) => {
  for (const id of ids) if (!to.includes(id)) to.push(id);
};

/**
 * Take level, grade, type, school-context and command words plus stopwords
 * out of the free text. Phrases and field tokens pass through verbatim. A
 * query that would have no free text left, or that already carries `prefer.*`
 * hints, is returned unchanged with an empty intent. With `words` false only
 * stopwords are stripped (a search that cannot return learning resources).
 */
export function parseIntent(query: string, rules: SearchRules, words = true): Intent {
  const unchanged: Intent = { text: query, levels: [], types: [] };
  const tokens = rawTokens(query);
  if (tokens.some((t) => t.startsWith('prefer.') && isFieldFilterToken(t))) return unchanged;
  const norm = (i: number) => (i < tokens.length && freeText(tokens[i]) ? trimWord(tokens[i]).toLowerCase() : '');

  const intent: Intent = { text: '', levels: [], types: [] };
  const context: string[] = [];
  const kept: string[] = [];
  let hasFree = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!freeText(tok)) {
      kept.push(tok);
      continue;
    }
    const w = norm(i);
    const next = norm(i + 1);
    if (!words) {
      // stopwords only: level and type say nothing about the kinds searched
      if (w !== '' && !rules.stopwords.has(w)) {
        kept.push(trimWord(tok));
        hasFree = true;
      }
      continue;
    }
    if (rules.gradeWords.has(w) && /^\d+$/.test(next) && +next >= 1 && +next <= 13) {
      intent.grade = String(+next);
      for (const r of rules.gradeImplies) if (+next >= r.from && +next <= r.to) addAll(intent.levels, r.concepts);
      i++;
      continue;
    }
    const phrase = rules.levelPhrases.get(w)?.get(next);
    if (phrase?.length) {
      addAll(intent.levels, phrase);
      i++;
      continue;
    }
    if (rules.levelWords.has(w)) addAll(intent.levels, rules.levelWords.get(w)!);
    else if (rules.typeWords.has(w)) addAll(intent.types, rules.typeWords.get(w)!);
    else if (rules.contextWords.has(w)) addAll(context, rules.contextWords.get(w)!);
    else if ((rules.commands.has(w) && i === 0) || rules.stopwords.has(w) || w === '') continue;
    else {
      kept.push(trimWord(tok));
      hasFree = true;
    }
  }
  if (!hasFree) return unchanged;
  if (intent.levels.length === 0) addAll(intent.levels, context); // school context only without a named level
  intent.text = kept.join(' ');
  return intent;
}

/** The relay accepts at most this many `prefer.type` hints (each is a query of its own). */
const MAX_TYPES = 4;

/** The cleaned text plus the intent as `prefer.*` NIP-50 hints (nope-relay understands them). */
export function toSearchString(intent: Intent): string {
  return [
    intent.text,
    ...intent.levels.map((id) => `prefer.level:${id}`),
    ...(intent.grade ? [`prefer.grade:${intent.grade}`] : []),
    ...intent.types.slice(0, MAX_TYPES).map((id) => `prefer.type:${id}`),
  ].join(' ');
}

/**
 * The free text of the question as asked, as nope-relay's `semantic:"…"`
 * directive: the text the relay embeds for the vector side, which reads a
 * whole question better than the cleaned keyword text. Empty when the free
 * text did not change or the caller set the directive.
 */
export function semanticDirective(query: string, intent: Intent): string {
  const free = (s: string) => rawTokens(s).filter(freeText).join(' ');
  const asked = free(query).replaceAll('"', '');
  return asked === '' || asked === free(intent.text) || query.includes('semantic:') ? '' : ` semantic:"${asked}"`;
}

/** A trailing slash and http/https do not make a different concept. */
const conceptKey = (id: string) => id.replace(/\/+$/, '').replace(/^https?:\/\//, '');

/**
 * How well an event's own tags fit the wanted level: 3 the named grade, 2 a
 * wanted level, 1 no level statement, 0 another level. 0 for every event when
 * the intent names no level, so it never reorders such a search.
 */
export function levelFit(tags: string[][], intent: Intent): number {
  if (intent.levels.length === 0 && !intent.grade) return 0;
  const wanted = new Set(intent.levels.map(conceptKey));
  let stated = false;
  let match = false;
  for (const [name, value] of tags) {
    if (value === undefined) continue;
    if (name === 'ext:de.sodix:klassenstufe:id' && intent.grade && value === intent.grade) return 3;
    if (name === 'educationalLevel:id') {
      stated = true;
      match ||= wanted.has(conceptKey(value));
    }
  }
  return match ? 2 : stated ? 0 : 1;
}
