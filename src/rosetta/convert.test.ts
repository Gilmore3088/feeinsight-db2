import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  convertSource, htmlToVisibleText, decodeEntities, isThin, isGarbled, sniffKind,
  FormatMismatchError, ConvertError, CONVERTER_VERSION,
} from './convert.ts';
import { makePdf } from './fixtures/make-pdf.ts';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);
const tmp = mkdtempSync(join(tmpdir(), 'rosetta-'));
const write = (name: string, body: string | Buffer) => {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
};

// Three pages: a fee table beside two columns of prose, a page with only a page number,
// and a page whose text layer is broken.
const left = ['Overdraft fees are charged', 'for each item presented', 'against the account.'];
const right = ['Wire transfers sent after', 'the daily cutoff are', 'processed the next day.'];
const pdfPath = write('sample.pdf', makePdf([
  [
    { x: 72, y: 740, text: 'Schedule of Fees' },
    { x: 72, y: 700, text: 'Stop payment order' }, { x: 420, y: 700, text: '$30.00' },
    { x: 72, y: 686, text: 'Cashier check (each)' }, { x: 420, y: 686, text: '$8.00' },
    ...left.map((text, i) => ({ x: 72, y: 600 - 12 * i, text })),
    ...right.map((text, i) => ({ x: 330, y: 600 - 12 * i, text })),
  ],
  [{ x: 300, y: 40, text: '2' }],
  [{ x: 72, y: 700, text: 'Monthly service charge for this account', garbled: true }],
]));

const tables = convertSource({ filePath: fixture('tables.html'), format: 'web_page', sourceDocumentId: 7 });
const tableLines = tables.pages[0].text.split('\n');
const tabs = convertSource({ filePath: fixture('tabs.html'), format: 'tabbed_page' });
const tabLines = tabs.pages[0].text.split('\n');

