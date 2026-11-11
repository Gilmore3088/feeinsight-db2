import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, overlap, type FeeLine } from './score.ts';

const line = (o: Partial<FeeLine>): FeeLine => ({
  institutionId: 1, feeName: 'Stop Payment', quote: 'Stop Payment $30.00', priceKind: 'flat', amountUsd: 30,
  unit: 'per_item', audience: 'consumer', ...o,
});

test('a perfect read scores 100% on both numbers', () => {
  const key = [line({}), line({ feeName: 'Wire Transfer Outgoing Domestic', quote: 'Wire Transfer Outgoing Domestic $25', amountUsd: 25 })];
  const r = score(key, key.map((k) => ({ ...k }))).total;
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.missed + r.extra + r.wrongPrice, 0);
});

test('the same fee with a different price counts against both numbers', () => {
  const r = score([line({})], [line({ amountUsd: 35, quote: 'Stop Payment $35.00' })]).total;
  assert.equal(r.wrongPrice, 1);
  assert.equal(r.matched, 0);
  assert.equal(r.precision, 0);
  assert.equal(r.recall, 0);
});

test('a duplicate from the reader is an error', () => {
  const r = score([line({})], [line({}), line({})]).total;
  assert.equal(r.matched, 1);
  assert.equal(r.extra, 1);
  assert.equal(r.precision, 0.5);
  assert.equal(r.recall, 1);
});

test('a missed key line lowers recall only', () => {
  const key = [line({}), line({ feeName: 'Cashiers Check', quote: 'Cashiers Check $8.00', amountUsd: 8 })];
  const r = score(key, [line({})]).total;
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 0.5);
  assert.equal(r.missed, 1);
});

test('key lines with no stated amount are not scored, but a reader fee is always counted', () => {
  const key = [line({}), line({ feeName: 'Early withdrawal penalty', quote: 'a penalty may apply', priceKind: 'varies', amountUsd: null })];
  const r = score(key, [line({})]).total;
  assert.equal(r.keyLines, 1);
  assert.equal(r.recall, 1);
});

test('two prices for one fee pair up by price, not by order', () => {
  const key = [
    line({ feeName: 'Wire Transfer', quote: 'Wire Transfer Domestic $20', amountUsd: 20, product: 'Domestic' }),
    line({ feeName: 'Wire Transfer', quote: 'Wire Transfer International $45', amountUsd: 45, product: 'International' }),
  ];
  const reader = [
    line({ feeName: 'Wire Transfer', quote: 'Wire Transfer International $45', amountUsd: 45 }),
    line({ feeName: 'Wire Transfer', quote: 'Wire Transfer Domestic $20', amountUsd: 20 }),
  ];
  const r = score(key, reader).total;
  assert.equal(r.matched, 2);
  assert.equal(r.wrongPrice, 0);
});

test('consumer against business on a matched fee is reported as a mix-up', () => {
  const r = score([line({})], [line({ audience: 'business' })]).total;
  assert.equal(r.matched, 1);
  assert.equal(r.audienceMixUps, 1);
});

test('free, rate and range prices are compared on their own fields', () => {
  const key = [
    line({ feeName: 'Online Banking', quote: 'Online Banking Free', priceKind: 'free', amountUsd: null }),
    line({ feeName: 'Foreign Transaction', quote: 'Foreign Transaction 1% of amount', priceKind: 'rate', amountUsd: null, ratePct: 1 }),
    line({ feeName: 'Safe Deposit Box', quote: 'Safe Deposit Box $20 to $75', priceKind: 'range', amountUsd: 20, amountMaxUsd: 75 }),
  ];
  const reader = [
    { ...key[0] },
    { ...key[1], ratePct: 3 },
    { ...key[2] },
  ];
  const r = score(key, reader).total;
  assert.equal(r.matched, 2);
  assert.equal(r.wrongPrice, 1);
});

test('fees for an institution outside the key are ignored; per-institution scores add up', () => {
  const key = [line({}), line({ institutionId: 2 })];
  const report = score(key, [line({}), line({ institutionId: 9 })]);
  assert.equal(report.total.readerFees, 1);
  assert.equal(report.byInstitution.get(2)?.recall, 0);
  assert.equal(report.total.recall, 0.5);
});

test('the interval narrows with more lines and stays inside 0 to 1', () => {
  const r = score([line({})], [line({})]).total;
  assert.ok(r.recallInterval && r.recallInterval[0] < 1 && r.recallInterval[1] === 1);
});

test('amounts are ignored when comparing names', () => {
  assert.equal(overlap('Stop Payment $30.00', 'stop payment $35'), 1);
});
