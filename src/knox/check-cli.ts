// Run Knox over stored texts: the candidate finder, then Knox's check on Sonnet through the one wrapper.
//   node src/knox/check-cli.ts --texts <texts.json> --ledger <spend-ledger.jsonl> --out <fees.json> [--run-cap 25]
// The texts file holds { texts: [{ textId, institutionId, text, pageStarts }] }.
// It always prints the most this run could cost first. It refuses to start when that is over the run
// cap (more than $25 needs James's yes), stops before anything is sent when ANTHROPIC_API_KEY is not
// set, and pauses once this run has spent the run cap. The total cap of $200 is held in the ledger
// file across runs (James, 2026-11-21). See docs/model-wrapper.md and docs/knox.md.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  anthropicTransport, createModelClient, FileLedger, ModelCallError, SpendCapError, SpendPausedError,
} from '../model/wrapper.ts';
import { readDocument, type ReadFee, type ReadInput } from './candidates.ts';
import { BATCH, buildMessage, checkDocument, KNOX_CHECK_VERSION, KNOX_MODEL, maxTokensFor, SYSTEM } from './check.ts';

export const TOTAL_CAP_USD = 200;
export const PRICES = { [KNOX_MODEL]: { inputPerMillion: 2, outputPerMillion: 10 } };

const { values } = parseArgs({
  options: { texts: { type: 'string' }, ledger: { type: 'string' }, out: { type: 'string' }, 'run-cap': { type: 'string', default: '25' } },
});
if (!values.texts || !values.ledger || !values.out) {
  console.error('usage: node src/knox/check-cli.ts --texts <texts.json> --ledger <spend-ledger.jsonl> --out <fees.json> [--run-cap 25]');
  process.exit(2);
}
const runCap = Number(values['run-cap']);
if (!Number.isFinite(runCap) || runCap <= 0) { console.error('--run-cap must be a positive number'); process.exit(2); }

const { texts } = JSON.parse(readFileSync(values.texts, 'utf8')) as { texts: ReadInput[] };
const work = texts.map((t) => ({ input: t, candidates: readDocument(t) }));

// The most this run could cost: the wrapper's own worst case (3 characters a token, every output token used).
const price = PRICES[KNOX_MODEL];
let worst = 0;
for (const { input, candidates } of work) {
  const batches = Math.max(1, Math.ceil(candidates.length / BATCH));
  for (let b = 0; b < batches; b++) {
    const batch = candidates.slice(b * BATCH, (b + 1) * BATCH);
    const chars = SYSTEM.length + buildMessage(input, batch, b * BATCH + 1, b === batches - 1).length;
    worst += (Math.ceil(chars / 3) * price.inputPerMillion + maxTokensFor(batch.length) * price.outputPerMillion) / 1e6;
  }
}
const ledger = new FileLedger(values.ledger, {
  read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
  append: (p, line) => appendFileSync(p, line),
});
const spentBefore = ledger.total();
const candidateCount = work.reduce((n, w) => n + w.candidates.length, 0);
console.error(`${texts.length} texts, ${candidateCount} candidates. Most this run could cost: $${worst.toFixed(2)}. `
  + `Spent so far: $${spentBefore.toFixed(2)} of $${TOTAL_CAP_USD}.`);
if (worst > runCap) {
  console.error(`refused: the most this run could cost is over the run cap of $${runCap}. A run over $25 needs James's yes.`);
  process.exit(3);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('stopped before any model call: ANTHROPIC_API_KEY is not set (James sets it himself; see docs/model-wrapper.md)');
  process.exit(4);
}

const client = createModelClient({
  transport: anthropicTransport({ apiKey }), prices: PRICES, capUsd: TOTAL_CAP_USD,
  pauseAtUsd: Math.min(TOTAL_CAP_USD, spentBefore + runCap), ledger, now: () => new Date(),
});
const runId = `${KNOX_CHECK_VERSION}-${new Date().toISOString()}`;
const fees: ReadFee[] = [];
const problems: string[] = [];
let stopped: string | null = null, done = 0;

async function worker(queue: typeof work) {
  for (let w = queue.shift(); w && !stopped; w = queue.shift()) {
    try {
      const r = await checkDocument(client, runId, w.input, w.candidates);
      fees.push(...r.fees);
      problems.push(...r.problems);
      done++;
    } catch (err) {
      if (err instanceof SpendPausedError || err instanceof SpendCapError) stopped = err.message;
      else if (err instanceof ModelCallError) problems.push(`text ${w.input.textId}: ${err.message}; not read`);
      else throw err;
    }
  }
}
const queue = [...work];
await Promise.all([1, 2, 3, 4].map(() => worker(queue)));

writeFileSync(values.out, JSON.stringify(fees));
console.error(`${done} of ${texts.length} texts checked, ${fees.length} fees kept. This run cost $${(client.spent() - spentBefore).toFixed(2)}; `
  + `spent so far $${client.spent().toFixed(2)} of $${TOTAL_CAP_USD}. ${problems.length} problems.`);
for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
if (stopped) { console.error(`stopped early: ${stopped}`); process.exit(5); }