test('a web page becomes one page of visible text with the record filled in', () => {
  assert.equal(tables.sourceDocumentId, 7);
  assert.equal(tables.format, 'web_page');
  assert.equal(tables.converterVersion, CONVERTER_VERSION);
  assert.match(tables.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(tables.pages.length, 1);
  assert.deepEqual({ ...tables.pages[0], text: '' }, { page: null, method: 'html_visible', text: '', needsImageReading: false });
  assert.equal(tables.needsImageReading, false);
  assert.equal(tables.textChars, tables.pages[0].text.length);
  assert.equal(tabs.sourceDocumentId, null);
});

test('each table row is one line, cells joined by a single space', () => {
  assert.ok(tableLines.includes('Service Fee'));
  assert.ok(tableLines.includes('Stop payment $30.00'));
  assert.ok(tableLines.includes('Everyday services'));
});

test('a paragraph or line break inside a cell does not split the row', () => {
  assert.ok(tableLines.includes('Cashier\u2019s check $8.00 each'));
});

test('inline tags add no space and entities in cells are decoded', () => {
  assert.ok(tableLines.includes('Wire transfer \u2013 outgoing $25.00'));
});

test('rows of a table inside a table each get their own line', () => {
  const at = tableLines.indexOf('Outer cell');
  assert.deepEqual(tableLines.slice(at, at + 4), ['Outer cell', 'Inner fee A $1.00', 'Inner fee B $2.00', 'after inner Outer last']);
});

test('block elements end a line and runs of spaces collapse', () => {
  assert.equal(tableLines[0], 'Schedule of Fees');
  for (const line of ['Paragraph one.', 'Paragraph two has inline words.', 'First item', 'Second item']) {
    assert.ok(tableLines.includes(line), line);
  }
  assert.ok(tableLines.every((l) => l === l.trim() && !/\s\s/.test(l) && l.length > 0));
});

test('text in a hidden tab or closed accordion panel is kept', () => {
  assert.ok(tabLines.includes('Monthly service fee $10.00'));
  assert.ok(tabLines.includes('Excess withdrawal fee $5.00 per item'));
  assert.ok(tabLines.includes('Dormant account fee $3.00 per month'));
});

test('script, style, noscript, template, svg, head and comments are dropped', () => {
  const all = tables.pages[0].text + tabs.pages[0].text;
  for (const gone of ['script text', 'style text', 'noscript text', 'template text', 'svg text', 'comment text',
    'Title in the head', 'color: red', 'margin', 'document.write']) {
    assert.ok(!all.includes(gone), gone);
  }
  assert.ok(tabLines.includes('Last visible line'));
});

test('a script that is never closed swallows the rest, as it does in a browser', () => {
  assert.ok(!tabs.pages[0].text.includes('after an unclosed script'));
  assert.equal(tabLines[tabLines.length - 1], 'Last visible line');
});

test('entities are decoded; unknown ones and bare marks are left as written', () => {
  assert.ok(tabLines.includes('Balance < $500 & fees > $0 $1 $2 \u2013 \u2014 &unknownthing; AT&T'));
  assert.equal(decodeEntities('&AMP; &#0; &#xD800; &#99999999; &rarr;'), '& &#0; &#xD800; &#99999999; \u2192');
});

test('odd tags do not leak into the text', () => {
  assert.ok(tabLines.includes('Quoted mark kept out'));
  assert.ok(tabLines.includes('Loose tag text'));
  assert.equal(htmlToVisibleText('<P>one<BR/>two</P><x-custom data-a=1>three</x-custom> 4 <5'), 'one\ntwo\nthree 4 <5');
});

test('a page saved in the old Windows encoding is still read', () => {
  const p = write('windows.html', Buffer.concat([Buffer.from('<html><body><p>Fee '), Buffer.from([0x96]), Buffer.from(' $5</p></body></html>')]));
  assert.equal(convertSource({ filePath: p, format: 'web_page' }).pages[0].text, 'Fee \u2013 $5');
});

test('a text PDF is read page by page, with layout text and a second reading', () => {
  const r = convertSource({ filePath: pdfPath, format: 'text_pdf' });
  assert.deepEqual(r.pages.map((p) => p.page), [1, 2, 3]);
  assert.ok(r.pages.every((p) => p.method === 'pdf_text' && typeof p.altText === 'string'));
  const first = r.pages[0];
  assert.match(first.text, /^Stop payment order {2,}\$30\.00$/m); // the row stays on one line
  assert.match(first.altText!, /Overdraft fees are charged\nfor each item presented\nagainst the account\./);
  assert.equal(first.needsImageReading, false);
  assert.equal(r.textChars, r.pages.reduce((n, p) => n + p.text.length, 0));
});

test('a PDF page with almost no text is marked for image reading', () => {
  const r = convertSource({ filePath: pdfPath, format: 'text_pdf' });
  assert.equal(r.pages[1].text, '2');
  assert.equal(r.pages[1].needsImageReading, true);
  assert.equal(r.needsImageReading, true);
});

test('a PDF page with a broken text layer is marked for image reading', () => {
  const page = convertSource({ filePath: pdfPath, format: 'text_pdf' }).pages[2];
  assert.ok(page.text.length > 20);
  assert.equal(page.needsImageReading, true);
});

test('the thin rule: fewer than 20 letters', () => {
  assert.equal(isThin(''), true);
  assert.equal(isThin('Page 3 of 12  $5.00  1234567890'), true);
  assert.equal(isThin('a'.repeat(19)), true);
  assert.equal(isThin('a'.repeat(20)), false);
});

test('the garbled rule: unreadable characters, or letters that do not form words', () => {
  assert.equal(isGarbled('Stop payment order $30.00\nNSF fee $35.00 per item\nATM withdrawal $2.50'), false);
  assert.equal(isGarbled('NSF $35.00  ACH $5.00  ATM $2.50  Wire transfer $25.00 $30.00 $45.00'), false);
  assert.equal(isGarbled('Fee \uFFFD\uFFFD\uFFFD\uFFFD schedule'), true);          // replacement characters
  assert.equal(isGarbled('Stop\u0001\u0002\u0003 pay\u0004\u0005ment'), true);       // control characters
  assert.equal(isGarbled('Xq zvk pfrt bcd wrtp qqz mnb vcx zzk lkj hgf dsp'), true); // letters, no words
  assert.equal(isGarbled('\u0421\u0442\u043e\u043f \u043f\u043b\u0430\u0442\u0435\u0436 \u043a\u043e\u043c\u0438\u0441\u0441\u0438\u044f \u0431\u0430\u043d\u043a\u0430'), true); // no a-z words
  assert.equal(isGarbled(''), false);
});

test('scanned and shapes PDFs: every page is marked, no text is taken', () => {
  for (const format of ['image_pdf', 'shapes_pdf'] as const) {
    const r = convertSource({ filePath: pdfPath, format });
    assert.equal(r.pages.length, 3);
    assert.ok(r.pages.every((p, i) => p.page === i + 1 && p.method === 'none' && p.text === '' && p.needsImageReading));
    assert.equal(r.needsImageReading, true);
    assert.equal(r.textChars, 0);
  }
});

test('a picture is one page marked for image reading', () => {
  const png = write('pic.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  const r = convertSource({ filePath: png, format: 'image' });
  assert.deepEqual(r.pages, [{ page: 1, method: 'none', text: '', needsImageReading: true }]);
});

test('a label that disagrees with the file is refused', () => {
  assert.throws(() => convertSource({ filePath: pdfPath, format: 'web_page' }),
    (e: any) => e instanceof FormatMismatchError && e.format === 'web_page' && e.found === 'pdf');
  assert.throws(() => convertSource({ filePath: fixture('tables.html'), format: 'text_pdf' }),
    (e: any) => e instanceof FormatMismatchError && e.found === 'html');
  assert.throws(() => convertSource({ filePath: fixture('tabs.html'), format: 'image_pdf' }), FormatMismatchError);
  assert.throws(() => convertSource({ filePath: pdfPath, format: 'image' }), FormatMismatchError);
  assert.throws(() => convertSource({ filePath: write('plain.txt', 'Stop payment $30'), format: 'js_page' }),
    (e: any) => e instanceof FormatMismatchError && e.found === 'unknown');
  assert.equal(sniffKind(Buffer.from('\ufeff\n  <!DOCTYPE html><html>')), 'html');
});

test('formats with no converter yet say so and carry no text', () => {
  for (const format of ['embedded_viewer', 'office_file', 'other'] as const) {
    const r = convertSource({ filePath: fixture('tables.html'), format });
    assert.deepEqual(r.pages, []);
    assert.equal(r.needsImageReading, false);
    assert.equal(r.textChars, 0);
    assert.ok(r.notConverted && r.notConverted.length > 10);
    assert.match(r.fileSha256, /^[0-9a-f]{64}$/);
  }
});

test('an unknown format or a damaged PDF fails loudly', () => {
  assert.throws(() => convertSource({ filePath: pdfPath, format: 'pdf' as any }), RangeError);
  const broken = write('broken.pdf', '%PDF-1.4\nthis is not really a PDF\n');
  assert.throws(() => convertSource({ filePath: broken, format: 'text_pdf' }), ConvertError);
});

test('the command line prints the record as JSON', () => {
  const cli = join(import.meta.dirname, 'convert-cli.ts');
  const out = JSON.parse(execFileSync(process.execPath, [cli, fixture('tables.html'), 'web_page'], { encoding: 'utf8' }));
  assert.equal(out.format, 'web_page');
  assert.equal(out.pages[0].text, tables.pages[0].text);
  assert.throws(() => execFileSync(process.execPath, [cli, pdfPath, 'web_page'], { stdio: 'pipe' }));
});
