import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertSource, type StandardSource } from './convert.ts';
import { normalizeText, containsQuote } from './normalize.ts';
import { makePdf } from './fixtures/make-pdf.ts';

const source = (pages: StandardSource['pages']): StandardSource => ({
  sourceDocumentId: 1, format: 'text_pdf', fileSha256: 'x', converterVersion: 'test', pages,
  needsImageReading: false, textChars: 0,
});

test('normalizeText: one space for any run of white space, trimmed, case kept', () => {
  assert.equal(normalizeText('  Stop\tPayment \n\n  ORDER\u00a0\u00a0$30.00 \u2003 each '), 'Stop Payment ORDER $30.00 each');
});

test('normalizeText: curly quotes, dashes and hidden marks become plain', () => {
  assert.equal(normalizeText('Cashier\u2019s \u201cofficial\u201d check \u2013 non\u2011member \u2014 $8'), 'Cashier\'s "official" check - non-member - $8');
  assert.equal(normalizeText('over\u00addraft\u200b fee\ufeff'), 'overdraft fee');
});

test('containsQuote finds a quote across white space and line differences', () => {
  const html = convertSource({ filePath: join(import.meta.dirname, 'fixtures', 'tables.html'), format: 'web_page' });
  assert.deepEqual(containsQuote(html, 'Stop   payment\n$30.00'), { found: true, page: null });
  assert.deepEqual(containsQuote(html, "Cashier's check $8.00 each"), { found: true, page: null }); // plain quote against a curly one
  assert.deepEqual(containsQuote(html, 'Wire transfer - outgoing $25.00'), { found: true, page: null });
  assert.deepEqual(containsQuote(html, 'Inner fee A $1.00 Inner fee B $2.00'), { found: true, page: null });
});

test('containsQuote is exact about wording, amounts and case', () => {
  const s = source([{ page: 1, method: 'pdf_text', text: 'Stop payment     $30.00', needsImageReading: false }]);
  assert.equal(containsQuote(s, 'Stop payment $30.00').found, true);
  assert.equal(containsQuote(s, 'Stop payment $35.00').found, false);
  assert.equal(containsQuote(s, 'stop payment $30.00').found, false);
  assert.deepEqual(containsQuote(s, '   '), { found: false, page: null });
});

test('containsQuote reports the page it found the quote on', () => {
  const s = source([
    { page: 1, method: 'pdf_text', text: 'Cover page of the schedule', needsImageReading: false },
    { page: 2, method: 'pdf_text', text: 'Wire transfer\n  outgoing    $25.00', needsImageReading: false },
  ]);
  assert.deepEqual(containsQuote(s, 'Wire transfer outgoing $25.00'), { found: true, page: 2 });
  assert.deepEqual(containsQuote(s, 'of the schedule Wire transfer'), { found: false, page: null }); // never across pages
});

test('containsQuote falls back to the second reading of a PDF page', () => {
  // Two columns of prose side by side: the layout reading weaves the columns together,
  // the plain reading keeps each column whole.
  const left = ['Overdraft fees are charged', 'for each item presented', 'against the account.'];
  const right = ['Wire transfers sent after', 'the daily cutoff are', 'processed the next day.'];
  const dir = mkdtempSync(join(tmpdir(), 'rosetta-'));
  const file = join(dir, 'columns.pdf');
  writeFileSync(file, makePdf([
    [{ x: 72, y: 700, text: 'This first page is only here so the quote is found on page two.' }],
    [...left.map((text, i) => ({ x: 72, y: 600 - 12 * i, text })), ...right.map((text, i) => ({ x: 330, y: 600 - 12 * i, text }))],
  ]));
  const pdf = convertSource({ filePath: file, format: 'text_pdf' });
  const quote = 'Overdraft fees are charged for each item presented against the account.';
  assert.equal(normalizeText(pdf.pages[1].text).includes(quote), false);
  assert.deepEqual(containsQuote(pdf, quote), { found: true, page: 2 });
  assert.deepEqual(containsQuote(pdf, 'Overdraft fees are charged Wire transfers sent after'), { found: true, page: 2 }); // layout reading
});

test('containsQuote ignores spacing differences but not wording', () => {
  const s = { sourceDocumentId: null, format: 'web_page', fileSha256: 'x', converterVersion: 't', needsImageReading: false, textChars: 0,
    pages: [{ page: null, method: 'html_visible', text: '$0monthly service charge\nBuyback1 $5.00', needsImageReading: false }] } as any;
  assert.equal(containsQuote(s, '$0 monthly service charge').found, true);
  assert.equal(containsQuote(s, 'Buyback 1 $5.00').found, true);
  assert.equal(containsQuote(s, '$0 monthly service fee').found, false);
});
