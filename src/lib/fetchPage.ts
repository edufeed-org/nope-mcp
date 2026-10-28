import { parseHTML } from 'linkedom';
import type { DocumentHint, DocumentKind, ExtractedDocument } from './docExtractor.js';
import { Readability } from '@mozilla/readability';

/**
 * Fetch a public web page and extract everything that's useful for the
 * metadata-enrichment LLM step: Open Graph tags, JSON-LD blocks, an AMB
 * JSON-LD shortcut if the page already exposes one, the Readability text
 * excerpt, and a best-effort language code.
 *
 * SSRF guarded: rejects non-http(s) schemes, localhost, link-local, and
 * RFC1918 ranges.
 *
 * The fetch implementation is injectable so tests can stub network IO
 * without spinning up a server.
 */

export interface FetchPageInput {
  url: string;
  fetchFn?: typeof fetch;
  /** Hard cap on response body size, default 5 MiB. */
  maxBytes?: number;
  /** Hard cap on fetch wall-clock time, default 10s. */
  timeoutMs?: number;
  /**
   * PDF → plain-text extractor. Called when the response is
   * `application/pdf`. Injected so the loader stays runtime-agnostic
   * (Node, browser, edge) and tests can stub it. Throws and missing
   * extractors both degrade gracefully to empty text.
   */
  pdfExtract?: (buffer: ArrayBuffer) => Promise<string>;
  /**
   * Office-document → plain-text extractor (docx/pptx/xlsx, odt/odp/ods,
   * legacy doc/ppt), see `extractDocument` in docExtractor.ts. Without it,
   * document bodies are reported as `unsupported_type` (previous behaviour).
   */
  docExtract?: (buffer: ArrayBuffer, hint: DocumentHint) => Promise<ExtractedDocument | undefined>;
  /** Size cap for office documents (presentations are large); default 64 MiB. */
  maxDocumentBytes?: number;
}

export interface FetchPageResult {
  url: string;
  contentType: 'html' | 'pdf' | 'document';
  /** Set for contentType 'document'. */
  documentKind?: DocumentKind;
  title?: string;
  description?: string;
  image?: string;
  language?: string;
  ogTags: Record<string, string>;
  jsonLd: unknown[];
  ambJsonLd?: unknown;
  readableText: string;
}

// 20 MiB is enough for the image-heavy German educational PDFs we see in
// practice (the rpi-ekkw-ekhn konfi material runs ~8 MiB). Was 5 MiB until
// users reported empty AI suggestions on perfectly-valid 6–10 MiB PDFs.
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Upper bound for reading a body once headers arrived (large presentations on slow hosts). */
const BODY_TIMEOUT_MS = 120_000;

// Concrete media types; wildcards other than type/* are not valid ranges.
const ACCEPT_HEADER = [
  'text/html',
  'application/xhtml+xml',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/msword',
  'application/vnd.ms-powerpoint',
  '*/*;q=0.1'
].join(', ');

/**
 * Thrown by fetchPage when the response body exceeds `maxBytes`. Carries a
 * `code: 'page_too_large'` so the MCP tool path can surface this distinctly
 * from generic fetch / parse failures — otherwise oversized PDFs masquerade
 * as LLM failures to the user.
 */
/**
 * Thrown by fetchPage for bodies it cannot read (office documents, images,
 * archives …). Carries `code: 'unsupported_type'` so multi-source extraction
 * can skip the source instead of feeding binary garbage to the LLM.
 */
export class UnsupportedContentTypeError extends Error {
  readonly code = 'unsupported_type' as const;
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedContentTypeError';
  }
}

const PDF_TYPES = new Set(['application/pdf', 'application/x-pdf']);
const READABLE_TYPES = new Set(['application/xhtml+xml', 'application/xml', 'application/json']);

/** First non-whitespace bytes are a tag: HTML/XML regardless of the declared type. */
function looksLikeHtml(buffer: ArrayBuffer): boolean {
  const head = new Uint8Array(buffer.slice(0, 512));
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09)) i++;
  return head[i] === 0x3c; // '<'
}

/**
 * Read the body with a byte cap: reject early on a declared content-length
 * above the cap, otherwise stream and abort as soon as the cap is exceeded,
 * so neither memory nor time is spent on bodies we would refuse anyway.
 */
