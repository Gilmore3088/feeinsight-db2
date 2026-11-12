import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createModelClient, anthropicTransport, InMemoryLedger, TransportError, SpendCapError, SpendPausedError,
  UnknownModelError, ModelCallError, type Transport, type TransportRequest,
} from './wrapper.ts';

const prices = { m1: { inputPerMillion: 3, outputPerMillion: 15 } };
const T0 = new Date('2026-01-01T00:00:00Z');
const input = { agent: 'knox', runId: 'r1', model: 'm1', system: 'sys', messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 1000 };

function setup(over: { capUsd?: number; pauseAtUsd?: number; transport?: Transport } = {}) {
  const ledger = new InMemoryLedger();
  const requests: TransportRequest[] = [];
  const sleeps: number[] = [];
  const transport: Transport = over.transport ?? (async (r) => { requests.push(r); return { text: 'hi', usage: { inputTokens: 1000, outputTokens: 500 } }; });
  const wrapped: Transport = async (r) => { if (over.transport) requests.push(r); return transport(r); };
  const client = createModelClient({
    transport: over.transport ? wrapped : transport, prices, capUsd: over.capUsd ?? 10, pauseAtUsd: over.pauseAtUsd ?? 5,
    ledger, now: () => T0, sleep: async (ms) => { sleeps.push(ms); },
  });
  return { client, ledger, requests, sleeps };
}

test('normal call: cost math and ledger entry', async () => {
  const { client, ledger } = setup();
  const r = await client.call(input);
  assert.equal(r.text, 'hi');
  assert.ok(Math.abs(r.costUsd - (0.003 + 0.0075)) < 1e-12);
  assert.equal(client.spent(), r.costUsd);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].outcome, 'ok');
  assert.equal(ledger.entries[0].agent, 'knox');
  assert.equal(ledger.entries[0].inputTokens, 1000);
});

test('remaining is cap minus spent', async () => {
  const { client } = setup();
  const r = await client.call(input);
  assert.ok(Math.abs(client.remaining() - (10 - r.costUsd)) < 1e-12);
});

test('refuses when worst case would cross the cap, and sends nothing', async () => {
  let sent = 0;
  const { client, ledger } = setup({ capUsd: 0.01, pauseAtUsd: 0.01, transport: async () => { sent++; return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; } });
  // worst case = 4 input tokens * 3/M + 1000 * 15/M = about $0.015 > $0.01
  await assert.rejects(client.call(input), SpendCapError);
  assert.equal(sent, 0);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].outcome, 'refused_cap');
});

test('worst case counts the whole prompt, not just the reply', async () => {
  const { client } = setup({ capUsd: 0.02, pauseAtUsd: 0.02 });
  const big = { ...input, maxTokens: 1, messages: [{ role: 'user' as const, content: 'x'.repeat(3_000_000) }] }; // 1M tokens = $3
  await assert.rejects(client.call(big), SpendCapError);
});

test('pause stops calls until a person resumes with a number', async () => {
  const { client, ledger } = setup({ capUsd: 10, pauseAtUsd: 0.01 });
  await client.call(input); // spends 0.0105, reaching the pause point
  await assert.rejects(client.call(input), SpendPausedError);
  assert.equal(ledger.entries.at(-1)?.outcome, 'refused_pause');
  assert.throws(() => client.resume(0.005, 'James', 'x'), RangeError); // not above spent
  assert.throws(() => client.resume(11, 'James', 'x'), RangeError); // above the cap
  assert.throws(() => client.resume(1, '', 'x'));
  client.resume(1, 'James', 'checked the first results');
  assert.match(ledger.entries.at(-1)!.note, /James.*checked the first results/);
  await client.call(input);
  assert.equal(client.pauseAt(), 1);
});

test('unknown model throws and is logged', async () => {
  const { client, ledger, requests } = setup();
  await assert.rejects(client.call({ ...input, model: 'nope' }), UnknownModelError);
  assert.equal(requests.length, 0);
  assert.equal(ledger.entries[0].outcome, 'error');
});

test('retries on 429 then succeeds, with doubling waits', async () => {
  let n = 0;
  const { client, ledger, sleeps } = setup({ transport: async () => {
    if (++n < 3) throw new TransportError('x', { status: n === 1 ? 429 : 503 });
    return { text: 'ok', usage: { inputTokens: 10, outputTokens: 10 } };
  } });
  const r = await client.call(input);
  assert.equal(r.text, 'ok');
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.deepEqual(ledger.entries.map((e) => e.outcome), ['error', 'error', 'ok']);
});

test('gives up after 2 retries', async () => {
  let n = 0;
  const { client } = setup({ transport: async () => { n++; throw new TransportError('x', { status: 500 }); } });
  await assert.rejects(client.call(input), ModelCallError);
  assert.equal(n, 3);
});

