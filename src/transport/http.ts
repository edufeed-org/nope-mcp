/**
 * Streamable HTTP transport for nope-mcp (formerly amb-mcp).
 *
 * Mounts `@modelcontextprotocol/sdk`'s StreamableHTTPServerTransport behind
 * an Express app at both `/` and `/mcp` (POST/GET/DELETE, one shared session
 * map) plus a `/healthz` endpoint. Uses stateful sessions so server-push
 * notifications (e.g. progress from the LLM-backed extract_metadata tool)
 * reach the client over SSE.
 *
 * A plain browser `GET /` (no `Mcp-Session-Id` header, `Accept` without
 * `text/event-stream`) gets a small JSON info document instead of the usual
 * "unknown session" 404 — `GET /mcp` keeps returning that 404 unchanged,
 * since only `/` doubles as a human-facing landing URL.
 *
 * Authentication: read tools are served anonymously (a tokenless /mcp request
 * gets an mcp:read session). A supplied token is fully validated (bad token →
 * 401); a valid token additionally grants its scopes (e.g. mcp:extract).
 *
 * OAuth metadata is host-aware (RFC 9728): the server answers on several
 * hostnames and on both `/` and `/mcp`, and the PRM `resource` must equal the
 * URL the client connected to. So the PRM is built per request from the
 * forwarded scheme + host (`trust proxy` is on — Traefik terminates TLS):
 * `/.well-known/oauth-protected-resource` describes `https://<host>/`,
 * `/.well-known/oauth-protected-resource/mcp` describes `https://<host>/mcp`,
 * and a 401 points `resource_metadata` at the PRM matching the request path.
 * A host outside `allowedHosts` (when configured) gets `auth.resourceUrl`.
 *
 * Per-connection config: the query string of the `initialize` request is
 * handed to `buildMcpServer`, so a client can pin a session's behaviour in
 * the URL it connects with (e.g. `/mcp?relays=sodix`). A factory that
 * rejects the config throws SessionConfigError and no session is opened.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { AuthContext } from './auth.js';
import { AuthError } from './auth.js';
import { buildProtectedResourceMetadata, protectedResourceMetadataUrl } from './prm.js';

/**
 * The `initialize` query string named a configuration the session factory
 * cannot honour. Answered with HTTP 400 — the connection is misconfigured,
 * not unauthorized, and retrying it unchanged will never work.
 */
export class SessionConfigError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionConfigError';
  }
}

export interface HttpServerOptions {
  port: number;
  host: string;
  /** OAuth resource-server config. When set, a supplied token must be a valid JWT. */
  auth?: {
    verify: (token: string) => Promise<AuthContext>;
    /**
     * Fallback resource URL, advertised for a request whose host is not in
     * `allowedHosts`. Otherwise the resource is derived from the request.
     */
    resourceUrl: string;
    issuer: string;
    scopes: string[];
  };
  /** Host header allow-list for DNS-rebinding protection. */
  allowedHosts?: string[];
  /** Origin allow-list for DNS-rebinding protection. */
  allowedOrigins?: string[];
  /**
   * Factory called once per new MCP session to build a fresh server.
   * Receives the authenticated scopes so the session can be scope-gated, and
   * the query string of the initialize request so the connection URL can
   * configure the session. `dispose` (if returned) is invoked when the
   * session closes, so the session's relay connections can be torn down.
   * Throw SessionConfigError to refuse an unusable config with HTTP 400.
   */
  buildMcpServer: (ctx: { scopes: string[]; query: URLSearchParams }) => {
    server: McpServer;
    dispose?: () => void | Promise<void>;
  };
  /** Used in /healthz response. */
  serverName?: string;
  serverVersion?: string;
}

export interface HttpServerHandle {
  close(): Promise<void>;
  port: number;
}

const DOCS_URL = 'https://git.edufeed.org/edufeed/nope-mcp#readme';

/** True for a plain browser-style GET /: no session, not asking for an SSE stream. */
function isInfoDocumentRequest(req: Request): boolean {
  if (req.path !== '/') return false;
  const sid = req.headers['mcp-session-id'];
  if (typeof sid === 'string' && sid.length > 0) return false;
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.includes('text/event-stream')) return false;
  return true;
}

/** Public host (with any non-default port) the client addressed, proxy-aware. */
function requestHost(req: Request): string | undefined {
  // `trust proxy` is on, so X-Forwarded-Host (set by Traefik) wins over Host.
  const forwarded = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  return forwarded || req.get('host') || undefined;
}

function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  const wanted = host.toLowerCase();
  const hostname = wanted.replace(/:\d+$/, '');
  return allowedHosts.some((h) => {
    const allowed = h.toLowerCase();
    return allowed === wanted || allowed === hostname;
  });
}

// A DNS name or bracketed IPv6 literal, with an optional port — nothing that
// could smuggle a path, userinfo, quote or whitespace into an advertised URL.
const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * `<proto>://<host>` from client-controlled (forwarded) values, or undefined
 * when either is unusable. Never throws.
 */
