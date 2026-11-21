import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient, FileLedger, InMemoryLedger, type Transport, type TransportRequest } from '../model/wrapper.ts';
import { readDocument, type ReadInput } from './candidates.ts';
import { applyReply, BATCH, buildMessage, checkDocument, KNOX_MODEL, pagedText, priceInQuote } from './check.ts';

const input: ReadInput = {
  textId: 7, institutionId: 3, pageStarts: [0, 41],
  text: 'Stop Payment | $30.00\nCoin Count | $5.00\nOverdraft Fee | $35.00\nPaper statement | $3.00 per month\n',
};
const candidates = readDocument(input);

function client(replies: string[]) {
  const requests: TransportRequest[] = [];
  const transport: Transport = async (r) => { requests.push(r); return { text: replies.shift() ?? '{}', usage: { inputTokens: 1000, outputTokens: 100 } }; };
  const c = createModelClient({
    transport, prices: { [KNOX_MODEL]: { inputPerMillion: 2, outputPerMillion: 10 } },
    capUsd: 200, pauseAtUsd: 25, ledger: new InMemoryLedger(), now: () => new Date(0),
  });
  return { c, requests };
}

test('the finder gives the candidates these tests use', () => {
  assert.deepEqual(candidates.map((f) => f.feeName), ['Stop Payment', 'Coin Count', 'Overdraft Fee', 'Paper statement']);
});

test('pagedText marks pages; the message numbers the candidates', () => {
  assert.match(pagedText(input), /^\[page 1\]\nStop Payment[\s\S]*\[page 2\]\nOverdraft/);
  const m = buildMessage(input, candidates.slice(0, 2), 1);
  assert.match(m, /<document>[\s\S]*<\/document>/);
  assert.match(m, /\n1\. Stop Payment \| \$30 \| quote: Stop Payment \| \$30\.00\n2\. Coin Count/);
  assert.doesNotMatch(m, /leave "add" empty/);
  assert.match(buildMessage(input, candidates.slice(0, 2), 1, false), /leave "add" empty/);
});

test('only kept candidates stay; a dropped one goes', () => {
  const r = applyReply('{"keep":[1,3]}', input, candidates, 1);
  assert.deepEqual(r.fees.map((f) => f.feeName), ['Stop Payment', 'Overdraft Fee']);
  assert.deepEqual(r.problems, []);
});

test('fixes are taken only when their words are in the document', () => {
  const r = applyReply(JSON.stringify({ keep: [1, 3], fix: [
    { id: 1, feeName: 'Stop Payment Fee', audience: 'consumer', unit: 'per_item' },
    { id: 3, feeName: 'Courtesy Pay Charge', product: 'Gold Checking', audience: 'nobody', unit: 'weekly' },
  ] }), input, candidates, 1);
  assert.equal(r.fees[0].feeName, 'Stop Payment Fee');
  assert.equal(r.fees[0].audience, 'consumer');
  assert.equal(r.fees[0].unit, 'per_item');
  assert.equal(r.fees[1].feeName, 'Overdraft Fee', 'an invented name is not taken');
  assert.equal(r.fees[1].product, null, 'an invented product is not taken');
  assert.equal(r.fees[1].audience, candidates[2].audience);
  assert.equal(r.problems.length, 1);
});

test('ids outside the batch, repeats and text around the JSON are ignored', () => {
  const r = applyReply('Here you go:\n{"keep":[3,3,9,"1"]}\nThanks', input, candidates, 1);
  assert.deepEqual(r.fees.map((f) => f.feeName), ['Overdraft Fee']);
});

