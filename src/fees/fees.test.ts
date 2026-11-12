import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StandardPage, StandardSource } from '../rosetta/convert.ts';
import { score } from '../deming/score.ts';
import { validateFee, toFeeLine, PRICE_KINDS, UNITS, AUDIENCES, STATUSES, type FeeRecord } from './record.ts';
import { checkFee, figuresIn, QUOTE_CHECK_VERSION } from './quote-check.ts';
import { nextStatus, canGoLive, applyCheck, withdraw } from './publish.ts';

// Small made-up fixtures only. No real institution, document or fee.
const page = (n: number | null, text: string, more: Partial<StandardPage> = {}): StandardPage =>
  ({ page: n, method: n == null ? 'html_visible' : 'pdf_text', text, needsImageReading: false, ...more });
const source = (pages: StandardPage[], id = 7): StandardSource => ({
  sourceDocumentId: id, format: pages[0]?.page == null ? 'web_page' : 'text_pdf', fileSha256: 'x',
  converterVersion: 'test', pages, needsImageReading: pages.some((p) => p.needsImageReading), textChars: 0,
});
const fee = (over: Partial<FeeRecord> = {}): FeeRecord => ({
  institutionId: 1, sourceDocumentId: 7, page: 1, quote: 'Stop payment order $30.00 each', feeName: 'Stop payment order',
  category: null, priceKind: 'flat', amountUsd: 30, amountMaxUsd: null, ratePct: null, unit: 'per_item',
  conditions: null, product: null, audience: 'consumer', documentDate: null, readAt: '2026-11-12T10:00:00Z',
  runId: 'run-1', status: 'read', withdrawalReason: null, quoteCheckedAt: null, quoteCheckVersion: null, ...over,
});
/** One fee whose quote is the only line on page 1 of its document. */
const check = (over: Partial<FeeRecord>, text?: string) => {
  const r = fee(over);
  return checkFee(r, source([page(1, text ?? r.quote)]));
};
const says = (problems: string[], part: string) => problems.some((p) => p.includes(part));

// ---------- the record ----------

test('validateFee: a complete record has no problems', () => {
  assert.deepEqual(validateFee(fee()), []);
});

test('validateFee: institution, document, quote, fee name, read time and run are required', () => {
  const p = validateFee(fee({ institutionId: 0, sourceDocumentId: null as any, quote: '  ', feeName: '', readAt: 'soon', runId: '' }));
  assert.equal(p.length, 6);
  assert.ok(says(p, 'no document, no fee'));
});

test('validateFee: price kind, unit, audience and status come from their lists', () => {
  const p = validateFee(fee({ priceKind: 'tiered' as any, unit: 'per_week' as any, audience: 'student' as any, status: 'draft' as any }));
  assert.equal(p.length, 4);
});

test('validateFee: each price kind needs its own numbers', () => {
  assert.ok(says(validateFee(fee({ amountUsd: null })), 'a flat fee needs an amount'));
  assert.ok(says(validateFee(fee({ priceKind: 'range', amountUsd: 5, amountMaxUsd: null })), 'a range needs'));
  assert.ok(says(validateFee(fee({ priceKind: 'range', amountUsd: 20, amountMaxUsd: 5 })), 'below the lowest'));
  assert.ok(says(validateFee(fee({ priceKind: 'rate', amountUsd: null })), 'a rate needs a percent'));
  assert.ok(says(validateFee(fee({ priceKind: 'free', amountUsd: 5 })), 'free fee cannot'));
  assert.deepEqual(validateFee(fee({ priceKind: 'free', amountUsd: 0 })), []);
  assert.deepEqual(validateFee(fee({ priceKind: 'free', amountUsd: null })), []);
  assert.deepEqual(validateFee(fee({ priceKind: 'varies', amountUsd: null })), []);
  assert.ok(says(validateFee(fee({ amountUsd: -1 })), 'zero or more'));
});

test('validateFee: a percent fee is never mixed with dollar fees', () => {
  assert.ok(says(validateFee(fee({ priceKind: 'rate', ratePct: 3, amountUsd: 10 })), 'cannot also hold a dollar amount'));
  assert.ok(says(validateFee(fee({ priceKind: 'flat', amountUsd: 10, ratePct: 3 })), 'only a rate can hold a percent'));
  assert.deepEqual(validateFee(fee({ priceKind: 'rate', ratePct: 3, amountUsd: null })), []);
});

