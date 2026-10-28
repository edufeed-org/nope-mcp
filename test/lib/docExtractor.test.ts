import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import * as CFB from 'cfb';
import { detectDocument, extractDocumentText, extractDocument, MAX_PART_BYTES } from '../../src/lib/docExtractor.js';
import { existsSync, readFileSync } from 'node:fs';

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const zip = (files: Record<string, string>) => buf(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

const docx = zip({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="x" xmlns:wp14="y"><w:body><w:p w:rsidR="00A"><w:r><w:t>Zach&#228;us auf dem Baum.</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:anchor><wp:positionH><wp:posOffset>4358005</wp:posOffset></wp:positionH><wp14:pctPosVOffset>00</wp14:pctPosVOffset><wp:align>right</wp:align><wp14:sizeRelH relativeFrom="margin"><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp:docPr id="1" name="Bild 1" descr="Baum"/></wp:anchor></w:drawing></w:r><w:r><w:t xml:space="preserve">Arbeitsblatt </w:t></w:r><w:r><w:t>Klasse 3</w:t></w:r></w:p></w:body></w:document>'
});
const pptx = zip({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
  'ppt/slides/slide10.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Zehnte Folie</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Zweite Folie</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide1.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Jesus und Zach&#228;us</a:t></a:r></a:p><a:p><a:r><a:t>Lk 19,1-10</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide3.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="x"><a:p><a:r><a:t>Dritte Folie</a:t></a:r></a:p><p:timing><p:tnLst><p:par><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:par></p:tnLst></p:timing><p:extLst><p:ext uri="{BB962C8B}"><p14:creationId val="123"/>456</p:ext></p:extLst></p:sld>',
  'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Notiz zur Folie</a:t></a:r></a:p></p:notes>'
});
const xlsx = zip({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2"><si><t>Name</t></si><si><r><rPr><b/></rPr><t>Klasse</t></r></si><extLst>999</extLst></sst>'
});
const odt = zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h>Erz&#228;hlvorlage</text:h><text:p>Zach&#228;us<text:tab/>Lk 19</text:p></office:text></office:body></office:document-content>' });
const odp = zip({ mimetype: 'application/vnd.oasis.opendocument.presentation', 'content.xml': '<office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>Folie eins</text:p></office:document-content>' });
const ods = zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': '<office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>Zelle A1</text:p></office:document-content>' });
const plainZip = zip({ 'readme.txt': 'not an office document' });

function olePpt(texts: string[]): ArrayBuffer {
  // Minimal "PowerPoint Document" stream: one container holding TextCharsAtom records.
  const atoms = texts.map((t) => {
    const body = Buffer.from(t, 'utf16le');
    const h = Buffer.alloc(8);
    h.writeUInt16LE(0, 0); h.writeUInt16LE(0x0fa0, 2); h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
  });
  const inner = Buffer.concat(atoms);
  const ch = Buffer.alloc(8);
  ch.writeUInt16LE(0x0f, 0); ch.writeUInt16LE(0x03e8, 2); ch.writeUInt32LE(inner.length, 4); // Document container
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/PowerPoint Document', Buffer.concat([ch, inner]));
  const out = CFB.write(cfb, { type: 'buffer' }) as Buffer;
  return buf(new Uint8Array(out));
}
const oleDoc = (): ArrayBuffer => {
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/WordDocument', Buffer.alloc(64));
  return buf(new Uint8Array(CFB.write(cfb, { type: 'buffer' }) as Buffer));
};

describe('detectDocument — by magic bytes and container contents, never by extension alone', () => {
  it.each([
    ['docx', docx], ['pptx', pptx], ['xlsx', xlsx], ['odt', odt], ['odp', odp], ['ods', ods]
  ] as const)('detects %s', (kind, b) => {
    expect(detectDocument(b, { mime: 'application/octet-stream', url: 'https://x/file.PPT' })).toBe(kind);
  });
  it('detects legacy binary ppt and doc from the OLE stream names', () => {
    expect(detectDocument(olePpt(['x']), { mime: '', url: 'https://x/a' })).toBe('ppt');
    expect(detectDocument(oleDoc(), { mime: 'application/msword', url: 'https://x/a' })).toBe('doc');
  });
  it('returns undefined for zips that are not documents, images and html', () => {
    expect(detectDocument(plainZip, { mime: 'application/zip', url: 'https://x/a.zip' })).toBeUndefined();
    expect(detectDocument(buf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), { mime: 'image/png', url: 'https://x/a.png' })).toBeUndefined();
    expect(detectDocument(buf(strToU8('<html></html>')), { mime: 'text/html', url: 'https://x/' })).toBeUndefined();
  });
});

