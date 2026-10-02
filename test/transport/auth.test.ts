import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createJwtVerifier, hasScope, AuthError } from '../../src/transport/auth.js';

const ISSUER = 'https://auth.edufeed.org/realms/edufeed';
const AUDIENCE = 'amb-mcp';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const verify = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: 'unused', getKey });
  const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; expSec?: number } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${opts.expSec ?? 3600}s`)
      .setSubject('user-123')
      .sign(privateKey);
  return { verify, sign };
}

describe('createJwtVerifier', () => {
  it('accepts a valid token and parses sub + scopes', async () => {
    const { verify, sign } = await setup();
    const ctx = await verify(await sign({ scope: 'mcp:read mcp:extract' }));
    expect(ctx.sub).toBe('user-123');
    expect(ctx.scopes).toEqual(['mcp:read', 'mcp:extract']);
    expect(hasScope(ctx, 'mcp:read')).toBe(true);
    expect(hasScope(ctx, 'mcp:write')).toBe(false);
  });

  it('rejects a token with the wrong audience (401)', async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({ scope: 'mcp:read' }, { aud: 'other' })))
      .rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token with the wrong issuer (401)', async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({ scope: 'mcp:read' }, { iss: 'https://evil.example' })))
      .rejects.toMatchObject({ status: 401 });
  });

  describe('with an audience list (nope-mcp, amb-mcp)', () => {
    async function setupList() {
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const jwk = await exportJWK(publicKey);
      jwk.kid = 'list-key';
      jwk.alg = 'RS256';
      const getKey = createLocalJWKSet({ keys: [jwk] });
      const verify = createJwtVerifier({
        issuer: ISSUER,
        audience: ['nope-mcp', 'amb-mcp'],
        jwksUri: 'unused',
        getKey,
      });
      const sign = (aud: string | string[]) =>
        new SignJWT({ scope: 'mcp:read' })
          .setProtectedHeader({ alg: 'RS256', kid: 'list-key' })
          .setIssuer(ISSUER)
          .setAudience(aud)
          .setIssuedAt()
          .setExpirationTime('1h')
          .setSubject('user-123')
          .sign(privateKey);
      return { verify, sign };
    }

    it('accepts aud = amb-mcp (tokens Keycloak issues today)', async () => {
      const { verify, sign } = await setupList();
      await expect(verify(await sign('amb-mcp'))).resolves.toMatchObject({ sub: 'user-123' });
    });

    it('accepts aud = nope-mcp', async () => {
      const { verify, sign } = await setupList();
      await expect(verify(await sign('nope-mcp'))).resolves.toMatchObject({ sub: 'user-123' });
    });

    it('accepts an aud array containing one configured audience', async () => {
      const { verify, sign } = await setupList();
      await expect(verify(await sign(['account', 'amb-mcp']))).resolves.toMatchObject({ sub: 'user-123' });
    });

    it('rejects an aud matching none of them (401)', async () => {
      const { verify, sign } = await setupList();
      await expect(verify(await sign(['account', 'other']))).rejects.toMatchObject({ status: 401 });
    });
  });

  it('rejects an expired token (401)', async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({ scope: 'mcp:read' }, { expSec: -10 })))
      .rejects.toBeInstanceOf(AuthError);
  });

  it('treats a missing scope claim as no scopes', async () => {
    const { verify, sign } = await setup();
    const ctx = await verify(await sign({}));
    expect(ctx.scopes).toEqual([]);
  });
});