test('validateFee: category may be empty (not yet sorted) but not blank text', () => {
  assert.deepEqual(validateFee(fee({ category: null })), []);
  assert.equal(validateFee(fee({ category: ' ' })).length, 1);
});

test('validateFee: withdrawn without a reason is refused', () => {
  assert.ok(says(validateFee(fee({ status: 'withdrawn' })), 'needs a reason'));
  assert.ok(says(validateFee(fee({ status: 'withdrawn', withdrawalReason: '   ' })), 'needs a reason'));
  assert.deepEqual(validateFee(fee({ status: 'withdrawn', withdrawalReason: 'the bank removed the fee' })), []);
});

test('validateFee: checked and live need a passed quote check, with time and version together', () => {
  assert.ok(says(validateFee(fee({ status: 'checked' })), 'before it has passed the quote check'));
  assert.ok(says(validateFee(fee({ status: 'live' })), 'before it has passed the quote check'));
  assert.ok(says(validateFee(fee({ quoteCheckedAt: '2026-11-12T10:00:00Z' })), 'set together'));
});

test('toFeeLine gives the scorer the same fields, and a fee scores against itself', () => {
  const r = fee({ product: 'Basic checking' });
  assert.deepEqual(toFeeLine(r), {
    institutionId: 1, feeName: 'Stop payment order', quote: 'Stop payment order $30.00 each', priceKind: 'flat',
    amountUsd: 30, amountMaxUsd: null, ratePct: null, unit: 'per_item', product: 'Basic checking', audience: 'consumer',
  });
  const s = score([toFeeLine(r)], [toFeeLine(r)]).total;
  assert.deepEqual([s.matched, s.unitMismatches, s.audienceMixUps], [1, 0, 0]);
});

// ---------- reading figures ----------

test('figuresIn: what counts as a dollar figure', () => {
  assert.deepEqual(figuresIn('$30 or $30.00 or 30.00 or $1,500 or $1,500.00 or 1,500.00').money, [30, 30, 30, 1500, 1500, 1500]);
  assert.deepEqual(figuresIn('$ 12 and $.50 and 25¢ and 75 cents').money, [12, 0.5, 0.25, 0.75]);
  assert.deepEqual(figuresIn('Fee is $30.00. Then $20, then done.').money, [30, 20]);
});

test('figuresIn: a bare whole number, a percent and a broken number are not dollars', () => {
  assert.deepEqual(figuresIn('30 days, 300 items, 1,500 pages, 30%, 30.5, form A4.00').money, []);
  assert.deepEqual(figuresIn('$1,50 and $10,20,30 and 1.500.00').money, []);
  assert.deepEqual(figuresIn('$1.500').money, [1.5]);
});

test('figuresIn: percents', () => {
  assert.deepEqual(figuresIn('1.5% or 1.50 % or 1.5 percent or 3 Percent').percents, [1.5, 1.5, 1.5, 3]);
  assert.deepEqual(figuresIn('$3.00 and 3 items').percents, []);
});

// ---------- the quote check ----------

test('checkFee passes a plain flat fee and reports the page', () => {
  const r = checkFee(fee({ page: 2 }), source([page(1, 'Schedule of fees'), page(2, 'Fee            Amount\nStop payment order     $30.00 each')]));
  assert.deepEqual(r, { ok: true, problems: [], page: 2 });
});

test('checkFee: an invalid record fails even when the quote is right', () => {
  const r = check({ runId: '' });
  assert.equal(r.ok, false);
  assert.ok(says(r.problems, 'the run that read the fee is missing'));
});

test('checkFee: a quote that is not in the text fails', () => {
  const r = check({}, 'Stop payment order $35.00 each');
  assert.equal(r.ok, false);
  assert.equal(r.page, null);
  assert.ok(says(r.problems, 'not in the stored text'));
});

test('checkFee: text from another document fails', () => {
  const r = checkFee(fee(), source([page(1, fee().quote)], 8));
  assert.ok(says(r.problems, 'not the text of the fee\'s source document'));
});

test('checkFee: a quote found only on a different page than claimed fails, and says where it is', () => {
  const r = checkFee(fee({ page: 1 }), source([page(1, 'Cover page of the schedule'), page(2, 'x'), page(3, fee().quote)]));
  assert.equal(r.ok, false);
  assert.equal(r.page, 3);
  assert.ok(says(r.problems, 'not on page 1; it was found on page 3'));
});

