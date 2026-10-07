/**
 * Bible references per the Loccum guidelines — the edufeed house style
 * (laoc, 2026-10-07). Abbreviations from Deutsche Bibelgesellschaft /
 * Katholisches Bibelwerk (Hg.), "Ökumenisches Verzeichnis der biblischen
 * Eigennamen nach den Loccumer Richtlinien", Stuttgart ²1981 (appendix);
 * citation rules as in the Uni Passau KTF handout §8.2:
 *
 *  - abbreviation without dot, numbered books "1 Kor", "2 Tim";
 *  - "Gen 1,1" (no space after the comma), "Gen 1-3", "Gen 1,1-17",
 *    "Gen 3,17-4,12" (hyphen, no spaces), "Gen 1,1.3.5.7";
 *  - passages joined by "; ", the book named once:
 *    "Gen 1,1.3; 3,17-21; Ex 15,3".
 *
 * Mirrors `LOCCUM_BIBLE_BOOKS` in edufeed-app
 * (src/lib/helpers/educational/bibleReference.js) — keep the two tables in
 * sync. Dependency-free on purpose: it rewrites book names and tidies dashes
 * and spacing, it does not validate chapters or verses.
 */

/** [Loccum abbreviation, accepted other spellings] per book, in biblical order. */
const BOOK_TABLE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Gen', ['Genesis', '1 Mo', '1. Mose']],
  ['Ex', ['Exodus', '2 Mo', '2. Mose', 'Exod']],
  ['Lev', ['Levitikus', '3 Mo', '3. Mose', 'Leviticus']],
  ['Num', ['Numeri', '4 Mo', '4. Mose', 'Numbers']],
  ['Dtn', ['Deuteronomium', '5 Mo', '5. Mose', 'Deut', 'Deuteronomy']],
  ['Jos', ['Josua', 'Josh', 'Joshua']],
  ['Ri', ['Richter', 'Judg', 'Judges']],
  ['Rut', ['Ruth']],
  ['1 Sam', ['1. Samuel', '1Sam']],
  ['2 Sam', ['2. Samuel', '2Sam']],
  ['1 Kön', ['1. Könige', '1Kgs', '1 Kings']],
  ['2 Kön', ['2. Könige', '2Kgs', '2 Kings']],
  ['1 Chr', ['1. Chronik', '1Chr', '1 Chronicles']],
  ['2 Chr', ['2. Chronik', '2Chr', '2 Chronicles']],
  ['Esra', ['Esr', 'Ezra']],
  ['Neh', ['Nehemia', 'Nehemiah']],
  ['Est', ['Ester', 'Esth', 'Esther']],
  ['Ijob', ['Hi', 'Hiob', 'Job']],
  ['Ps', ['Psalmen', 'Psalm', 'Psalms']],
  ['Spr', ['Sprüche', 'Sprichwörter', 'Prov', 'Proverbs']],
  ['Koh', ['Kohelet', 'Pred', 'Prediger', 'Eccl', 'Ecclesiastes']],
  ['Hld', ['Hoheslied', 'Hohelied', 'Song']],
  ['Jes', ['Jesaja', 'Isa', 'Isaiah']],
  ['Jer', ['Jeremia', 'Jeremiah']],
  ['Klgl', ['Klagelieder', 'Lam', 'Lamentations']],
  ['Ez', ['Ezechiel', 'Hes', 'Hesekiel', 'Ezek', 'Ezekiel']],
  ['Dan', ['Daniel']],
  ['Hos', ['Hosea']],
  ['Joël', ['Joel']],
  ['Am', ['Amos']],
  ['Obd', ['Obadja', 'Obad', 'Obadiah']],
  ['Jona', ['Jonah']],
  ['Mi', ['Micha', 'Mic', 'Micah']],
  ['Nah', ['Nahum']],
  ['Hab', ['Habakuk', 'Habakkuk']],
  ['Zef', ['Zefanja', 'Zeph', 'Zephanja', 'Zephaniah']],
  ['Hag', ['Haggai']],
  ['Sach', ['Sacharja', 'Zech', 'Zechariah']],
  ['Mal', ['Maleachi', 'Malachi']],
  ['Mt', ['Matthäus', 'Matthäusevangelium', 'Matt', 'Matthew']],
  ['Mk', ['Markus', 'Markusevangelium', 'Mark']],
  ['Lk', ['Lukas', 'Lukasevangelium', 'Luke']],
  ['Joh', ['Johannes', 'Johannesevangelium', 'John']],
  ['Apg', ['Apostelgeschichte', 'Acts']],
  ['Röm', ['Römer', 'Römerbrief', 'Rom', 'Romans']],
  ['1 Kor', ['1. Korinther', '1Cor', '1 Corinthians']],
  ['2 Kor', ['2. Korinther', '2Cor', '2 Corinthians']],
  ['Gal', ['Galater', 'Galatians']],
  ['Eph', ['Epheser', 'Ephesians']],
  ['Phil', ['Philipper', 'Philippians']],
  ['Kol', ['Kolosser', 'Col', 'Colossians']],
  ['1 Thess', ['1. Thessalonicher', '1Thess', '1 Thessalonians']],
  ['2 Thess', ['2. Thessalonicher', '2Thess', '2 Thessalonians']],
  ['1 Tim', ['1. Timotheus', '1Tim', '1 Timothy']],
  ['2 Tim', ['2. Timotheus', '2Tim', '2 Timothy']],
  ['Tit', ['Titus']],
  ['Phlm', ['Philemon']],
  ['Hebr', ['Hebräer', 'Heb', 'Hebrews']],
  ['Jak', ['Jakobus', 'Jas', 'James']],
  ['1 Petr', ['1. Petrus', '1Pet', '1 Peter']],
  ['2 Petr', ['2. Petrus', '2Pet', '2 Peter']],
  ['1 Joh', ['1. Johannes', '1John']],
  ['2 Joh', ['2. Johannes', '2John']],
  ['3 Joh', ['3. Johannes', '3John']],
  ['Jud', ['Judas', 'Jude']],
  ['Offb', ['Offenbarung', 'Apokalypse', 'Rev', 'Revelation']],
  ['Tob', ['Tobit']],
  ['Jdt', ['Judit', 'Judith']],
  ['Weish', ['Weisheit', 'Wis', 'Wisdom']],
  ['Sir', ['Sirach']],
  ['Bar', ['Baruch']],
  ['1 Makk', ['1. Makkabäer', '1Macc', '1 Maccabees']],
  ['2 Makk', ['2. Makkabäer', '2Macc', '2 Maccabees']]
];

