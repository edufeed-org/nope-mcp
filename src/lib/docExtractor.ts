/**
 * Plain-text extraction for office documents, for use as the `docExtract`
 * callback in `fetchPage`/`extractMetadata`.
 *
 * Detection goes by magic bytes and container contents, never by file
 * extension or declared content type alone: sites commonly serve a .pptx
 * under a ".PPT" name or an octet-stream type.
 *
 *  - Zip containers (PK): OOXML (docx/pptx/xlsx) by their part paths, ODF
 *    (odt/odp/ods) by the `mimetype` entry. Text is read from the XML parts
 *    (word/document.xml, ppt/slides/*.xml + notes, xl/sharedStrings.xml,
 *    content.xml): paragraph elements become lines, tags are stripped,
 *    entities decoded.
 *  - OLE containers (D0 CF 11 E0): legacy .doc via word-extractor; legacy
 *    .ppt via the TextCharsAtom/TextBytesAtom records of the
 *    "PowerPoint Document" stream (best effort: titles, bullets and notes,
 *    no tables or embedded objects; outline text precedes per-slide text,
 *    incrementally saved files may repeat stale text).
 *  - xlsx is best effort too: shared strings only (no inline strings,
 *    numbers or sheet order).
 *
 * Safety: parts are inflated only up to MAX_PART_BYTES (declared size, which
 * fflate honours), text is matched linearly, extraction errors surface as
 * typed errors (`page_too_large`, `unsupported_type`) so a hostile or odd
 * source is skipped, never hangs or kills the process.
 */
import { unzipSync, strFromU8 } from 'fflate';
import * as CFB from 'cfb';

/** Per-part inflation cap (and total across the picked parts of one file). */
export const MAX_PART_BYTES = 64 * 1024 * 1024;

/** A part would inflate beyond MAX_PART_BYTES. Same code as fetchPage's size cap. */
export class DocumentTooLargeError extends Error {
  readonly code = 'page_too_large' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTooLargeError';
  }
}

/** The body looked like a document but could not be read (corrupt, unexpected layout). */
export class DocumentUnreadableError extends Error {
  readonly code = 'unsupported_type' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DocumentUnreadableError';
  }
}

export type DocumentKind = 'docx' | 'pptx' | 'xlsx' | 'odt' | 'odp' | 'ods' | 'doc' | 'ppt';

export interface DocumentHint {
  mime: string;
  url: string;
}

/** MIME types that announce an office document (used by fetchPage to buffer the body). */
export const DOCUMENT_MIME_PREFIXES = [
  'application/msword',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.oasis.opendocument.'
];

export function isDocumentMime(mime: string): boolean {
  return DOCUMENT_MIME_PREFIXES.some((p) => mime === p || mime.startsWith(p));
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

function hasMagic(buffer: ArrayBuffer, magic: number[]): boolean {
  const head = new Uint8Array(buffer.slice(0, magic.length));
  return head.length === magic.length && magic.every((b, i) => head[i] === b);
}

/** Classify a body; undefined when it is not a document we can read. */
export function detectDocument(buffer: ArrayBuffer, _hint: DocumentHint): DocumentKind | undefined {
  if (hasMagic(buffer, ZIP_MAGIC)) {
    const names: string[] = [];
    try {
      // Collect entry names without inflating anything.
      unzipSync(new Uint8Array(buffer), {
        filter: (f) => {
          names.push(f.name);
          return false;
        }
      });
    } catch {
      return undefined;
    }
    if (names.includes('mimetype')) {
      const mimetype = odfMimetype(buffer);
      if (mimetype === 'application/vnd.oasis.opendocument.text') return 'odt';
      if (mimetype === 'application/vnd.oasis.opendocument.presentation') return 'odp';
      if (mimetype === 'application/vnd.oasis.opendocument.spreadsheet') return 'ods';
    }
    if (names.some((n) => n === 'word/document.xml')) return 'docx';
    if (names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || n === 'ppt/presentation.xml')) return 'pptx';
    if (names.some((n) => n === 'xl/workbook.xml' || n === 'xl/sharedStrings.xml')) return 'xlsx';
    return undefined;
  }
  if (hasMagic(buffer, OLE_MAGIC)) {
    let paths: string[];
    try {
      paths = CFB.read(new Uint8Array(buffer), { type: 'buffer' }).FullPaths;
    } catch {
      return undefined;
    }
    if (paths.some((p) => /\/WordDocument$/.test(p))) return 'doc';
    if (paths.some((p) => /\/PowerPoint Document$/.test(p))) return 'ppt';
    return undefined;
  }
  return undefined;
}