test('checkFee: a quote on two pages passes for either claimed page', () => {
  const src = source([page(1, fee().quote), page(2, fee().quote)]);
  assert.equal(checkFee(fee({ page: 2 }), src).page, 2);
  assert.equal(checkFee(fee({ page: 2 }), src).ok, true);
});

test('checkFee: a quote is never matched across two pages', () => {
  const r = checkFee(fee(), source([page(1, 'Stop payment order'), page(2, '$30.00 each')]));
  assert.equal(r.ok, false);
});

test('checkFee: a web page has no page, so the fee must claim none', () => {
  const web = source([page(null, fee().quote)]);
  assert.deepEqual(checkFee(fee({ page: null }), web), { ok: true, problems: [], page: null });
  assert.equal(checkFee(fee({ page: 1 }), web).ok, false);
  assert.equal(checkFee(fee({ page: null }), source([page(1, fee().quote)])).ok, false);
});

test('checkFee: the quote may be found in the second reading of a PDF page', () => {
  const r = checkFee(fee(), source([page(1, 'Stop payment order      Wire      $30.00 each', { altText: 'Stop payment order $30.00 each\nWire' })]));
  assert.equal(r.ok, true);
});

test('checkFee: text on a page marked for image reading is not trusted', () => {
  for (const method of ['pdf_text', 'none'] as const) {
    const r = checkFee(fee(), source([page(1, fee().quote, { needsImageReading: true, method })]));
    assert.equal(r.ok, false);
    assert.ok(says(r.problems, 'marked for image reading'));
  }
  const later = checkFee(fee(), source([page(1, fee().quote, { needsImageReading: true, method: 'image_read' as any })]));
  assert.equal(later.ok, true);
});

test('checkFee: a marked page elsewhere in the document does not fail a fee on a good page', () => {
  const r = checkFee(fee({ page: 2 }), source([page(1, '', { needsImageReading: true, method: 'none' }), page(2, fee().quote)]));
  assert.equal(r.ok, true);
});

test('checkFee: the amount must be a dollar figure in the quote, not part of another number', () => {
  for (const quote of ['Stop payment order $300', 'Stop payment order $130.00', 'Stop payment order 30% of item', 'Stop payment order $30.50',
    'Stop payment order $3,000', 'Stop payment order 1300.00']) {
    const r = check({ quote });
    assert.equal(r.ok, false, quote);
    assert.ok(says(r.problems, '$30.00 is not in the quote'), quote);
  }
});

test('checkFee: "30 days" is not a price of $30', () => {
  const r = check({ quote: 'Stop payment order, valid for 30 days', feeName: 'Stop payment order' });
  assert.equal(r.ok, false);
  assert.equal(check({ quote: 'Stop payment order, valid for 30 days: $30' }).ok, true);
});

test('checkFee: every accepted way of writing the amount', () => {
  for (const quote of ['Stop payment order $30', 'Stop payment order $30.00', 'Stop payment order 30.00', 'Stop payment order: $30.']) {
    assert.equal(check({ quote }).ok, true, quote);
  }
  for (const quote of ['Wire, outgoing $1,500', 'Wire, outgoing $1,500.00', 'Wire, outgoing 1,500.00', 'Wire, outgoing $1500']) {
    assert.equal(check({ quote, feeName: 'Outgoing wire', amountUsd: 1500 }).ok, true, quote);
  }
  assert.equal(check({ quote: 'Photocopies 25¢ per page', feeName: 'Photocopies', amountUsd: 0.25 }).ok, true);
});

test('checkFee: "$1.500" is 1.5, not 1,500', () => {
  assert.equal(check({ quote: 'Wire, outgoing $1.500', feeName: 'Outgoing wire', amountUsd: 1500 }).ok, false);
  assert.equal(check({ quote: 'Wire, outgoing $1.500', feeName: 'Outgoing wire', amountUsd: 1.5 }).ok, true);
  assert.equal(check({ quote: 'Wire, outgoing $1,50', feeName: 'Outgoing wire', amountUsd: 150 }).ok, false);
});

test('checkFee: a range needs both ends in the quote', () => {
  const range = { priceKind: 'range' as const, feeName: 'Safe deposit box', unit: 'per_year' as const };
  assert.equal(check({ ...range, quote: 'Safe deposit box $25 to $150 a year', amountUsd: 25, amountMaxUsd: 150 }).ok, true);
  const r = check({ ...range, quote: 'Safe deposit box from $150 a year', amountUsd: 25, amountMaxUsd: 150 });
  assert.ok(says(r.problems, 'the lowest amount $25.00'));
  assert.ok(says(check({ ...range, quote: 'Safe deposit box from $25 a year', amountUsd: 25, amountMaxUsd: 150 }).problems, 'the highest amount $150.00'));
});