function safeOrigin(proto: string, host: string | undefined): string | undefined {
  if (proto !== 'http' && proto !== 'https') return undefined;
  if (!host || !SAFE_HOST.test(host)) return undefined;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return undefined;
  }
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const {
    port,
    host,
    allowedHosts,
    allowedOrigins,
    buildMcpServer,
    serverName = 'nope-mcp',
    serverVersion = '0.0.0',
  } = opts;

  const app = express();
  // Behind Traefik: req.protocol follows X-Forwarded-Proto.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));
  app.use(
    cors({
      origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : '*',
      exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version', 'WWW-Authenticate'],
      allowedHeaders: ['Content-Type', 'Mcp-Session-Id', 'Authorization', 'Mcp-Protocol-Version'],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );

  // /healthz stays unauthenticated and outside the session map.
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      name: serverName,
      version: serverVersion,
      sessions: transports.size,
    });
  });

  /** Root URL shown in the info document when the request's own is unusable. */
  const infoFallbackUrl = (): string => {
    try {
      if (opts.auth) return new URL('/', opts.auth.resourceUrl).href;
    } catch {
      // fall through to the bind address
    }
    return `http://${host}:${port}/`;
  };

  /** The protected resource URL for `path` as addressed by this request. */
  // Client-controlled headers feed this, so anything malformed or not on
  // the allow-list yields the fallback instead of an attacker-chosen URL.
  const resourceFor = (req: Request, path: '/' | '/mcp', fallback: string): string => {
    const host = requestHost(req);
    const origin = safeOrigin(req.protocol, host);
    if (!origin || !host) return fallback;
    if (allowedHosts && allowedHosts.length > 0 && !isHostAllowed(host, allowedHosts)) return fallback;
    return `${origin}${path}`;
  };

  // PRM documents served unauthenticated (RFC 9728), one per MCP path.
  if (opts.auth) {
    const auth = opts.auth;
    const servePrm = (path: '/' | '/mcp') => (req: Request, res: Response) => {
      res.json(
        buildProtectedResourceMetadata({
          resource: resourceFor(req, path, auth.resourceUrl),
          issuer: auth.issuer,
          scopes: auth.scopes,
        }),
      );
    };
    app.get('/.well-known/oauth-protected-resource', servePrm('/'));
    app.get('/.well-known/oauth-protected-resource/mcp', servePrm('/mcp'));
  }

  // WWW-Authenticate challenge value for 401 responses on `/` or `/mcp`.
  const challengeFor = (req: Request): string => {
    if (!opts.auth) return 'Bearer realm="nope-mcp"';
    const path = req.path === '/mcp' || req.path === '/mcp/' ? '/mcp' : '/';
    const resource = resourceFor(req, path, opts.auth.resourceUrl);
    try {
      return `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}"`;
    } catch {
      // Only reachable with a malformed configured resourceUrl; this runs in
      // the auth middleware's error path, where a throw would crash Node.
      return 'Bearer realm="nope-mcp"';
    }
  };

  // JWT middleware applied to /mcp routes.
  const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';

    // No credential supplied → anonymous public read.
    if (!token) {
      res.locals.scopes = ['mcp:read'];
      return next();
    }

    // A token was supplied → it must be a valid JWT.
    if (!opts.auth) {
      res.setHeader('WWW-Authenticate', challengeFor(req));
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
    try {
      const ctx = await opts.auth.verify(token);
      res.locals.scopes = ctx.scopes;
      next();
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      res.setHeader('WWW-Authenticate', challengeFor(req));
      res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
  };

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post(['/', '/mcp'], authMiddleware, async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const sessionId = typeof sid === 'string' ? sid : undefined;

    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      // Session config comes from the initialize URL only; later requests on
      // this session are addressed by Mcp-Session-Id and carry no config.
      const query = new URLSearchParams(req.originalUrl.split('?')[1] ?? '');

      // Built before the transport so a rejected config opens no session.
      // Tool profile is fixed at init time from the initializing token's scopes; it is not re-derived per subsequent request on this session.
      let mcp: McpServer;
      let dispose: (() => void | Promise<void>) | undefined;
      try {
        ({ server: mcp, dispose } = buildMcpServer({
          scopes: (res.locals.scopes as string[]) ?? [],
          query,
        }));
      } catch (err) {
        if (err instanceof SessionConfigError) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32602, message: err.message, ...(err.details ? { data: err.details } : {}) },
            id: null,
          });
          return;
        }
        throw err;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (transport) transports.set(id, transport);
        },
        enableDnsRebindingProtection: Boolean(
          (allowedHosts && allowedHosts.length > 0) ||
            (allowedOrigins && allowedOrigins.length > 0),
        ),
        allowedHosts,
        allowedOrigins,
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
        void dispose?.();
      };
      await mcp.connect(transport);
    }

    if (!transport) {
      // 404 per the Streamable HTTP spec: a request with an unknown or
      // expired Mcp-Session-Id (e.g. after a server restart dropped the
      // in-memory session map) MUST get 404 so the client transparently
      // re-initializes, instead of surfacing a tool error to the user.
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found: send an initialize request to start a new session' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequestHandler = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'];
    const sessionId = typeof sid === 'string' ? sid : undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      // 404, not 400 — see the POST handler: spec-mandated re-init signal.
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found: send an initialize request to start a new session' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
  };

  const getRequestHandler = async (req: Request, res: Response) => {
    if (isInfoDocumentRequest(req)) {
      res.json({
        name: serverName,
        version: serverVersion,
        mcp: resourceFor(req, '/', infoFallbackUrl()),
        docs: DOCS_URL,
        transport: 'streamable-http',
      });
      return;
    }
    await sessionRequestHandler(req, res);
  };

  app.get(['/', '/mcp'], authMiddleware, getRequestHandler);
  app.delete(['/', '/mcp'], authMiddleware, sessionRequestHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  const resolvedPort = (server.address() as import('node:net').AddressInfo).port;

  return {
    port: resolvedPort,
    async close() {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          // ignore individual transport close failures
        }
      }
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