describe('extractDocumentText', () => {
  it('docx: paragraphs on their own lines, entities decoded, runs joined', async () => {
    expect(await extractDocumentText(docx, 'docx')).toBe('Zachäus auf dem Baum.\nArbeitsblatt Klasse 3');
  });
  it('pptx: slides in numeric order, notes after the slides, no animation attribute names', async () => {
    const t = await extractDocumentText(pptx, 'pptx');
    expect(t).not.toContain('style.visibility');
    expect(t).not.toContain('456');
    expect(t).toContain('Dritte Folie');
    expect(t.indexOf('Jesus und Zachäus')).toBeLessThan(t.indexOf('Zweite Folie'));
    expect(t.indexOf('Zweite Folie')).toBeLessThan(t.indexOf('Zehnte Folie'));
    expect(t.indexOf('Zehnte Folie')).toBeLessThan(t.indexOf('Notiz zur Folie'));
    expect(t).toContain('Lk 19,1-10');
  });
  it('xlsx: shared strings', async () => {
    expect(await extractDocumentText(xlsx, 'xlsx')).toBe('Name\nKlasse');
  });
  it('odt/odp/ods: text of content.xml with tabs and headings', async () => {
    expect(await extractDocumentText(odt, 'odt')).toBe('Erzählvorlage\nZachäus\tLk 19');
    expect(await extractDocumentText(odp, 'odp')).toBe('Folie eins');
    expect(await extractDocumentText(ods, 'ods')).toBe('Zelle A1');
  });
  it('ppt (legacy binary): text atoms from the PowerPoint Document stream', async () => {
    expect(await extractDocumentText(olePpt(['Jesus beruft Simon', 'Folie 2']), 'ppt')).toBe('Jesus beruft Simon\nFolie 2');
  });
});