test('checkFee: "up to $20" is a range from 0, and the 0 need not be printed', () => {
  const upTo = { priceKind: 'range' as const, feeName: 'Research', amountUsd: 0, amountMaxUsd: 20 };
  assert.equal(check({ ...upTo, quote: 'Research: up to $20 per request' }).ok, true);
  assert.equal(check({ ...upTo, quote: 'Research: $20 per request', conditions: 'Up to the amount shown' }).ok, true);
  assert.equal(check({ ...upTo, quote: 'Research: $20 per request' }).ok, false); // nothing says "up to"
  assert.equal(check({ ...upTo, quote: 'Research: up to 20 requests' }).ok, false); // the 20 must still be dollars
  assert.equal(check({ ...upTo, amountUsd: 5, quote: 'Research: up to $20 per request' }).ok, false); // a stated low end must be found
});

test('checkFee: a rate needs its percent in the quote, however it is written', () => {
  const rate = { priceKind: 'rate' as const, feeName: 'Foreign transaction', amountUsd: null, ratePct: 1.5 };
  for (const quote of ['Foreign transaction 1.5%', 'Foreign transaction 1.50 % of amount', 'Foreign transaction: 1.5 percent']) {
    assert.equal(check({ ...rate, quote }).ok, true, quote);
  }
  for (const quote of ['Foreign transaction 11.5%', 'Foreign transaction 1.55%', 'Foreign transaction 0.5%']) {
    assert.equal(check({ ...rate, quote }).ok, false, quote);
  }
});

test('checkFee: a percent and a dollar amount do not stand in for each other', () => {
  const dollars = check({ priceKind: 'rate', feeName: 'Foreign transaction', amountUsd: null, ratePct: 3, quote: 'Foreign transaction $3.00' });
  assert.ok(says(dollars.problems, 'not in the quote as a percent figure'));
  const percent = check({ feeName: 'Foreign transaction', amountUsd: 3, quote: 'Foreign transaction 3% of the amount' });
  assert.ok(says(percent.problems, 'not in the quote as a dollar figure'));
  assert.equal(check({ priceKind: 'rate', feeName: 'Cash advance', amountUsd: null, ratePct: 3, quote: 'Cash advance 3% of the advance, $10 minimum', conditions: '$10 minimum' }).ok, true);
});

test('checkFee: a free fee needs words that say free', () => {
  const free = { priceKind: 'free' as const, feeName: 'Online statements', amountUsd: 0 };
  for (const said of ['Free', 'no charge', 'No Fee', 'N/C', 'waived', 'Included', 'complimentary', '$0', '$0.00', 'None']) {
    assert.equal(check({ ...free, quote: `Online statements ${said}` }).ok, true, said);
  }
  for (const said of ['$0.50', '$5.00', 'freedom plan', 'nonetheless charged', '$05']) {
    assert.equal(check({ ...free, quote: `Online statements ${said}` }).ok, false, said);
  }
  assert.equal(check({ ...free, amountUsd: null, quote: 'Online statements free' }).ok, true);
});

test('checkFee: a fee that varies needs no amount but a real quote', () => {
  const varies = { priceKind: 'varies' as const, amountUsd: null, feeName: 'Collections' };
  assert.equal(check({ ...varies, quote: 'Collections: at cost' }).ok, true);
  assert.ok(says(check({ ...varies, quote: 'Collections' }).problems, 'at least two words'));
  assert.equal(check({ ...varies, amountUsd: 12, quote: 'Collections: at cost' }).ok, false); // a stored number must be in the quote
});

test('checkFee: the quote must name the fee, not just hold its number', () => {
  const r = check({ feeName: 'Stop payment order', quote: 'Cashier\'s check $30.00 each' });
  assert.deepEqual(r.problems, ['no word of the fee name is in the quote']);
  assert.equal(check({ feeName: 'STOP PAYMENT', quote: 'stop payments $30.00' }).ok, true); // case does not matter
  assert.equal(check({ feeName: 'Overdraft fee', quote: 'Returned item fee $30.00' }).ok, false); // "fee" alone names nothing
  assert.equal(check({ feeName: 'Fee', quote: 'Fee $30.00' }).ok, true); // nothing else to go on
  assert.equal(check({ feeName: 'PO', quote: 'PO $30.00' }).ok, true);
  assert.equal(check({ feeName: 'PO', quote: 'Box rental $30.00' }).ok, false);
});

