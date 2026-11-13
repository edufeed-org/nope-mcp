import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildSessionServer } from '../../src/session.js';
import { AMBRelayClient } from '../../src/relay/client.js';
import { IndexerClient } from '../../src/indexer/client.js';

/** The real server with every tool registered, reached through a real tools/list. */
async function connect() {
  const relay = 'wss://relay.example';
  const session = buildSessionServer([relay], [relay], { read: true, extract: true, write: true }, {
    spellClient: new AMBRelayClient([relay]),
    communityClient: new AMBRelayClient([relay]),
    indexer: IndexerClient.fromEnv(`${relay}=http://127.0.0.1:9`, 'placeholder') ?? undefined,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverSide as never);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return { client, session };
}

describe('tool input schemas', () => {
  it('advertise a closed object (additionalProperties: false) on every tool', async () => {
    const { client, session } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search_passages', 'find_community', 'add_relay', 'extract_metadata']));
    const open = tools.filter((t) => t.inputSchema.additionalProperties !== false).map((t) => t.name);
    expect(open).toEqual([]);

    // nested argument objects (search_passages' tag, publish_event's event …) are closed too
    const openNested: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.type === 'object' && o.properties && o.additionalProperties !== false) openNested.push(path);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}/${k}`);
    };
    for (const t of tools) walk(t.inputSchema, t.name);
    expect(openNested).toEqual([]);
    await client.close();
    session.dispose();
  });

  it('still drop an unknown argument instead of failing the call', async () => {
    const { client, session } = await connect();
    const result = await client.callTool({ name: 'list_relays', arguments: { notAParameter: 1 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0].text).defaultRelays).toEqual(['wss://relay.example']);
    await client.close();
    session.dispose();
  });
});
