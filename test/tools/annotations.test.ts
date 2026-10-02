import { describe, it, expect } from 'vitest';

import { buildSessionServer } from '../../src/session.js';
import { IndexerClient } from '../../src/indexer/client.js';
import { AMBRelayClient } from '../../src/relay/client.js';

const DEFAULTS = ['wss://relay.edufeed.org'];
const CAL_DEFAULTS = ['wss://relay.edufeed.org'];

/** Fully-registered session (read + extract + write, incl. search_passages). */
function fullSession() {
  const spellClient = new AMBRelayClient(DEFAULTS);
  const indexer = new IndexerClient(new Map([[DEFAULTS[0], 'https://indexer.example']]), 'tok');
  const session = buildSessionServer(DEFAULTS, CAL_DEFAULTS, { read: true, extract: true, write: true }, {
    spellClient,
    indexer,
  });
  const registry = (
    session.server as unknown as {
      _registeredTools: Record<string, { title?: string; annotations?: Record<string, unknown> }>;
    }
  )._registeredTools;
  return { session, registry, spellClient };
}

describe('tool annotations', () => {
  it('registers all 41 tools', () => {
    const { session, registry, spellClient } = fullSession();
    expect(Object.keys(registry)).toHaveLength(41);
    session.dispose();
    spellClient.close();
  });

  it('every tool has a non-empty title and a defined readOnlyHint', () => {
    const { session, registry, spellClient } = fullSession();
    for (const [name, tool] of Object.entries(registry)) {
      expect(tool.title, `${name} missing title`).toBeTruthy();
      expect(tool.annotations, `${name} missing annotations`).toBeDefined();
      expect(tool.annotations?.readOnlyHint, `${name} missing readOnlyHint`).toBeDefined();
    }
    session.dispose();
    spellClient.close();
  });

  it('search_content is read-only and closed-world', () => {
    const { session, registry, spellClient } = fullSession();
    expect(registry['search_content'].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    session.dispose();
    spellClient.close();
  });

  it('extract_metadata is read-only but open-world (fetches arbitrary URLs)', () => {
    const { session, registry, spellClient } = fullSession();
    expect(registry['extract_metadata'].annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    session.dispose();
    spellClient.close();
  });

  it('publish_event is not read-only and is open-world', () => {
    const { session, registry, spellClient } = fullSession();
    expect(registry['publish_event'].annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
    session.dispose();
    spellClient.close();
  });

  it('skos_delete_vocabulary is destructive (irreversibly drops the draft)', () => {
    const { session, registry, spellClient } = fullSession();
    expect(registry['skos_delete_vocabulary'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    session.dispose();
    spellClient.close();
  });

  it('session-local mutators (add_relay, signer_connect) are not open-world', () => {
    const { session, registry, spellClient } = fullSession();
    expect(registry['add_relay'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(registry['signer_connect'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    session.dispose();
    spellClient.close();
  });
});