export const BIBLE_BOOKS: ReadonlyArray<{ abbr: string; aliases: readonly string[] }> =
  BOOK_TABLE.map(([abbr, aliases]) => ({ abbr, aliases }));

/** Case-, accent-, dot- and whitespace-insensitive key: "1. Kor." → "1kor", "Joël" → "joel". */
function bookKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.\s]/g, '');
}

const ABBR_BY_KEY = new Map<string, string>(
  BIBLE_BOOKS.flatMap((b) => [b.abbr, ...b.aliases].map((n) => [bookKey(n), b.abbr] as const))
);

/** Optional ordinal + one-word book (optional dot), then a part starting with a digit. */
const REFERENCE_RE = /^((?:[1-5]\.?\s*)?\p{L}+)\.?\s*(\d.*)$/u;
/** Chapter/verse part after cleanup: "14", "1-2", "1,16-20", "29,7.11-14a", "13,31f." */
const PASSAGE_RE = /^\d+(?:[,.-]\d+[a-c]?)*(?:ff?\.?)?$/;

/**
 * Rewrite a reference into the Loccum form: "Mt. 5,1-12" → "Mt 5,1-12",
 * "Apostelgeschichte 2,1-12" → "Apg 2,1-12", "1. Mose 2,4-7" → "Gen 2,4-7".
 * In a "; " list a bare "3,17-21" continues the previous book, and a repeated
 * book name is dropped. Anything not recognized — including a list with one
 * unrecognized entry — is returned unchanged.
 */
export function normalizeBibleReference(text: string): string {
  const out: string[] = [];
  let prev: string | null = null;
  for (const part of text.normalize('NFC').split(';').map((p) => p.trim())) {
    const m = REFERENCE_RE.exec(part);
    const abbr = m ? ABBR_BY_KEY.get(bookKey(m[1])) : undefined;
    const passage = (m && abbr ? m[2] : prev ? part : '')
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/\s+/g, '');
    if (!PASSAGE_RE.test(passage)) return text;
    const book: string = abbr ?? (prev as string);
    out.push(book === prev ? passage : `${book} ${passage}`);
    prev = book;
  }
  return out.join('; ');
}
