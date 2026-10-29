import { describe, it, expect } from 'vitest';
import {
  transformContentEvent,
  transformContentEvents,
} from '../../src/content/transform.js';
import type { NostrEvent } from 'nostr-tools';

function evt(kind: number, tags: string[][], content = ''): NostrEvent {
  return {
    id: `id-${kind}`,
    pubkey: 'a'.repeat(64),
    created_at: 1700000000,
    kind,
    tags,
    content,
    sig: 'sig',
  };
}

describe('transformContentEvent — article (30023)', () => {
  it('projects title, summary, topics, publishedAt, image and an excerpt', () => {
    const e = evt(
      30023,
      [
        ['d', 'attention-1'],
        ['title', 'Aufmerksamkeit im Seminar'],
        ['summary', 'Tipps gegen Unaufmerksamkeit'],
        ['image', 'https://example.org/a.png'],
        ['published_at', '1699990000'],
        ['t', 'didaktik'],
        ['t', 'hochschule'],
      ],
      'Studien zeigen, dass die Aufmerksamkeit alle 10-15 Minuten nachlässt.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('article');
    expect(r!.kind).toBe(30023);
    expect(r!.title).toBe('Aufmerksamkeit im Seminar');
    expect((r as any).summary).toBe('Tipps gegen Unaufmerksamkeit');
    expect((r as any).image).toBe('https://example.org/a.png');
    expect((r as any).publishedAt).toBe(1699990000);
    expect((r as any).topics).toEqual(['didaktik', 'hochschule']);
    expect((r as any).excerpt).toContain('Aufmerksamkeit');
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
    expect(r!.eventAuthor.npub).toMatch(/^npub1/);
    expect(r!.createdAt).toBe(1700000000);
  });

  it('returns null when title is missing', () => {
    expect(transformContentEvent(evt(30023, [['d', 'x']]), 'de')).toBeNull();
  });
});

describe('transformContentEvent — wiki (30818)', () => {
  it('projects title, summary and excerpt from Djot content', () => {
    const e = evt(
      30818,
      [
        ['d', 'seminar'],
        ['title', 'Seminar'],
        ['summary', 'Lehrformat'],
        ['t', 'lehre'],
      ],
      'Ein Seminar ist eine Lehrveranstaltung.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('wiki');
    expect(r!.kind).toBe(30818);
    expect(r!.title).toBe('Seminar');
    expect((r as any).summary).toBe('Lehrformat');
    expect((r as any).topics).toEqual(['lehre']);
    expect((r as any).excerpt).toContain('Lehrveranstaltung');
  });

  it('returns null when d tag is missing', () => {
    expect(transformContentEvent(evt(30818, [['title', 'No d']]), 'de')).toBeNull();
  });

  it('falls back to summary when title tag is absent', () => {
    const e = evt(
      30818,
      [
        ['d', 'titleless-wiki'],
        ['summary', 'A fallback summary'],
      ],
      'Some wiki content.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('wiki');
    expect(r!.title).toBe('A fallback summary');
  });

  it('falls back to d-tag value when both title and summary are absent', () => {
    const e = evt(
      30818,
      [['d', 'd-only-wiki']],
      'Content without title or summary.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('wiki');
    expect(r!.title).toBe('d-only-wiki');
  });

  it('sets eventAuthor.npub for a wiki', () => {
    const r = transformContentEvent(evt(30818, [['d', 'w'], ['title', 'W']], 'body'), 'de');
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
    expect(r!.eventAuthor.npub).toMatch(/^npub1/);
  });
});

describe('transformContentEvent — resource (30142)', () => {
  it('projects an AMB resource into a resource result', () => {
    const e = evt(30142, [
      ['d', 'res-1'],
      ['name', 'Mathe Video'],
      ['description', 'Ein Video'],
      ['about:id', 'https://w3id.org/kim/schulfaecher/s1017'],
    ]);
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('resource');
    expect(r!.kind).toBe(30142);
    expect(r!.title).toBe('Mathe Video');
    expect((r as any).description).toBe('Ein Video');
  });

  it('surfaces the http d-tag id as sourcePage (direct source link)', () => {
    const e = evt(30142, [
      ['d', 'https://www.e-teaching.org/praxis/foo'],
      ['name', 'Ein Erfahrungsbericht'],
    ]);
    expect((transformContentEvent(e, 'de') as any).sourcePage).toBe(
      'https://www.e-teaching.org/praxis/foo'
    );
  });

  it('surfaces the r-tag as sourcePage when the d-tag id is a bare UUID', () => {
    const e = evt(30142, [
      ['d', '46d54fe5-21b2-41d3-8253-f8824f025864'],
      ['name', 'UUID-identified resource'],
      ['r', 'https://www.e-teaching.org/praxis/foo'],
    ]);
    expect((transformContentEvent(e, 'de') as any).sourcePage).toBe(
      'https://www.e-teaching.org/praxis/foo'
    );
  });

  it('leaves sourcePage undefined when the resource id is not a URL and no r tag', () => {
    const e = evt(30142, [
      ['d', '46d54fe5-21b2-41d3-8253-f8824f025864'],
      ['name', 'UUID-identified resource'],
    ]);
    expect((transformContentEvent(e, 'de') as any).sourcePage).toBeUndefined();
  });

  it('surfaces resource publisher/creator distinct from the event signer', () => {
    const e = evt(30142, [
      ['d', 'res-2'],
      ['name', 'Friedensbildung in Schule und Gemeinde'],
      ['publisher:name', 'ptz Stuttgart'],
      ['publisher:type', 'Organization'],
    ]);
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('resource');
    expect((r as any).publisher).toEqual([{ name: 'ptz Stuttgart', type: 'Organization' }]);
    // No creator tags → empty array (mirrors get_resource output).
    expect((r as any).creator).toEqual([]);
    // The event signer is the uploader, NOT the publisher.
    expect(r!.eventAuthor.pubkey).toBe('a'.repeat(64));
  });
});

describe('transformContentEvent — transferkiosk (30143/30144)', () => {
  it('projects a Projekt (30143): title from name, description, excerpt', () => {
    const e = evt(
      30143,
      [
        ['d', 'https://transferkiosk.net/p/101323'],
        ['type', 'ResearchProject'],
        ['name', 'Studentische Partizipation an der Hochschule'],
        ['description', 'Ein Projekt zur Förderung studentischer Beteiligung'],
      ],
      'Im Projektzeitraum wurden verschiedene Beteiligungsformate entwickelt.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r).not.toBeNull();
    expect(r!.type).toBe('project');
    expect(r!.kind).toBe(30143);
    expect(r!.title).toBe('Studentische Partizipation an der Hochschule');
    expect((r as any).description).toBe('Ein Projekt zur Förderung studentischer Beteiligung');
    expect((r as any).excerpt).toContain('Beteiligungsformate');
    // A root project carries no partOf link.
    expect((r as any).partOf).toBeUndefined();
    expect(r!.eventAuthor.npub).toMatch(/^npub1/);
  });

  it('projects a Maßnahme (30144) with its parent project coord in partOf', () => {
    const e = evt(
      30144,
      [
        ['d', 'https://transferkiosk.net/p/101323/act/100262'],
        ['type', 'TeachingMeasure'],
        ['name', 'Beteiligungsformate für studentische Partizipation'],
        ['description', 'Verschiedene Beteiligungsformate wurden erprobt.'],
        ['summary', 'Formate zur studentischen Beteiligung'],
        [
          'a',
          '30143:d2689e2f41dabfba953da26655a94ce2aa4e029c383ee921c6a4deafab99a612:https://transferkiosk.net/p/101323',
          'wss://relay.edufeed.org',
          'isPartOf',
        ],
      ],
      'Die Formate reichten von niedrigschwelligen Möglichkeiten bis zu Veranstaltungen.'
    );
    const r = transformContentEvent(e, 'de');
    expect(r!.type).toBe('measure');
    expect(r!.kind).toBe(30144);
    expect(r!.title).toBe('Beteiligungsformate für studentische Partizipation');
    expect((r as any).summary).toBe('Formate zur studentischen Beteiligung');
    expect((r as any).partOf).toBe(
      '30143:d2689e2f41dabfba953da26655a94ce2aa4e029c383ee921c6a4deafab99a612:https://transferkiosk.net/p/101323'
    );
  });

  it('exposes sourcePage from the r tag', () => {
    const e = evt(30143, [
      ['d', 'https://transferkiosk.net/p/101472'],
      ['name', 'VISITKO'],
      ['r', 'https://transferkiosk.net/p/101472'],
    ]);
    expect((transformContentEvent(e, 'de') as any).sourcePage).toBe(
      'https://transferkiosk.net/p/101472'
    );
  });

  it('falls back to an http-shaped d tag for sourcePage when r is absent', () => {
    const e = evt(30144, [
      ['d', 'https://transferkiosk.net/p/101816/act/100028'],
      ['name', 'Selbstlerntool R'],
    ]);
    expect((transformContentEvent(e, 'de') as any).sourcePage).toBe(
      'https://transferkiosk.net/p/101816/act/100028'
    );
  });

  it('leaves sourcePage undefined when there is no r tag and d is not a URL', () => {
    const e = evt(30143, [
      ['d', 'local-project-42'],
      ['name', 'Non-URL identifier'],
    ]);
    expect((transformContentEvent(e, 'de') as any).sourcePage).toBeUndefined();
  });

  it('returns null when the name tag is missing (relay requires d + name)', () => {
    expect(
      transformContentEvent(evt(30144, [['d', 'no-name']]), 'de')
    ).toBeNull();
  });

  it('returns null when the d tag is missing', () => {
    expect(
      transformContentEvent(evt(30143, [['name', 'No d tag']]), 'de')
    ).toBeNull();
  });
});

describe('transformContentEvent — unknown kind', () => {
  it('returns null for an unregistered kind', () => {
    expect(transformContentEvent(evt(1, [['d', 'x']]), 'de')).toBeNull();
  });
});

describe('transformContentEvents', () => {
  it('skips nulls and preserves order', () => {
    const ok = evt(30023, [['d', 'a'], ['title', 'A']], 'body');
    const bad = evt(30023, [['d', 'b']]); // no title
    const results = transformContentEvents([ok, bad], 'de');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('A');
  });
});

describe('excerpt capping', () => {
  it('caps long content and appends an ellipsis', () => {
    const long = 'x'.repeat(500);
    const r = transformContentEvent(evt(30023, [['d', 'l'], ['title', 'L']], long), 'de');
    const ex = (r as any).excerpt as string;
    expect(ex.length).toBeLessThanOrEqual(301);
    expect(ex.endsWith('…')).toBe(true);
  });
});

describe('publicationToContentResult (NKBIP-01 30040/30041)', () => {
  const hex64 = 'ab'.repeat(32);

  it('projects a migrated transferkiosk-shape 30040', () => {
    const e = evt(30040, [
      ['d', 'tk-p101658-pub100021'],
      ['title', 'Die Materialität analog-digitaler Schnittstellen'],
      ['type', 'academic'],
      ['additionalType', 'ScholarlyArticle'],
      ['summary', 'Usability-Testung Stift-basierter Eingabegeräte.'],
      ['author', 'Nadine Hahm'],
      ['author', 'Andreas Thor'],
      ['creator:type', 'Person'],
      ['creator:name', 'Nadine Hahm'],
      ['i', 'doi:10.25673/103431.2'],
      ['source', 'https://transferkiosk.net/p/101658/pub/1'],
      ['published_on', '2023-01-01'],
      ['published_by', 'Open Access Publikation'],
      ['inLanguage', 'de'],
      ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
      ['a', '30143:' + hex64 + ':https://transferkiosk.net/p/101658', 'wss://r', 'isOutputOf'],
      ['a', '39738:' + hex64 + ':tk-publikationsart/100009', 'wss://r', 'publicationType'],
    ]);
    const r = transformContentEvent(e)!;
    expect(r.type).toBe('publication');
    if (r.type !== 'publication') return;
    expect(r.kind).toBe(30040);
    expect(r.title).toBe('Die Materialität analog-digitaler Schnittstellen');
    expect(r.summary).toContain('Usability');
    expect(r.authors).toEqual(['Nadine Hahm', 'Andreas Thor']);
    expect(r.doi).toBe('10.25673/103431.2');
    expect(r.identifier).toBe('doi:10.25673/103431.2');
    expect(r.publicationType).toBe('academic');
    expect(r.additionalType).toBe('ScholarlyArticle');
    expect(r.publishedOn).toBe('2023-01-01');
    expect(r.publishedBy).toBe('Open Access Publikation');
    expect(r.sourcePage).toBe('https://transferkiosk.net/p/101658/pub/1');
    expect(r.language).toBe('de');
    expect(r.license).toBe('https://creativecommons.org/licenses/by/4.0/');
    // isOutputOf → partOf; vocab word marker → neither facet
    expect(r.partOf).toEqual(['30143:' + hex64 + ':https://transferkiosk.net/p/101658']);
    expect(r.sections).toBeUndefined();
    expect(r.naddr).toBeTruthy();
  });

  it('falls back to the plain license tag (amb-indexer parity: worker.go readLicenseTag)', () => {
    const e = evt(30040, [
      ['d', 'tk-p101658-pub100021'],
      ['title', 'Paper'],
      ['license', 'https://creativecommons.org/licenses/by/4.0/'],
    ]);
    const r = transformContentEvent(e)!;
    if (r.type !== 'publication') throw new Error('wrong type');
    expect(r.license).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('prefers license:id over license when both are present', () => {
    const e = evt(30040, [
      ['d', 'tk-p101658-pub100021'],
      ['title', 'Paper'],
      ['license', 'https://creativecommons.org/licenses/by-nc/4.0/'],
      ['license:id', 'https://creativecommons.org/licenses/by/4.0/'],
    ]);
    const r = transformContentEvent(e)!;
    if (r.type !== 'publication') throw new Error('wrong type');
    expect(r.license).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('projects a wild Alexandria-shape 30040 (bare + event-id-hinted sections)', () => {
    const e = evt(30040, [
      ['d', 'aesops-fables'],
      ['title', "Aesop's Fables"],
      ['author', 'Aesop'],
      ['i', 'isbn:9780765382030'],
      ['a', '30041:' + hex64 + ':chapter-1', 'wss://r'],
      ['a', '30041:' + hex64 + ':chapter-2', 'wss://r', hex64],
    ]);
    const r = transformContentEvent(e)!;
    if (r.type !== 'publication') throw new Error('wrong type');
    expect(r.doi).toBeUndefined();
    expect(r.identifier).toBe('isbn:9780765382030');
    expect(r.sections).toEqual([
      '30041:' + hex64 + ':chapter-1',
      '30041:' + hex64 + ':chapter-2',
    ]);
    expect(r.partOf).toBeUndefined();
  });

  it('projects a 30041 section with a body excerpt', () => {
    const e = evt(
      30041,
      [['d', 'chapter-1'], ['title', 'The Farmer and The Snake']],
      'ONE WINTER a Farmer found a Snake stiff and frozen with cold.'
    );
    const r = transformContentEvent(e)!;
    if (r.type !== 'publication') throw new Error('wrong type');
    expect(r.kind).toBe(30041);
    expect(r.excerpt).toContain('ONE WINTER a Farmer');
    expect(r.summary).toBeUndefined();
  });

  it('no longer transforms kind 30145 (retired)', () => {
    const e = evt(30145, [['d', 'x'], ['name', 'Old Pub']]);
    expect(transformContentEvent(e)).toBeNull();
  });
});
