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
 *    no tables or embedded objects).
 */
import { unzipSync, strFromU8 } from 'fflate';
import * as CFB from 'cfb';

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
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === 'mimetype' });
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
  return { kind, text: await extractDocumentText(buffer, kind) };
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
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => pick(f.name) });
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
// (drawing offsets, animation timing, extension data) is machine data.
const OOXML_W_TEXT = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
const OOXML_A_TEXT = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
const OOXML_SST_TEXT = /<t\b[^>]*>([\s\S]*?)<\/t>/g;

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
    text = marked.replace(TAGS, '').replace(new RegExp(NL, 'g'), '\n').replace(new RegExp(TB, 'g'), '\t');
  }
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[ \u00a0]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
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

function extractLegacyPpt(buffer: ArrayBuffer): string {
  const cfb = CFB.read(new Uint8Array(buffer), { type: 'buffer' });
  const idx = cfb.FullPaths.findIndex((p) => /\/PowerPoint Document$/.test(p));
  if (idx < 0) throw new Error('no PowerPoint Document stream');
  const content = cfb.FileIndex[idx].content as Uint8Array | number[];
  const d = Buffer.from(content as Uint8Array);
  const texts: string[] = [];
  const walk = (start: number, end: number) => {
    let o = start;
    while (o + 8 <= end) {
      const verInst = d.readUInt16LE(o);
      const type = d.readUInt16LE(o + 2);
      const len = d.readUInt32LE(o + 4);
      const body = o + 8;
      if (len > end - body) break;
      if (type === TEXT_CHARS_ATOM) texts.push(d.subarray(body, body + len).toString('utf16le'));
      else if (type === TEXT_BYTES_ATOM) texts.push(d.subarray(body, body + len).toString('latin1'));
      else if ((verInst & 0x0f) === 0x0f) walk(body, body + len); // container record
      o = body + len;
    }
  };
  walk(0, d.length);
  return texts
    .join('\n')
    .replace(/[\r\u000b]/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
