#!/usr/bin/env bun
/**
 * Manual live-ranking eval (not CI). Runs the five brief queries through
 * search_content over amb-relay + oersi + sodix, and find_community for two
 * topics if COMMUNITY_RELAYS is set.
 *
 * Usage:
 *   AMB_RELAYS=wss://amb-relay.edufeed.org AMB_EXTRA_RELAYS=wss://oersi.edufeed.org,wss://sodix.edufeed.org \
 *   COMMUNITY_RELAYS=wss://relay.edufeed.org \
 *   bun run scripts/rank-eval.ts
 */

import { AMBRelayClient } from '../src/relay/client.js';
import { runContentSearch } from '../src/tools/searchContent.js';
import { findCommunities } from '../src/tools/findCommunity.js';

const AMB_RELAYS = process.env.AMB_RELAYS?.split(',').filter(Boolean) || ['wss://amb-relay.edufeed.org'];
const AMB_EXTRA_RELAYS = process.env.AMB_EXTRA_RELAYS?.split(',').filter(Boolean) || [];
const COMMUNITY_RELAYS = process.env.COMMUNITY_RELAYS?.split(',').filter(Boolean);

const QUERIES = [
  'Statistik Vorkurs',
  'Unterrichtsentwurf Nachhaltigkeit',
  'OER Lizenzen Creative Commons',
  'Unaufmerksamkeit Studierende Seminar',
  'gendersensibler Unterricht',
];

function short(s: string | undefined, n = 80): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function main() {
  console.log(`AMB relays: ${AMB_RELAYS.join(', ')}`);
  if (AMB_EXTRA_RELAYS.length) console.log(`AMB extra relays: ${AMB_EXTRA_RELAYS.join(', ')}`);
  const client = new AMBRelayClient(AMB_RELAYS, { extraRelays: AMB_EXTRA_RELAYS });
  const searchRelays = [...AMB_RELAYS, ...AMB_EXTRA_RELAYS];

  for (const query of QUERIES) {
    console.log(`\n=== search_content: "${query}" ===`);
    const result = await runContentSearch(client, { query, limit: 5, relays: searchRelays });
    console.log(`total=${result.total}`);
    for (const r of result.results) {
      const score = r.score !== undefined ? r.score.toFixed(3) : '  -  ';
      const lexical = r.lexical !== undefined ? r.lexical.toFixed(3) : '  -  ';
      console.log(`  ${short(r.title, 60).padEnd(62)} | ${(r.relay ?? '-').padEnd(28)} | score=${score} | lexical=${lexical}`);
    }
  }

  client.close();

  if (COMMUNITY_RELAYS?.length) {
    console.log(`\nCommunity relays: ${COMMUNITY_RELAYS.join(', ')}`);
    const communityClient = new AMBRelayClient(COMMUNITY_RELAYS);
    for (const query of ['e-teaching', 'Religion']) {
      console.log(`\n=== find_community: "${query}" ===`);
      const result = await findCommunities(communityClient, { query, limit: 5 });
      console.log(`total=${result.total}`);
      for (const c of result.communities) {
        console.log(`  ${short(c.name, 40).padEnd(42)} | ${short(c.description, 60)}`);
      }
    }
    communityClient.close();
  } else {
    console.log('\nCOMMUNITY_RELAYS not set — skipping find_community.');
  }
}

main().catch((e) => {
  console.error('EVAL FAILED:', e);
  process.exit(1);
});
