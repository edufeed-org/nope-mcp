import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import * as CFB from 'cfb';
import { detectDocument, extractDocumentText } from '../../src/lib/docExtractor.js';

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