test('does not retry a 400', async () => {
  let n = 0;
  const { client } = setup({ transport: async () => { n++; throw new TransportError('x', { status: 400 }); } });
  await assert.rejects(client.call(input), ModelCallError);
  assert.equal(n, 1);
});

test('retries network errors (no status)', async () => {
  let n = 0;
  const { client } = setup({ transport: async () => { if (++n === 1) throw new Error('boom'); return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; } });
  assert.equal((await client.call(input)).text, 'ok');
});

test('a failed request that used tokens is charged, and a retry that would cross the cap is refused', async () => {
  let n = 0;
  // cap 0.02: first attempt fails but bills $0.012; worst case of the retry ($0.015) then crosses the cap.
  const { client, ledger } = setup({ capUsd: 0.02, pauseAtUsd: 0.02, transport: async () => {
    n++; throw new TransportError('x', { status: 529, usage: { inputTokens: 4000, outputTokens: 0 } });
  } });
  await assert.rejects(client.call(input), SpendCapError);
  assert.equal(n, 1);
  assert.ok(Math.abs(client.spent() - 0.012) < 1e-12);
  assert.deepEqual(ledger.entries.map((e) => e.outcome), ['error', 'refused_cap']);
});

test('every outcome writes a ledger entry', async () => {
  const { client, ledger } = setup({ capUsd: 0.02, pauseAtUsd: 0.01 });
  await client.call(input); // ok
  await assert.rejects(client.call(input), SpendPausedError); // refused_pause
  client.resume(0.012, 'J', 'r');
  await assert.rejects(client.call(input), SpendCapError); // refused_cap
  await assert.rejects(client.call({ ...input, model: 'zz' }), UnknownModelError); // error
  const outcomes = ledger.entries.map((e) => e.outcome);
  for (const o of ['ok', 'refused_pause', 'refused_cap', 'error']) assert.ok(outcomes.includes(o as never), o);
});

test('api key never appears in errors or ledger entries', async () => {
  const key = 'sk-ant-SECRET-123';
  const fakeFetch = (async (_url: string, init: any) => {
    assert.equal(init.headers['x-api-key'], key);
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    return new Response(JSON.stringify({ error: { message: `bad key ${key}` } }), { status: 401 });
  }) as unknown as typeof fetch;
  const ledger = new InMemoryLedger();
  const client = createModelClient({ transport: anthropicTransport({ apiKey: key, fetch: fakeFetch }), prices, capUsd: 10, pauseAtUsd: 5, ledger, now: () => T0, sleep: async () => {} });
  let message = '';
  try { await client.call(input); } catch (e) { message = String((e as Error).message) + JSON.stringify(e); }
  assert.ok(message.includes('401'));
  assert.ok(!message.includes(key));
  assert.ok(!JSON.stringify(ledger.entries).includes(key));
  const netFail = (async () => { throw new Error(`connect failed with ${key}`); }) as unknown as typeof fetch;
  await assert.rejects(anthropicTransport({ apiKey: key, fetch: netFail })({ model: 'm1', system: '', messages: [], maxTokens: 1 }), (e: Error) => !e.message.includes(key));
});

test('anthropicTransport reads text and usage from a good reply', async () => {
  const f = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], usage: { input_tokens: 7, output_tokens: 3 } }), { status: 200 })) as unknown as typeof fetch;
  const r = await anthropicTransport({ apiKey: 'k', fetch: f })({ model: 'm1', system: '', messages: [], maxTokens: 1 });
  assert.deepEqual(r, { text: 'ab', usage: { inputTokens: 7, outputTokens: 3 } });
});

test('bad cap or pause settings are rejected', () => {
  const base = { transport: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 } }), prices, ledger: new InMemoryLedger(), now: () => T0 };
  assert.throws(() => createModelClient({ ...base, capUsd: 0, pauseAtUsd: 0 }), RangeError);
  assert.throws(() => createModelClient({ ...base, capUsd: 5, pauseAtUsd: 6 }), RangeError);
});

test('calls sent at the same time cannot jointly pass the cap', async () => {
  // Worst case per call is about $0.015 (1000 tokens out at $15 per million). Cap fits one, not two.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let sent = 0;
  const transport: Transport = async () => { sent++; await gate; return { text: 'hi', usage: { inputTokens: 10, outputTokens: 10 } }; };
  const { client } = setup({ capUsd: 0.02, pauseAtUsd: 0.02, transport });
  const first = client.call(input);
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(client.call(input), SpendCapError);
  assert.equal(sent, 1);
  release();
  await first;
  assert.ok(client.remaining() < 0.02);
});
