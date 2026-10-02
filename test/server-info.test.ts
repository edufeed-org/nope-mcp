import { describe, it, expect } from 'vitest';

import { buildServerInstructions } from '../src/server-info.js';

describe('buildServerInstructions', () => {
  it('opens with an English paragraph describing nope-mcp, not the old relay-first phrasing', () => {
    const text = buildServerInstructions({ openLicensesOnly: true });
    expect(text.startsWith('nope-mcp is a search gateway')).toBe(true);
    expect(text).not.toMatch(/^This server is the gateway to the AMB educational-metadata relays/);
    expect(text).not.toMatch(/^AMB educational-metadata relays/);
  });

  it('mentions corpus order of magnitude without a number that will go stale', () => {
    const text = buildServerInstructions({ openLicensesOnly: true });
    expect(text).toMatch(/thousands of learning resources/);
    expect(text).toMatch(/100,000/);
  });

  it('mentions the two main flows (browse vs. cited answer from fulltext)', () => {
    const text = buildServerInstructions({ openLicensesOnly: true });
    expect(text).toMatch(/finding materials to browse/);
    expect(text).toMatch(/citations drawn from resources' fulltext/);
  });

  it('states the open-license policy when OPEN_LICENSES_ONLY is on', () => {
    const text = buildServerInstructions({ openLicensesOnly: true });
    expect(text).toMatch(/limited to open licenses \(CC0, the Public Domain Mark, CC BY, CC BY-SA\)/);
  });

  it('omits the open-license claim when OPEN_LICENSES_ONLY is off', () => {
    const text = buildServerInstructions({ openLicensesOnly: false });
    expect(text).not.toMatch(/limited to open licenses/);
    expect(text).not.toMatch(/CC BY-SA/);
  });

  it('keeps the German routing examples and intent-routing guidance after the English opening', () => {
    const text = buildServerInstructions({ openLicensesOnly: true });
    expect(text).toMatch(/Jörg Lohrer/);
    expect(text).toMatch(/wie kann ich Studierende aktivieren/);
    expect(text).toMatch(/Route by INTENT before picking a search tool/);
    expect(text).toMatch(/LEHRE LADEN/);
  });

  it('is a pure function of openLicensesOnly (same input, same output)', () => {
    expect(buildServerInstructions({ openLicensesOnly: true })).toBe(
      buildServerInstructions({ openLicensesOnly: true })
    );
    expect(buildServerInstructions({ openLicensesOnly: false })).toBe(
      buildServerInstructions({ openLicensesOnly: false })
    );
  });
});