test('an added fee is kept only when its quote is in the text and its price in the quote', () => {
  const add = (over: object) => ({ quote: 'Overdraft Fee | $35.00', feeName: 'Overdraft Fee', priceKind: 'flat', amountUsd: 35, unit: 'per_item', audience: 'consumer', ...over });
  const r = applyReply(JSON.stringify({ keep: [], add: [
    add({}),
    add({ quote: 'Overdraft Fee | $36.00', amountUsd: 36 }),
    add({ amountUsd: 30 }),
    add({ feeName: 'Courtesy Pay' }),
    add({ quote: 'Paper statement | $3.00 per month', feeName: 'Paper statement', amountUsd: 3, unit: 'per_month' }),
  ] }), input, candidates, 1);
  assert.deepEqual(r.fees.map((f) => [f.feeName, f.amountUsd, f.page]), [['Overdraft Fee', 35, 2], ['Paper statement', 3, 2]]);
  assert.equal(r.problems.length, 3);
});

test('adds are ignored on a batch that is not the last', () => {
  const r = applyReply('{"keep":[1],"add":[{"quote":"Overdraft Fee | $35.00","feeName":"Overdraft Fee","priceKind":"flat","amountUsd":35}]}', input, candidates, 1, false);
  assert.equal(r.fees.length, 1);
});

test('a reply that is not JSON decides nothing and says so', () => {
  const r = applyReply('I cannot tell.', input, candidates, 1);
  assert.equal(r.fees.length, 0);
  assert.match(r.problems[0], /not JSON/);
});

test('priceInQuote checks each kind of price', () => {
  assert.ok(priceInQuote('Fee $5.00', 'flat', 5, null, null));
  assert.ok(!priceInQuote('Fee $5.00', 'flat', 6, null, null));
  assert.ok(priceInQuote('Fee $5 to $10', 'range', 5, 10, null));
  assert.ok(priceInQuote('Fee up to $10', 'range', 0, 10, null));
  assert.ok(priceInQuote('Foreign fee 1% of the amount', 'rate', null, null, 1));
  assert.ok(priceInQuote('Online statements: free', 'free', null, null, null));
  assert.ok(!priceInQuote('Online statements', 'free', null, null, null));
});

test('checkDocument calls Knox once a batch, sends adds only with the last, and drops repeats', async () => {
  const many: ReadInput = { textId: 9, institutionId: 3, pageStarts: null, text: Array.from({ length: BATCH + 5 }, (_, i) => `Item ${i} fee | $${i + 1}.00`).join('\n') };
  const cands = readDocument(many);
  assert.equal(cands.length, BATCH + 5);
  const { c, requests } = client([
    JSON.stringify({ keep: [1, 2] }),
    JSON.stringify({ keep: [BATCH + 1], add: [{ quote: 'Item 0 fee | $1.00', feeName: 'Item 0 fee', priceKind: 'flat', amountUsd: 1 }] }),
  ]);
  const r = await checkDocument(c, 'r1', many, cands);
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /leave "add" empty/);
  assert.doesNotMatch(requests[1].messages[0].content, /leave "add" empty/);
  assert.equal(requests[0].model, KNOX_MODEL);
  assert.deepEqual(r.fees.map((f) => f.feeName), ['Item 0 fee', 'Item 1 fee', `Item ${BATCH} fee`], 'the added repeat of Item 0 is dropped');
  assert.ok(c.spent() > 0);
});

test('a document with no candidates still gets one call', async () => {
  const { c, requests } = client(['{"keep":[]}']);
  await checkDocument(c, 'r1', { ...input, text: 'Nothing here.' }, []);
  assert.equal(requests.length, 1);
});

test('the file ledger keeps the total across runs and refuses a bad line', () => {
  const files = new Map<string, string>();
  const fs = { read: (p: string) => files.get(p) ?? null, append: (p: string, l: string) => { files.set(p, (files.get(p) ?? '') + l); } };
  const entry = { time: new Date(0), agent: 'knox', runId: 'r', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 1.25, outcome: 'ok' as const, note: '' };
  const a = new FileLedger('l.jsonl', fs);
  a.record(entry); a.record(entry);
  assert.equal(new FileLedger('l.jsonl', fs).total(), 2.5);
  files.set('bad.jsonl', '{"costUsd":"lots"}\n');
  assert.throws(() => new FileLedger('bad.jsonl', fs), /bad line/);
});