async function readBodyCapped(response: Response, cap: number, controller: AbortController): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > cap) {
    controller.abort();
    throw new PageTooLargeError(`declared body (${declared} bytes) exceeds size cap (${cap} bytes)`);
  }
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
      controller.abort();
      throw new PageTooLargeError(`body exceeds size cap (${cap} bytes)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out.buffer;
}

function hasZipMagic(buffer: ArrayBuffer): boolean {
  const h = new Uint8Array(buffer.slice(0, 4));
  return h.length === 4 && h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04;
}

function hasOleMagic(buffer: ArrayBuffer): boolean {
  const h = new Uint8Array(buffer.slice(0, 4));
  return h.length === 4 && h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0;
}

function hasPdfMagic(buffer: ArrayBuffer): boolean {
  const head = new Uint8Array(buffer.slice(0, 4));
  return head.length === 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
}

export class PageTooLargeError extends Error {
  /** Stable machine-readable code; consumers match on this, not on .message. */
  readonly code = 'page_too_large' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PageTooLargeError';
  }
}

function isPrivateOrLocalHost(host: string): boolean {
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  // IPv4 RFC1918 / loopback
  if (host.startsWith('127.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  // 172.16.0.0/12 → 172.16.x – 172.31.x
  const m = host.match(/^172\.(\d+)\./);
  if (m) {
    const second = parseInt(m[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function guard(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL must be http or https, got ${parsed.protocol}`);
  }
  if (isPrivateOrLocalHost(parsed.hostname.toLowerCase())) {
    throw new Error(`Refused to fetch private/local URL: ${parsed.hostname}`);
  }
  return parsed;
}

/** Pull <meta property="og:*"> and <meta name="og:*"> into a flat map. */
function extractOgTags(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
  const metas = doc.querySelectorAll('meta[property], meta[name]');
  for (const meta of Array.from(metas)) {
    const key = meta.getAttribute('property') || meta.getAttribute('name') || '';
    if (!key.startsWith('og:')) continue;
    const value = meta.getAttribute('content');
    if (value && !out[key]) out[key] = value;
  }
  return out;
}

