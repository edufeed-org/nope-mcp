import { parseHTML } from 'linkedom';
import { isDocumentMime, type DocumentHint, type DocumentKind, type ExtractedDocument } from './docExtractor.js';
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
const OPAQUE_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/force-download',
  'application/download',
  'application/x-download'
]);
const READABLE_TYPES = new Set(['application/xhtml+xml', 'application/xml']);

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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(parsed.toString(), {
      signal: controller.signal,
      headers: {
        Accept:
          'text/html, application/pdf, application/vnd.openxmlformats-officedocument.*, application/vnd.oasis.opendocument.*, application/msword, application/vnd.ms-powerpoint, */*;q=0.1',
        'User-Agent': 'Mozilla/5.0 (compatible; edufeed-metadata-mcp/0.1)'
      }
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`fetch failed with status ${response.status}`);
  }

  const contentTypeHeader = response.headers.get('content-type') || '';
  const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  // Body classification:
  //  - declared PDF types → PDF
  //  - opaque/download types and an absent content-type → sniff the magic
  //    bytes: %PDF- → PDF; otherwise an absent type is read as HTML (as
  //    before) and an opaque type is unsupported
  //  - HTML/XHTML/XML/plain text → HTML path
  //  - everything else (office documents, images, archives, JSON) cannot be
  //    turned into readable text here → unsupported_type
  let pdfBuffer: ArrayBuffer | undefined;
  let html: string | undefined;
  let docBuffer: ArrayBuffer | undefined;
  const hint: DocumentHint = { mime, url: parsed.toString() };
  const tryDocument = async (buffer: ArrayBuffer): Promise<FetchPageResult> => {
    if (buffer.byteLength > maxDocumentBytes) {
      throw new PageTooLargeError(
        `document body (${buffer.byteLength} bytes) exceeds size cap (${maxDocumentBytes} bytes)`
      );
    }
    const doc = docExtract ? await docExtract(buffer, hint) : undefined;
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
  };
  if (PDF_TYPES.has(mime)) {
    pdfBuffer = await response.arrayBuffer();
  } else if (isDocumentMime(mime)) {
    docBuffer = await response.arrayBuffer();
  } else if (mime === '' || OPAQUE_TYPES.has(mime) || mime === 'application/zip') {
    const buffer = await response.arrayBuffer();
    if (hasPdfMagic(buffer)) {
      pdfBuffer = buffer;
    } else if (hasZipMagic(buffer) || hasOleMagic(buffer)) {
      docBuffer = buffer;
    } else if (mime === '') {
      html = new TextDecoder('utf-8').decode(buffer);
    } else {
      throw new UnsupportedContentTypeError(
        `unsupported content type ${mime} (not a PDF or document) for ${parsed.toString()}`
      );
    }
  } else if (READABLE_TYPES.has(mime) || mime.startsWith('text/')) {
    html = await response.text();
  } else {
    throw new UnsupportedContentTypeError(
      `unsupported content type ${mime} for ${parsed.toString()}`
    );
  }

  if (docBuffer) return tryDocument(docBuffer);

  if (pdfBuffer) {
    let readableText = '';
    // Size cap is checked OUTSIDE the try so it surfaces as a typed error
    // instead of being swallowed into "empty text → empty LLM payload".
    if (pdfBuffer.byteLength > maxBytes) {
      throw new PageTooLargeError(
        `PDF body (${pdfBuffer.byteLength} bytes) exceeds size cap (${maxBytes} bytes)`
      );
    }
    if (pdfExtract) {
      try {
        readableText = await pdfExtract(pdfBuffer);
      } catch {
        // Graceful: leave readableText empty on genuine parse failure
        // (corrupt PDF etc.) so downstream falls back to OG/baseline rather
        // than failing the whole enrichment. Distinct from the size-cap
        // case above, which is a hard failure the user can act on
        // ("upload a smaller file" or "we'll raise the cap").
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

  if (html === undefined) html = '';
  if (html.length > maxBytes) {
    throw new PageTooLargeError(
      `HTML body (${html.length} bytes) exceeds size cap (${maxBytes} bytes)`
    );
  }

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
