import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKeyLines } from './key-check.ts';
import { keyFeeLines, validateKey, type KeyFile, type KeyLine } from './key-file.ts';
import { coverage, report } from './score-cli.ts';
import { storedTextSource } from '../rosetta/stored-text.ts';

const line = (over: Partial<KeyLine> = {}): KeyLine => ({
  institutionId: 1, textId: 10, page: null, quote: 'Stop payment $30.00 per item', feeName: 'Stop payment',
  priceKind: 'flat', amountUsd: 30, amountMaxUsd: null, ratePct: null, unit: 'per_item', conditions: null, product: null,
  audience: 'consumer', recordedBy: 'drafting session', ...over,
});
const key = (over: Partial<KeyFile> = {}): KeyFile => ({
  name: 'k', kind: 'sealed', status: 'drafting', drawSeed: 's', drawRule: 'r',
  institutions: [{ institutionId: 1, name: 'A Bank', charter: 'bank', drawRank: 1, documents: [{ textId: 10, sourceDocumentId: 5, url: 'u', textSha: null, fetchedAt: null }], notes: null }],
  lines: [line()], confirmations: [], ...over,
});

test('a well-formed key has no problems', () => assert.deepEqual(validateKey(key()), []));

test('a sealed key needs its draw seed', () => {
  assert.match(validateKey(key({ drawSeed: null })).join(), /draw seed/);
});

test('a key line must use one of the institution\'s documents and obey the price rules', () => {
  const p = validateKey(key({ lines: [line({ textId: 99 }), line({ priceKind: 'rate', ratePct: null })] })).join('|');
  assert.match(p, /document 99 is not one of/);
  assert.match(p, /a rate needs a percent/);
});

test('a model cannot confirm a key line; a person can', () => {
  const c = { institutionId: 1, lineIndex: 0, verdict: 'agree' as const, note: null };
  assert.match(validateKey(key({ confirmations: [{ ...c, confirmedBy: 'Claude' }] })).join(), /a model cannot confirm/);
  assert.deepEqual(validateKey(key({ confirmations: [{ ...c, confirmedBy: 'James' }] })), []);
});

test('a sealed key is sealed only after a person checked 20% of its institutions', () => {
  assert.match(validateKey(key({ status: 'sealed' })).join(), /at least 20%/);
});

test('coverage counts key institutions with any reader fee', () => {
  const k = key({ institutions: [...key().institutions, { ...key().institutions[0], institutionId: 2 }] });
  assert.deepEqual(coverage(k, keyFeeLines(k)), { covered: 1, institutions: 2, share: 0.5 });
});

test('the report prints the three numbers and the gate', () => {
  const r = report(key(), keyFeeLines(key()), 'self', true);
  assert.match(r, /Precision\s+100\.0%/);
  assert.match(r, /Recall\s+100\.0%/);
  assert.match(r, /Coverage\s+100\.0%/);
  assert.match(r, /gate 97%/);
});

test('the quote check runs on key lines, and fills a PDF page from where the quote is', () => {
  const text = 'Schedule of fees\nStop payment $30.00 per item\n';
  const pdf = { text: 'Cover page\n' + text, pageStarts: [0, 11] };
  const k = key();
  const [miss] = checkKeyLines(k, new Map([[10, pdf]]));
  assert.equal(miss.result.ok, false);
  const [hit] = checkKeyLines(k, new Map([[10, pdf]]), true);
  assert.equal(hit.result.ok, true);
  assert.equal(k.lines[0].page, 2);
  const [wrong] = checkKeyLines(key({ lines: [line({ amountUsd: 35 })] }), new Map([[10, { text, pageStarts: null }]]));
  assert.equal(wrong.result.ok, false);
});

test('a stored text with no page starts is one web page', () => {
  const s = storedTextSource(3, 'abc', null);
  assert.equal(s.pages.length, 1);
  assert.equal(s.pages[0].page, null);
  assert.equal(storedTextSource(3, 'abcdef', [0, 3]).pages[1].text, 'def');
});
