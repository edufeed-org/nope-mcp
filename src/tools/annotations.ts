/**
 * Shared `ToolAnnotations` constants for `registerTool` calls.
 *
 * MCP directories (Claude Connectors Directory, ChatGPT) and clients use
 * these hints to tell a safe, no-prompt read from a tool that mutates
 * session state, publishes to relays, or talks to the open web. Every
 * `registerTool` call in `src/tools/` should pass one of these.
 *
 * Classification rule: start from `readOnlyHint` — does the handler ever
 * write anything, anywhere? If not, it's a read (`READ_ONLY`, or
 * `READ_OPEN_WORLD` when it fetches arbitrary external URLs rather than a
 * closed set of relays). If it does write, ask where: only to this
 * session's in-memory state (`SESSION_MUTATOR`, or `SESSION_DESTRUCTIVE`
 * when that write irreversibly discards data) or out to the relay network
 * (`PUBLISHER`, i.e. open-world). Judge every tool by what its handler
 * actually does, not by its name.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Pure queries against the AMB relays / in-session state: no mutation, no
 * arbitrary outbound fetches. Repeating the call is safe and yields the same
 * kind of result (idempotent in the MCP sense — not byte-identical, since
 * relay content changes over time).
 */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * A read that fetches arbitrary external URLs (e.g. `extract_metadata`
 * scraping a page the caller points it at) — still non-mutating, but the
 * server reaches into the open web rather than a closed set of relays.
 */
export const READ_OPEN_WORLD: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * Mutates only this session's in-memory state (relay list, SKOS builder
 * draft, signer connection) — never touches a relay or the open web, and
 * nothing written survives the session.
 */
export const SESSION_MUTATOR: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/**
 * A session-local mutation that irreversibly discards data (e.g. dropping a
 * SKOS vocabulary draft from the builder store) without publishing anything
 * — destructive to the session's own state, but still closed-world.
 */
export const SESSION_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

/**
 * Signs and/or publishes a Nostr event to relays: mutates the open world
 * (the relay network), not just this session.
 */
export const PUBLISHER: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};
