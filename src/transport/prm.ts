export interface PrmConfig {
  resource: string;
  issuer: string;
  scopes: string[];
}

export function buildProtectedResourceMetadata(cfg: PrmConfig): Record<string, unknown> {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: cfg.scopes,
    bearer_methods_supported: ['header'],
  };
}

const PRM_WELL_KNOWN = '/.well-known/oauth-protected-resource';

/**
 * Where the PRM document for `resource` lives, per RFC 9728 §3.1: the
 * well-known segment is inserted between the origin and the resource path,
 * so `https://h/` ↔ `https://h/.well-known/oauth-protected-resource` and
 * `https://h/mcp` ↔ `https://h/.well-known/oauth-protected-resource/mcp`.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.origin}${PRM_WELL_KNOWN}${path}`;
}