function extractJsonLd(doc: Document): unknown[] {
  const blocks = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  const out: unknown[] = [];
  for (const block of blocks) {
    const text = block.textContent?.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return out;
}

/** Heuristic: any JSON-LD object whose @type contains 'LearningResource'. */
function findAmbJsonLd(blocks: unknown[]): unknown | undefined {
  const isLR = (t: unknown): boolean => {
    if (typeof t === 'string') return t.includes('LearningResource');
    if (Array.isArray(t)) return t.some(isLR);
    return false;
  };
  for (const block of blocks) {
    if (block && typeof block === 'object' && isLR((block as { '@type'?: unknown })['@type'])) {
      return block;
    }
    // schema.org sometimes wraps in @graph
    if (block && typeof block === 'object' && '@graph' in block) {
      const graph = (block as { '@graph'?: unknown[] })['@graph'];
      if (Array.isArray(graph)) {
        for (const node of graph) {
          if (node && typeof node === 'object' && isLR((node as { '@type'?: unknown })['@type'])) {
            return node;
          }
        }
      }
    }
  }
  return undefined;
}

function detectLanguage(doc: Document, ogTags: Record<string, string>): string | undefined {
  const locale = ogTags['og:locale'];
  if (locale) return locale.split(/[_-]/)[0].toLowerCase();
  const lang = doc.documentElement?.getAttribute?.('lang');
  if (lang) return lang.split(/[_-]/)[0].toLowerCase();
  return undefined;
}

function extractReadableText(html: string, url: string): string {
  try {
    const { document } = parseHTML(html);
    // Readability mutates the document; clone the parsed HTML to be safe by
    // re-parsing only what we need. linkedom is cheap enough.
    const reader = new Readability(document as unknown as Document, { charThreshold: 0 });
    const article = reader.parse();
    return article?.textContent?.trim() ?? '';
  } catch {
    return '';
  }
}

export async function fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
  const {
    url,
    fetchFn = fetch,
    maxBytes = DEFAULT_MAX_BYTES,
    maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pdfExtract,
    docExtract
  } = input;
  const parsed = guard(url);

  const controller = new AbortController();
  // One controller for headers AND body: a slow or endless body must not hold
  // a request open indefinitely (the body deadline is generous for large files).
  const headerTimer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(parsed.toString(), {
      signal: controller.signal,
      headers: {
        Accept: ACCEPT_HEADER,
        'User-Agent': 'Mozilla/5.0 (compatible; edufeed-metadata-mcp/0.1)'
      }
    });
  } finally {
    clearTimeout(headerTimer);
  }

  if (!response.ok) {
    throw new Error(`fetch failed with status ${response.status}`);
  }

  const contentTypeHeader = response.headers.get('content-type') || '';
  const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  const isTextual = mime === '' || mime.startsWith('text/') || READABLE_TYPES.has(mime);
  const declaredPdf = PDF_TYPES.has(mime);
  // Body classification: textual types are read as HTML/text; every other
  // type is buffered (up to the document cap) and classified by its first
  // bytes — a .pptx served as ".PPT"/octet-stream is a document, a login
  // page served as application/msword is HTML, %PDF- is a PDF. What no
  // reader understands is `unsupported_type`.
  const cap = isTextual || declaredPdf ? maxBytes : maxDocumentBytes;
  const bodyTimer = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);
  let buffer: ArrayBuffer;
  try {
    buffer = await readBodyCapped(response, cap, controller);
  } finally {
    clearTimeout(bodyTimer);
  }

  const hint: DocumentHint = { mime, url: parsed.toString() };
  let kind: 'html' | 'pdf' | 'document';
  if (declaredPdf || hasPdfMagic(buffer)) kind = 'pdf';
  else if (hasZipMagic(buffer) || hasOleMagic(buffer)) kind = 'document';
  else if (isTextual || looksLikeHtml(buffer)) kind = 'html';
  else {
    throw new UnsupportedContentTypeError(
      `unsupported content type ${mime || '(none)'} (not HTML, PDF or an office document) for ${parsed.toString()}`
    );
  }
  if (kind !== 'document' && buffer.byteLength > maxBytes) {
    throw new PageTooLargeError(
      `${kind.toUpperCase()} body (${buffer.byteLength} bytes) exceeds size cap (${maxBytes} bytes)`
    );
  }

  if (kind === 'document') {
    let doc: ExtractedDocument | undefined;
    try {
      doc = docExtract ? await docExtract(buffer, hint) : undefined;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === 'page_too_large' || code === 'unsupported_type') throw err;
      throw new UnsupportedContentTypeError(
        `document could not be read for ${parsed.toString()}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!doc) {
      throw new UnsupportedContentTypeError(
        `unsupported content type ${mime || '(none)'}${docExtract ? ' (not a readable document)' : ''} for ${parsed.toString()}`
      );
    }
    return {
      url: parsed.toString(),
      contentType: 'document',
      documentKind: doc.kind,
      ogTags: {},
      jsonLd: [],
      readableText: doc.text.trim()
    };
  }

  if (kind === 'pdf') {
    let readableText = '';
    if (pdfExtract) {
      try {
        readableText = await pdfExtract(buffer);
      } catch {
        // Graceful: leave readableText empty on genuine parse failure
        // (corrupt PDF etc.) so downstream falls back to OG/baseline rather
        // than failing the whole enrichment. Distinct from the size-cap
        // case, which is a hard failure the user can act on.
      }
    }
    return {
      url: parsed.toString(),
      contentType: 'pdf',
      ogTags: {},
      jsonLd: [],
      readableText
    };
  }

  const html = new TextDecoder('utf-8').decode(buffer);

  const { document } = parseHTML(html);
  const ogTags = extractOgTags(document as unknown as Document);
  const jsonLd = extractJsonLd(document as unknown as Document);
  const ambJsonLd = findAmbJsonLd(jsonLd);
  const language = detectLanguage(document as unknown as Document, ogTags);

  const titleEl = document.querySelector('title');
  const title = ogTags['og:title'] ?? titleEl?.textContent?.trim() ?? undefined;
  const description = ogTags['og:description'] ?? undefined;
  const image = ogTags['og:image'] ?? undefined;

  const readableText = extractReadableText(html, parsed.toString());

  return {
    url: parsed.toString(),
    contentType: 'html',
    title,
    description,
    image,
    language,
    ogTags,
    jsonLd,
    ambJsonLd,
    readableText
  };
}
