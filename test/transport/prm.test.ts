import { describe, it, expect } from 'vitest';
import { buildProtectedResourceMetadata, protectedResourceMetadataUrl } from '../../src/transport/prm.js';

describe('buildProtectedResourceMetadata', () => {
  it('produces an RFC 9728 document', () => {
    const doc = buildProtectedResourceMetadata({
      resource: 'https://mcp.amb.edufeed.org/mcp',
      issuer: 'https://auth.edufeed.org/realms/edufeed',
      scopes: ['mcp:read', 'mcp:extract'],
    });
    expect(doc).toEqual({
      resource: 'https://mcp.amb.edufeed.org/mcp',
      authorization_servers: ['https://auth.edufeed.org/realms/edufeed'],
      scopes_supported: ['mcp:read', 'mcp:extract'],
      bearer_methods_supported: ['header'],
    });
  });
});

describe('protectedResourceMetadataUrl (RFC 9728 path insertion)', () => {
  it('maps a root resource to the bare well-known URL', () => {
    expect(protectedResourceMetadataUrl('https://mcp.edufeed.org/'))
      .toBe('https://mcp.edufeed.org/.well-known/oauth-protected-resource');
  });

  it('inserts the well-known segment before a resource path', () => {
    expect(protectedResourceMetadataUrl('https://mcp.edufeed.org/mcp'))
      .toBe('https://mcp.edufeed.org/.well-known/oauth-protected-resource/mcp');
  });

  it('keeps a non-default port', () => {
    expect(protectedResourceMetadataUrl('http://localhost:3000/mcp'))
      .toBe('http://localhost:3000/.well-known/oauth-protected-resource/mcp');
  });
});