// ---------- the publish rule ----------

const pass = { ok: true, problems: [], page: 1 };
const fail = { ok: false, problems: ['the quote is not in the stored text of the document'], page: null };
const checked = () => applyCheck(fee(), pass, new Date('2026-11-12T12:00:00Z'));

test('nextStatus: read becomes checked only when the check passes', () => {
  assert.equal(nextStatus(fee(), pass).status, 'checked');
  assert.equal(nextStatus(fee(), fail).status, 'read');
});

test('applyCheck stamps the time and version of a passed check', () => {
  const r = checked();
  assert.deepEqual([r.status, r.quoteCheckedAt, r.quoteCheckVersion], ['checked', '2026-11-12T12:00:00.000Z', QUOTE_CHECK_VERSION]);
  assert.deepEqual(validateFee(r), []);
  assert.equal(applyCheck(fee(), fail, new Date()).quoteCheckedAt, null);
});

test('canGoLive: only a checked fee whose passed check is the current version', () => {
  assert.equal(canGoLive(checked()), true);
  assert.equal(canGoLive(fee()), false);
  assert.equal(canGoLive({ ...checked(), quoteCheckVersion: 'quote-check-0' }), false);
  assert.equal(canGoLive({ ...checked(), quoteCheckedAt: null, quoteCheckVersion: null }), false);
  assert.equal(canGoLive({ ...checked(), feeName: '' }), false);
});

test('nextStatus: a fee cannot jump from read to live', () => {
  assert.equal(nextStatus(fee(), pass).status, 'checked');
  assert.equal(nextStatus({ ...fee(), quoteCheckedAt: '2026-11-12T12:00:00Z', quoteCheckVersion: QUOTE_CHECK_VERSION }, pass).status, 'checked');
});

test('nextStatus: checked becomes live on a second pass, goes back to read on a fail', () => {
  assert.equal(nextStatus(checked(), pass).status, 'live');
  assert.equal(nextStatus(checked(), fail).status, 'read');
  const back = applyCheck(checked(), fail, new Date());
  assert.deepEqual([back.status, back.quoteCheckedAt, back.quoteCheckVersion], ['read', null, null]);
  assert.equal(nextStatus({ ...checked(), quoteCheckVersion: 'quote-check-0' }, pass).status, 'checked'); // old check: checked again first
});

test('nextStatus: a live fee that fails the check is withdrawn with the reason', () => {
  const live = applyCheck(checked(), pass, new Date());
  assert.equal(live.status, 'live');
  assert.equal(nextStatus(live, pass).status, 'live');
  const gone = applyCheck(live, fail, new Date());
  assert.equal(gone.status, 'withdrawn');
  assert.equal(gone.withdrawalReason, 'quote check failed: the quote is not in the stored text of the document');
  assert.deepEqual(validateFee(gone), []);
});

test('withdraw: from any status, always with a reason, and it is final', () => {
  assert.throws(() => withdraw(fee(), '  '), /needs a reason/);
  for (const r of [fee(), checked(), applyCheck(checked(), pass, new Date())]) {
    const gone = withdraw(r, 'the bank removed the fee');
    assert.equal(gone.status, 'withdrawn');
    assert.deepEqual(validateFee(gone), []);
    assert.deepEqual(nextStatus(gone, pass), { status: 'withdrawn', withdrawalReason: 'the bank removed the fee' });
    assert.equal(applyCheck(gone, pass, new Date()), gone);
  }
});

// ---------- the migration ----------

test('0004_fees.sql carries the same lists and rules as the code', () => {
  const sql = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'migrations', '0004_fees.sql'), 'utf8');
  for (const list of [PRICE_KINDS, UNITS, AUDIENCES, STATUSES]) {
    for (const word of list) assert.ok(sql.includes(`'${word}'`), word);
  }
  assert.match(sql, /fees are withdrawn, never deleted/);
  assert.match(sql, /before delete on public\.fees/);
  assert.match(sql, /enable row level security/);
  assert.doesNotMatch(sql, /create policy/);
  const columns = [...sql.matchAll(/^  ([a-z_]+)\s+(?:bigint|int|text|numeric|timestamptz)/gm)].map((m) => m[1]);
  assert.equal(columns.length, 23);
  for (const c of columns) assert.ok(sql.includes(`comment on column public.fees.${c} is`), `no comment on ${c}`);
});