function odfMimetype(buffer: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === 'mimetype' && f.originalSize < 1024 });
  return files.mimetype ? strFromU8(files.mimetype).trim() : '';
}

/** Result of `extractDocument`: the detected kind and its readable text. */
export interface ExtractedDocument {
  kind: DocumentKind;
  text: string;
}

/**
 * The `docExtract` callback for fetchPage: detect and extract in one step.
 * Returns undefined when the body is not a document we can read, so the
 * caller reports `unsupported_type`.
 */
export async function extractDocument(buffer: ArrayBuffer, hint: DocumentHint): Promise<ExtractedDocument | undefined> {
  const kind = detectDocument(buffer, hint);
  if (!kind) return undefined;
  try {
    return { kind, text: await extractDocumentText(buffer, kind) };
  } catch (err) {
    if (err instanceof DocumentTooLargeError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new DocumentUnreadableError(`${kind} document could not be read: ${msg}`);
  }
}

/** Extract the readable text of a detected document. Throws on malformed input. */
export async function extractDocumentText(buffer: ArrayBuffer, kind: DocumentKind): Promise<string> {
  switch (kind) {
    case 'docx':
      return zipXmlText(buffer, (n) => n === 'word/document.xml', OOXML_W_TEXT);
    case 'pptx':
      return zipXmlText(
        buffer,
        (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n),
        OOXML_A_TEXT,
        slideOrder
      );
    case 'xlsx':
      return zipXmlText(buffer, (n) => n === 'xl/sharedStrings.xml', OOXML_SST_TEXT);
    case 'odt':
    case 'odp':
    case 'ods':
      return zipXmlText(buffer, (n) => n === 'content.xml', undefined);
    case 'doc':
      return extractLegacyDoc(buffer);
    case 'ppt':
      return extractLegacyPpt(buffer);
  }
}

/** Slides before notes, each in numeric order (slide2 before slide10). */
function slideOrder(a: string, b: string): number {
  const rank = (n: string) => (n.startsWith('ppt/notesSlides/') ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  return num(a) - num(b);
}

function zipXmlText(
  buffer: ArrayBuffer,
  pick: (name: string) => boolean,
  textElement: RegExp | undefined,
  order: (a: string, b: string) => number = (a, b) => a.localeCompare(b)
): string {
  // fflate hands us the declared inflated size before inflating and never
  // grows the output beyond it, so checking it bounds memory reliably.
  let total = 0;
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (f) => {
      if (!pick(f.name)) return false;
      total += f.originalSize;
      if (f.originalSize > MAX_PART_BYTES || total > MAX_PART_BYTES) {
        throw new DocumentTooLargeError(
          `part ${f.name} would inflate to ${f.originalSize} bytes (cap ${MAX_PART_BYTES} bytes per file)`
        );
      }
      return true;
    }
  });
  const names = Object.keys(files).sort(order);
  const parts = names.map((n) => xmlToText(strFromU8(files[n]), textElement));
  return parts.filter((p) => p.length > 0).join('\n').trim();
}

// Paragraph-like elements (OOXML w:p, DrawingML a:p, ODF text:p/text:h, OOXML
// shared-string items) become line breaks; tabs and ODF spaces are kept.
const PARAGRAPH_END = /<\/(?:w:p|a:p|text:p|text:h|si)>/g;
const TAB = /<(?:w:tab|text:tab)\s*\/>/g;
const SPACE = /<text:s\s*\/>/g;
const LINE_BREAK = /<(?:w:br|a:br|text:line-break)\s*\/>/g;
const TAGS = /<[^>]+>/g;
// OOXML keeps prose in dedicated text elements; everything else in the part
// (drawing offsets, animation timing, extension data) is machine data. Text
// content cannot contain a literal '<', so `[^<]*` matches linearly and an
// empty `<w:t/>` cannot swallow the following markup.
const OOXML_W_TEXT = /<w:t\b[^>]*>([^<]*)<\/w:t>/g;
const OOXML_A_TEXT = /<a:t\b[^>]*>([^<]*)<\/a:t>/g;
const OOXML_SST_TEXT = /<t\b[^>]*>([^<]*)<\/t>/g;

const NL = '\u0001';
const TB = '\u0002';

/**
 * XML part → text. With `textElement` (OOXML) only the content of those
 * elements is kept, in document order, with paragraph ends, tabs and line
 * breaks preserved; without it (ODF) every text node is kept.
 */