describe('extractDocumentText — hostile and odd input', () => {
  const slide = (body: string) => zip({ 'ppt/slides/slide1.xml': `<p:sld xmlns:a="x" xmlns:p="y">${body}</p:sld>` });

  it('empty text elements never swallow the following markup', async () => {
    const t = await extractDocumentText(slide('<p:sp><a:p><a:r><a:rPr lang="de-DE"/><a:t/></a:r></a:p></p:sp><p:sp><a:p><a:r><a:t>Titel</a:t></a:r></a:p></p:sp>'), 'pptx');
    expect(t).toBe('Titel');
    const d = await extractDocumentText(zip({ 'word/document.xml': '<w:document xmlns:w="x"><w:p><w:r><w:t/></w:r></w:p><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:document>' }), 'docx');
    expect(d).toBe('Text');
    const x = await extractDocumentText(zip({ 'xl/sharedStrings.xml': '<sst><si><t/></si><si><t>Zelle</t></si></sst>' }), 'xlsx');
    expect(x).toBe('Zelle');
  });

  it('thousands of unclosed text openers finish quickly (linear matching)', async () => {
    const body = '<w:p>' + '<w:t>'.repeat(20000) + 'x'.repeat(2_000_000) + '</w:p>';
    const b = zip({ 'word/document.xml': `<w:document xmlns:w="x">${body}</w:document>` });
    const t0 = Date.now();
    await extractDocumentText(b, 'docx');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('refuses a part that would inflate beyond the per-part cap (zip bomb) as page_too_large', async () => {
    const huge = 'A'.repeat(MAX_PART_BYTES + 1024);
    const b = zip({ 'word/document.xml': `<w:document xmlns:w="x"><w:p><w:r><w:t>${huge}</w:t></w:r></w:p></w:document>` });
    await expect(extractDocumentText(b, 'docx')).rejects.toMatchObject({ code: 'page_too_large' });
  });

  it('a corrupt deflate stream surfaces as unsupported_type from extractDocument', async () => {
    // Long repetitive text so the part is actually deflated, then damage the
    // compressed bytes right after that entry's local header.
    const body = '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>' + 'Zachäus auf dem Baum. '.repeat(400) + '</w:t></w:r></w:p></w:body></w:document>';
    const z = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(body) }, { level: 6 });
    const u = new Uint8Array(z);
    const name = strToU8('word/document.xml');
    let at = -1;
    for (let i = 0; i < u.length - name.length && at < 0; i++) {
      if (u[i] === 0x50 && u[i + 1] === 0x4b && u[i + 2] === 0x03 && u[i + 3] === 0x04 && name.every((b, k) => u[i + 30 + k] === b)) at = i + 30 + name.length;
    }
    expect(at).toBeGreaterThan(0);
    for (let i = at + 8; i < at + 48; i++) u[i] ^= 0xff;
    await expect(extractDocument(buf(u), { mime: '', url: 'https://x/corrupt.docx' })).rejects.toMatchObject({ code: 'unsupported_type' });
  });

  it('a truncated zip is not detected as a document', () => {
    const u = new Uint8Array(docx.slice(0, 60));
    expect(detectDocument(buf(u), { mime: '', url: 'https://x/t.docx' })).toBeUndefined();
  });

  it('decodes cp1252 punctuation in legacy TextBytesAtom records', async () => {
    const bytes = Buffer.from([0x84, 0x41, 0x93, 0x20, 0x96, 0x20, 0x80]); // „A“ – €
    const h = Buffer.alloc(8); h.writeUInt16LE(0, 0); h.writeUInt16LE(0x0fa8, 2); h.writeUInt32LE(bytes.length, 4);
    const inner = Buffer.concat([h, bytes]);
    const ch = Buffer.alloc(8); ch.writeUInt16LE(0x0f, 0); ch.writeUInt16LE(0x03e8, 2); ch.writeUInt32LE(inner.length, 4);
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, '/PowerPoint Document', Buffer.concat([ch, inner]));
    const b = buf(new Uint8Array(CFB.write(cfb, { type: 'buffer' }) as Buffer));
    expect(await extractDocumentText(b, 'ppt')).toBe('„A“ – €');
  });

  it('keeps out-of-range or invalid numeric entities literally instead of throwing', async () => {
    const t = await extractDocumentText(zip({ 'word/document.xml': '<w:document xmlns:w="x"><w:p><w:r><w:t>a&#x110000;b&#99999999999;c&#xD800;d</w:t></w:r></w:p></w:document>' }), 'docx');
    expect(t).toBe('a&#x110000;b&#99999999999;c&#xD800;d');
  });

  it('drops ODF annotations and tracked changes', async () => {
    const content = '<office:document-content xmlns:text="t" xmlns:office="o" xmlns:dc="d"><office:body><office:text><text:tracked-changes><text:changed-region><text:deletion><text:p>alt</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>Vor<office:annotation><dc:creator>Autor</dc:creator><dc:date>2024-01-01T00:00:00</dc:date><text:p>Kommentar</text:p></office:annotation>nach</text:p></office:text></office:body></office:document-content>';
    expect(await extractDocumentText(zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': content }), 'odt')).toBe('Vornach');
  });

  it('survives deeply nested legacy ppt containers without a stack overflow', async () => {
    let inner = Buffer.alloc(0);
    for (let i = 0; i < 20000; i++) {
      const ch = Buffer.alloc(8); ch.writeUInt16LE(0x0f, 0); ch.writeUInt16LE(0x03e8, 2); ch.writeUInt32LE(inner.length, 4);
      inner = Buffer.concat([ch, inner]);
    }
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, '/PowerPoint Document', inner);
    const b = buf(new Uint8Array(CFB.write(cfb, { type: 'buffer' }) as Buffer));
    expect(await extractDocumentText(b, 'ppt')).toBe('');
  });

  const DOC_FIXTURE = process.env.NOPE_MCP_DOC_FIXTURE;
  it.skipIf(!DOC_FIXTURE || !existsSync(DOC_FIXTURE))('extracts a real legacy .doc (NOPE_MCP_DOC_FIXTURE)', async () => {
    const b = readFileSync(DOC_FIXTURE!);
    const r = await extractDocument(buf(new Uint8Array(b)), { mime: 'application/msword', url: 'https://x/a.doc' });
    expect(r?.kind).toBe('doc');
    expect((r?.text ?? '').length).toBeGreaterThan(100);
  });
});

