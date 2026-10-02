import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const serverJson = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('server.json (MCP Registry manifest)', () => {
  it('version matches package.json version', () => {
    expect(serverJson.version).toBe(packageJson.version);
  });

  it('is named under the org.edufeed namespace', () => {
    expect(serverJson.name).toBe('org.edufeed/nope-mcp');
  });

  it('advertises the streamable-http remote at mcp.edufeed.org', () => {
    expect(serverJson.remotes).toEqual([
      {
        type: 'streamable-http',
        url: 'https://mcp.edufeed.org/mcp',
      },
    ]);
  });

  it('points at the GitHub mirror as its repository', () => {
    expect(serverJson.repository).toEqual({
      url: 'https://github.com/edufeed-org/nope-mcp',
      source: 'github',
    });
  });

  it('declares the current registry schema', () => {
    expect(serverJson.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
    );
  });
});
