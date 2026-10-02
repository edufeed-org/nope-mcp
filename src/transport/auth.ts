import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthContext {
  sub: string;
  scopes: string[];
}

export interface AuthConfig {
  issuer: string;
  /** Accepted audiences: a token whose `aud` contains ANY of them is valid. */
  audience: string | string[];
  jwksUri: string;
  /** Override key resolver — tests inject a local JWKS. */
  getKey?: JWTVerifyGetKey;
}

export class AuthError extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export function createJwtVerifier(cfg: AuthConfig): (token: string) => Promise<AuthContext> {
  const getKey = cfg.getKey ?? createRemoteJWKSet(new URL(cfg.jwksUri));
  return async function verify(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        algorithms: ['RS256'],
      });
      const scope = typeof payload.scope === 'string' ? payload.scope : '';
      return {
        sub: typeof payload.sub === 'string' ? payload.sub : '',
        scopes: scope.split(' ').filter(Boolean),
      };
    } catch (err) {
      throw new AuthError(401, err instanceof Error ? err.message : 'invalid token');
    }
  };
}

export function hasScope(ctx: AuthContext, scope: string): boolean {
  return ctx.scopes.includes(scope);
}