function xmlToText(xml: string, textElement: RegExp | undefined): string {
  const marked = xml
    .replace(PARAGRAPH_END, NL)
    .replace(TAB, TB)
    .replace(SPACE, ' ')
    .replace(LINE_BREAK, NL);
  let text: string;
  if (textElement) {
    const tokens = new RegExp(`${textElement.source}|[${NL}${TB}]`, 'g');
    const out: string[] = [];
    for (const m of marked.matchAll(tokens)) {
      if (m[0] === NL) out.push('\n');
      else if (m[0] === TB) out.push('\t');
      else out.push(m[1] ?? '');
    }
    text = out.join('');
  } else {
    text = stripElements(marked, ['office:annotation', 'text:tracked-changes'])
      .replace(TAGS, '')
      .replace(new RegExp(NL, 'g'), '\n')
      .replace(new RegExp(TB, 'g'), '\t');
  }
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[ \u00a0]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove whole elements (opening tag through matching closing tag) in one
 * linear pass; an unclosed opener drops the rest of the part.
 */
function stripElements(xml: string, names: string[]): string {
  let out = xml;
  for (const name of names) {
    const open = `<${name}`;
    const close = `</${name}>`;
    if (!out.includes(open)) continue;
    const segments: string[] = [];
    let from = 0;
    for (;;) {
      const i = out.indexOf(open, from);
      if (i < 0) {
        segments.push(out.slice(from));
        break;
      }
      segments.push(out.slice(from, i));
      const j = out.indexOf(close, i);
      if (j < 0) break;
      from = j + close.length;
    }
    out = segments.join('');
  }
  return out;
}

function codePointOrLiteral(literal: string, cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return literal;
  return String.fromCodePoint(cp);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePointOrLiteral(m, parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => codePointOrLiteral(m, Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function extractLegacyDoc(buffer: ArrayBuffer): Promise<string> {
  const { default: WordExtractor } = await import('word-extractor');
  const doc = await new WordExtractor().extract(Buffer.from(buffer));
  return doc.getBody().replace(/\r\n?/g, '\n').trim();
}

// PowerPoint 97-2003 record types carrying text.
const TEXT_CHARS_ATOM = 0x0fa0; // UTF-16LE
const TEXT_BYTES_ATOM = 0x0fa8; // 8-bit (cp1252)

// Windows-1252 0x80–0x9F (the only range where it differs from latin1).
// Not via TextDecoder: node:alpine images ship ICU without legacy converters.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178
];

function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b >= 0x80 && b <= 0x9f ? String.fromCodePoint(CP1252_HIGH[b - 0x80]) : String.fromCharCode(b);
  return out;
}

const MAX_RECORD_DEPTH = 64;

function extractLegacyPpt(buffer: ArrayBuffer): string {
  const cfb = CFB.read(new Uint8Array(buffer), { type: 'buffer' });
  const idx = cfb.FullPaths.findIndex((p) => /\/PowerPoint Document$/.test(p));
  if (idx < 0) throw new Error('no PowerPoint Document stream');
  const content = cfb.FileIndex[idx].content as Uint8Array | number[];
  const d = Buffer.from(content as Uint8Array);
  const texts: string[] = [];
  // Explicit stack instead of recursion: a crafted file can nest containers
  // arbitrarily; deeper than MAX_RECORD_DEPTH is skipped, not descended.
  const stack: Array<{ o: number; end: number; depth: number }> = [{ o: 0, end: d.length, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.o + 8 > frame.end) {
      stack.pop();
      continue;
    }
    const verInst = d.readUInt16LE(frame.o);
    const type = d.readUInt16LE(frame.o + 2);
    const len = d.readUInt32LE(frame.o + 4);
    const body = frame.o + 8;
    if (len > frame.end - body) {
      stack.pop();
      continue;
    }
    frame.o = body + len;
    if (type === TEXT_CHARS_ATOM) texts.push(d.subarray(body, body + len).toString('utf16le'));
    else if (type === TEXT_BYTES_ATOM) texts.push(decodeCp1252(d.subarray(body, body + len)));
    else if ((verInst & 0x0f) === 0x0f && frame.depth < MAX_RECORD_DEPTH) {
      stack.push({ o: body, end: body + len, depth: frame.depth + 1 }); // container record
    }
  }
  return texts
    .join('\n')
    .replace(/[\r\u000b]/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
