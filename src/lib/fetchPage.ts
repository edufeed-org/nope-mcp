import { parseHTML } from 'linkedom';
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
}

export interface FetchPageResult {
  url: string;
  contentType: 'html' | 'pdf';
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
  const { url, fetchFn = fetch, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, pdfExtract } = input;
  const parsed = guard(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(parsed.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'text/html, application/pdf',
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
  const isPdf =
    mime === 'application/pdf' ||
    (mime === 'application/octet-stream' && /\.pdf$/i.test(parsed.pathname));
  // Readable bodies: HTML/XHTML/plain text (and an absent content-type, as
  // before). Everything else — PowerPoint, Word, images, zips — cannot be
  // turned into readable text here and is reported as unsupported.
  const isReadable =
    mime === '' || mime.startsWith('text/') || mime === 'application/xhtml+xml' || mime === 'application/xml';
  if (!isPdf && !isReadable) {
    throw new UnsupportedContentTypeError(
      `unsupported content type ${mime || '(none)'} for ${parsed.toString()}`
    );
  }

  if (isPdf) {
    let readableText = '';
    if (pdfExtract) {
      // Size cap is checked OUTSIDE the try so it surfaces as a typed error
      // instead of being swallowed into "empty text → empty LLM payload".
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new PageTooLargeError(
          `PDF body (${buffer.byteLength} bytes) exceeds size cap (${maxBytes} bytes)`
        );
      }
      try {
        readableText = await pdfExtract(buffer);
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

  const html = await response.text();
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
