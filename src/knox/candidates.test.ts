import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prices, readDocument, unitOf } from './candidates.ts';

const doc = (text: string) => readDocument({ textId: 1, institutionId: 7, text, pageStarts: null });

test('a table row gives one fee with the line as its quote', () => {
  const f = doc('Wire Transfer, outgoing | $30');
  assert.equal(f.length, 1);
  assert.equal(f[0].quote, 'Wire Transfer, outgoing | $30');
  assert.equal(f[0].priceKind, 'flat');
  assert.equal(f[0].amountUsd, 30);
});

test('dot leaders and a dash count as separators', () => {
  assert.equal(doc('Account Balancing Assistance, per hour......... $27.50')[0].amountUsd, 27.5);
  assert.equal(doc('Temporary check – $.20 each')[0].amountUsd, 0.2);
});

test('a short line with no separator still reads', () => {
  const f = doc('Stop Payment: $30.00/item');
  assert.equal(f.length, 1);
  assert.equal(f[0].amountUsd, 30);
});

test('every price at the head of a cell is its own row', () => {
  const f = doc('Wire Transfer (Within USA) Outgoing Incoming | $20.00 $10.00');
  assert.deepEqual(f.map((x) => x.amountUsd), [20, 10]);
});

test('no charge is a free row, and $0.75 is not free', () => {
  assert.equal(doc('Notary Services | No Fee')[0].priceKind, 'free');
  const f = doc('ATM Balance Inquiry | $0.75');
  assert.equal(f[0].priceKind, 'flat');
  assert.equal(f[0].amountUsd, 0.75);
});

test('a balance or a limit is not a fee', () => {
  assert.equal(doc('Minimum to open account | $2,500').length, 0);
  assert.deepEqual(prices('waived with a $1,500 minimum balance').length, 0);
  assert.deepEqual(prices('$35 per item, daily maximum $105').map((p) => p.amountUsd), [35]);
});

test('a range keeps both ends', () => {
  const [p] = prices('$5 - $15 per request');
  assert.equal(p.kind, 'range');
  assert.equal(p.amountUsd, 5);
  assert.equal(p.amountMaxUsd, 15);
});

test('a rate in a rate table is not a fee, a percent fee is', () => {
  assert.equal(doc('Tier 3 | $500,001-$1,000,000 | 0.20%').length, 0);
  const f = doc('Foreign Transaction Fee | 1% of U.S. Dollar Amount');
  assert.equal(f[0].priceKind, 'rate');
  assert.equal(f[0].ratePct, 1);
});

test('a price alone on its line takes the name from the line before', () => {
  const f = doc('Garnishment\n$75.00');
  assert.equal(f.length, 1);
  assert.equal(f[0].feeName, 'Garnishment');
});

test('product columns give one row per column with the header as the product', () => {
  const f = doc('Fee | Basic Checking | Premier Checking\nMonthly service charge | $5 | $12');
  assert.deepEqual(f.map((x) => [x.product, x.amountUsd]), [['Basic Checking', 5], ['Premier Checking', 12]]);
});

test('a sentence that names a fee and a price reads as prose', () => {
  const f = doc('We will charge you $25.00 for each stop-payment order you give.');
  assert.equal(f.length, 1);
  assert.equal(f[0].amountUsd, 25);
});

test('units come from the words around the price', () => {
  assert.equal(unitOf('$35.00 per hour'), 'per_hour');
  assert.equal(unitOf('$3.00 monthly'), 'per_month');
  assert.equal(unitOf('$1 ea.'), 'per_item');
});

test('page numbers come from the page starts', () => {
  const f = readDocument({ textId: 1, institutionId: 7, text: 'intro\nNSF Fee | $35', pageStarts: [0, 6] });
  assert.equal(f[0].page, 2);
});
