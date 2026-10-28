import { describe, it, expect } from 'vitest';

import { buildServerInstructions, snippetOnlyReason } from '../src/server-info.js';

describe('buildServerInstructions', () => {
  it('opens with an English paragraph describing nope-mcp, not the old relay-first phrasing', () => {
    const text = buildServerInstructions({ licenseFilterMax: 'open' });
    expect(text.startsWith('nope-mcp is a search gateway')).toBe(true);
    expect(text).not.toMatch(/^This server is the gateway to the AMB educational-metadata relays/);
    expect(text).not.toMatch(/^AMB educational-metadata relays/);
  });

  it('mentions corpus order of magnitude without a number that will go stale', () => {
    const text = buildServerInstructions({ licenseFilterMax: 'open' });
    expect(text).toMatch(/thousands of learning resources/);
    expect(text).toMatch(/100,000/);
  });

  it('mentions the two main flows (browse vs. cited answer from fulltext)', () => {
    const text = buildServerInstructions({ licenseFilterMax: 'open' });
    expect(text).toMatch(/finding materials to browse/);
    expect(text).toMatch(/citations drawn from resources' fulltext/);
  });

  it('always states the two-tier license policy (license/accessLevel/licenseFilter)', () => {
    const open = buildServerInstructions({ licenseFilterMax: 'open' });
    const any = buildServerInstructions({ licenseFilterMax: 'any' });
    for (const text of [open, any]) {
      expect(text).not.toMatch(/limited to open licenses/);
      expect(text).toMatch(/accessLevel \("full" for Creative Commons and Public Domain licenses, "metadata-only"/);
      expect(text).toMatch(/licenseFilter narrows search_resources, search_content and search_passages/);
    }
  });

  it('states the operator ceiling only when licenseFilterMax is below any', () => {
    const open = buildServerInstructions({ licenseFilterMax: 'open' });
    expect(open).toMatch(/caps every search tool's licenseFilter at 'open'/);

    const any = buildServerInstructions({ licenseFilterMax: 'any' });
    expect(any).not.toMatch(/caps every search tool's licenseFilter/);
  });

  it('lists every unfiltered content kind alongside learning resources', () => {
    const text = buildServerInstructions({ licenseFilterMax: 'open' });
    expect(text).toMatch(
      /articles, wikis, publications, projects, measures and calendar events carry no license filter/
    );
  });

  it.each(['open', 'cc-any', 'any'] as const)(
    'says a snippet-only passage simply has no fulltext yet and points to metadataOnlyMatches (%s)',
    (licenseFilterMax) => {
      const text = buildServerInstructions({ licenseFilterMax });
      expect(text).toMatch(/A passage with a snippet but no text has no fulltext yet; say so\./);
      expect(text).not.toMatch(/license-gated/);
      expect(text).toMatch(/metadataOnlyMatches, without text/);
    }
  );

  it('keeps the German routing examples and intent-routing guidance after the English opening', () => {
    const text = buildServerInstructions({ licenseFilterMax: 'open' });
    expect(text).toMatch(/Jörg Lohrer/);
    expect(text).toMatch(/wie kann ich Studierende aktivieren/);
    expect(text).toMatch(/Route by INTENT before picking a search tool/);
    expect(text).toMatch(/LEHRE LADEN/);
  });

  it('is a pure function of licenseFilterMax (same input, same output)', () => {
    expect(buildServerInstructions({ licenseFilterMax: 'open' })).toBe(
      buildServerInstructions({ licenseFilterMax: 'open' })
    );
    expect(buildServerInstructions({ licenseFilterMax: 'any' })).toBe(
      buildServerInstructions({ licenseFilterMax: 'any' })
    );
  });
});

describe('snippetOnlyReason', () => {
  it('only names missing fulltext, since unquotable resources never become passages', () => {
    expect(snippetOnlyReason()).toBe('has no fulltext yet');
  });
});
