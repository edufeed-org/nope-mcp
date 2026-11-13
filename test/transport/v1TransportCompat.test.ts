import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildSessionServer } from '../../src/session.js';

// @contextvm/sdk's NostrServerTransport is built on SDK v1's Transport
// interface, while the server is SDK v2. This is that pairing without Nostr:
// a v1 transport pair, a v1 client, the real v2 server.
describe('v2 server over a v1 transport (the ContextVM pairing)', () => {
  it('completes initialize, lists the tools and answers a call', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const session = buildSessionServer(['wss://relay.example'], ['wss://relay.example'], { read: true });
    await session.server.connect(serverSide as never);

    const client = new Client({ name: 'v1-client', version: '0' });
    await client.connect(clientSide);
    expect(client.getServerVersion()?.name).toBe('nope-mcp');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('list_relays');
    // zod 4 schemas still reach a v1 client as JSON Schema with their descriptions
    const search = tools.find((t) => t.name === 'search_resources')!;
    expect(Object.values(search.inputSchema.properties ?? {}).some((p) => (p as { description?: string }).description)).toBe(true);

    const result = await client.callTool({ name: 'list_relays', arguments: {} });
    expect(JSON.parse((result.content as { text: string }[])[0].text).defaultRelays).toEqual(['wss://relay.example']);

    await client.close();
    session.dispose();
  });
});
