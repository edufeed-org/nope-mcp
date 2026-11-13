import { describe, it, expect } from 'vitest';

import { buildSessionServer } from '../src/session.js';

const DEFAULTS = ['wss://relay.edufeed.org'];
const CAL_DEFAULTS = ['wss://relay.edufeed.org'];

async function listToolNames(profile?: { read?: boolean; extract?: boolean; write?: boolean }) {
  const s = buildSessionServer(DEFAULTS, CAL_DEFAULTS, profile);
  // McpServer exposes registered tools via its internal registry.
  const names = Object.keys((s.server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  s.dispose();
  return names;
}

/** Invoke a session's registered list_relays tool and parse its JSON payload. */
async function callListRelays(session: ReturnType<typeof buildSessionServer>) {
  const tool = (
    session.server as unknown as {
      _registeredTools: Record<string, { handler: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>;
    }
  )._registeredTools['list_relays'];
  const result = await tool.handler({}, {});
  return JSON.parse(result.content[0].text);
}

describe('buildSessionServer per-session relay isolation', () => {
  it('tells list_relays when the connector URL chose the default set', async () => {
    const s = buildSessionServer(DEFAULTS, CAL_DEFAULTS, undefined, {
      ambExtraRelays: ['wss://oersi.example'],
      defaultsFromConnectorUrl: true,
    });
    const payload = await callListRelays(s);
    expect(payload.defaultRelaysSource).toBe('connector-url');
    s.dispose();
  });

  it('reports a server-configured default set as such', async () => {
    const s = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    const payload = await callListRelays(s);
    expect(payload.defaultRelaysSource).toBe('server-config');
    s.dispose();
  });

  it('seeds the AMB client with selectable extra relays', () => {
    const s = buildSessionServer(DEFAULTS, CAL_DEFAULTS, undefined, {
      ambExtraRelays: ['wss://oersi.example'],
    });
    expect(s.ambClient.getRelays()).toEqual(DEFAULTS);
    expect(s.ambClient.getExtraRelays()).toEqual(['wss://oersi.example']);
    s.dispose();
  });

  it('gives each session independent relay clients', () => {
    const a = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    const b = buildSessionServer(DEFAULTS, CAL_DEFAULTS);

    expect(a.ambClient).not.toBe(b.ambClient);
    expect(a.calendarClient).not.toBe(b.calendarClient);

    a.dispose();
    b.dispose();
  });

  it('does not leak a relay added in one session into another', () => {
    const a = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    const b = buildSessionServer(DEFAULTS, CAL_DEFAULTS);

    const extra = 'wss://extra.example.com';
    a.ambClient.addRelay(extra);

    expect(a.ambClient.getRelays()).toContain(extra);
    expect(b.ambClient.getRelays()).not.toContain(extra);
    expect(b.ambClient.getRelays()).toEqual(DEFAULTS);

    a.dispose();
    b.dispose();
  });

  it('does not leak a relay removed in one session into another', () => {
    const a = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    const b = buildSessionServer(DEFAULTS, CAL_DEFAULTS);

    a.ambClient.removeRelay(DEFAULTS[0]);

    expect(a.ambClient.getRelays()).not.toContain(DEFAULTS[0]);
    expect(b.ambClient.getRelays()).toEqual(DEFAULTS);

    a.dispose();
    b.dispose();
  });

  it('dispose is idempotent and does not throw', () => {
    const a = buildSessionServer(DEFAULTS, CAL_DEFAULTS);
    expect(() => {
      a.dispose();
      a.dispose();
    }).not.toThrow();
  });
});

describe('buildSessionServer tool profile', () => {
  it('read-only profile excludes write and extract tools', async () => {
    const names = await listToolNames({ read: true, extract: false, write: false });
    expect(names).toContain('search_content');
    expect(names).toContain('get_resource');
    expect(names).not.toContain('extract_metadata');
    expect(names).not.toContain('publish_event');
    expect(names).not.toContain('sign_event');
    expect(names).not.toContain('add_relay');
  });

  it('extract profile adds extract_metadata but still no write tools', async () => {
    const names = await listToolNames({ read: true, extract: true, write: false });
    expect(names).toContain('extract_metadata');
    expect(names).not.toContain('publish_event');
    expect(names).not.toContain('sign_event');
    expect(names).not.toContain('add_relay');
    expect(names).not.toContain('skos_create_vocabulary');
  });

  it('default profile keeps the full toolset (write tools present)', async () => {
    const names = await listToolNames();
    expect(names).toContain('publish_event');
    expect(names).toContain('sign_event');
    expect(names).toContain('add_relay');
  });
});

describe('buildSessionServer with shared relay clients', () => {
  it('refuses shared clients together with a profile that can mutate them', () => {
    const owner = buildSessionServer(DEFAULTS, CAL_DEFAULTS, { read: true });
    const clients = { ambClient: owner.ambClient, calendarClient: owner.calendarClient };
    expect(() => buildSessionServer(DEFAULTS, CAL_DEFAULTS, { read: true, write: true }, { clients })).toThrow(/shared relay clients/i);
    // the default profile is write-capable, so omitting it must be refused too
    expect(() => buildSessionServer(DEFAULTS, CAL_DEFAULTS, undefined, { clients })).toThrow(/shared relay clients/i);
    expect(() => buildSessionServer(DEFAULTS, CAL_DEFAULTS, { read: true, extract: true }, { clients })).not.toThrow();
    owner.dispose();
  });
});
