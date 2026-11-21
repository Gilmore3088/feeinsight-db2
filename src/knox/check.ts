// Knox's check: the model step. The candidate finder lists every priced line; Knox (a model,
// through the one wrapper with its spend cap) says which candidates are deposit-side service fees,
// tidies their names, products and audiences, and adds fees the finder missed. Plain code then
// holds the model to the document: an added fee is kept only if its quote is in the stored text
// word for word and its price is inside that quote, and a name is kept only if its words are in
// the document. Rules are written out in docs/knox.md. Change them there and here together.

import type { ModelClient } from '../model/wrapper.ts';
import type { PriceKind } from '../deming/score.ts';
import { normalizeText } from '../rosetta/normalize.ts';
import { figuresIn } from '../fees/quote-check.ts';
import { AUDIENCES, UNITS, type Audience, type Unit } from '../fees/record.ts';
import type { ReadFee, ReadInput } from './candidates.ts';

export const KNOX_MODEL = 'claude-sonnet-5-5';
/** Changes whenever the prompt or the rules below change, so scores can be tied to a version. */
export const KNOX_CHECK_VERSION = 'knox-check-1';
/** Candidates sent in one call. The whole document goes with every call. */
export const BATCH = 120;

export const SYSTEM = `You are Knox, the fee reader for FeeInsight, a dataset of the fees banks and credit unions charge.

You get one document's stored text and a numbered list of candidate fee lines that a plain-code
finder pulled from it, one line per price. Decide which candidates are real fees, and add any the
finder missed.

A fee belongs in the dataset when the document says the institution charges it for a deposit
account or a deposit-side service: account maintenance, overdraft and returned items, ATM and
card use, wires and transfers, stop payments, statements and copies, checks and cashier's checks,
research, dormant or closed accounts, safe deposit boxes, notary, coin and currency, and the like.
A fee the document prints as free, $0, waived or no charge is still a fee line.

It does not belong when the amount is:
- a balance, an opening deposit, a minimum to avoid a fee, a limit, a cap or a daily maximum;
- a rate paid to the customer (APY, dividend, interest) or an interest rate charged;
- a loan, mortgage, home equity, escrow, appraisal or trust fee;
- an example, a total, a reward, or another company's charge the institution only passes on;
- not the price of the fee the candidate names (the finder sometimes pairs a name with the wrong number).
If the same fee and price is listed twice, keep only the first.

For each kept candidate you may fix:
- feeName: the fee's name in the document's own words (with its section heading if that is what makes it clear);
- product: the account, card or tier the price is for, in the document's words, or null when it applies to all;
- audience: consumer, business, both or unknown;
- unit: one of ${UNITS.join(', ')}.

Add a fee the candidates missed only with a quote copied character for character from the text:
one line or sentence that holds the fee's name and its price. Never include the [page N] markers.

Answer with JSON only, no other words:
{"keep":[candidate numbers],
 "fix":[{"id":n,"feeName":"...","product":"..." or null,"audience":"...","unit":"..."}],
 "add":[{"quote":"...","feeName":"...","priceKind":"flat|range|rate|free","amountUsd":n or null,
         "amountMaxUsd":n or null,"ratePct":n or null,"unit":"...","product":"..." or null,"audience":"..."}]}
Leave out of "fix" any field you would not change. A candidate not in "keep" is dropped.`;

/** The document text with a [page N] marker at the start of each page, so Knox can tell pages apart. */
export function pagedText(input: ReadInput): string {
  const starts = input.pageStarts;
  if (!starts || starts.length < 2) return input.text;
  return starts.map((s, i) => `[page ${i + 1}]\n${input.text.slice(s, starts[i + 1] ?? input.text.length)}`).join('\n');
}

function candidateLine(c: ReadFee, id: number): string {
  const price = c.priceKind === 'free' ? 'free'
    : c.priceKind === 'rate' ? `${c.ratePct}%`
    : c.priceKind === 'range' ? `$${c.amountUsd} to $${c.amountMaxUsd}` : `$${c.amountUsd}`;
  return `${id}. ${c.feeName} | ${price}${c.product ? ` | product: ${c.product}` : ''} | quote: ${c.quote}`;
}

/** The user message for one batch. Only the last batch may add fees, so no fee is added twice. */
export function buildMessage(input: ReadInput, batch: ReadFee[], firstId: number, last = true): string {
  const note = last ? '' : '\n\nMore candidates follow in a later message. Decide these only, and leave "add" empty.';
  return `<document>\n${pagedText(input)}\n</document>\n\n<candidates>\n${
    batch.map((c, i) => candidateLine(c, firstId + i)).join('\n')}\n</candidates>${note}`;
}

export function maxTokensFor(n: number): number { return Math.min(16000, 1500 + 60 * n); }

const squash = (t: string) => normalizeText(t).replace(/ /g, '');
const wordsOf = (t: string) => normalizeText(t).toLowerCase().match(/[a-z]{3,}/g) ?? [];

/** The page (from 1) that holds the quote, or null for a document with no pages; undefined when it is not there. */
function pageOfQuote(input: ReadInput, quote: string): number | null | undefined {
  const wanted = squash(quote);
  if (!wanted) return undefined;
  const starts = input.pageStarts;
  if (!starts || starts.length === 0) return squash(input.text).includes(wanted) ? null : undefined;
  for (let i = 0; i < starts.length; i++) {
    if (squash(input.text.slice(starts[i], starts[i + 1] ?? input.text.length)).includes(wanted)) return i + 1;
  }
  return undefined;
}

const near = (list: number[], n: number) => list.some((v) => Math.abs(v - n) < 1e-9);
const FREE = /(?<![a-z])(free|no\s+charge|no\s+fee|n\/c|waived|none|\$\s?0(?:\.00)?(?![.\d]))(?![a-z])/i;

/** Is the stated price inside the quote? Plain code; the same idea as the full quote check. */
export function priceInQuote(quote: string, kind: PriceKind, amount: number | null, max: number | null, rate: number | null): boolean {
  const { money, percents } = figuresIn(quote);
  switch (kind) {
    case 'flat': return amount != null && amount > 0 && near(money, amount);
    case 'range': return amount != null && max != null && max > amount && near(money, max) && (amount === 0 || near(money, amount));
    case 'rate': return rate != null && rate > 0 && near(percents, rate);
    case 'free': return FREE.test(normalizeText(quote));
    default: return false;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v: unknown, limit = 200) => (typeof v === 'string' && v.trim() && v.length <= limit ? normalizeText(v) : null);

export interface CheckOutcome { fees: ReadFee[]; problems: string[] }

/** Turn Knox's reply for one batch into fee lines. Everything the model says is checked against the document. */
export function applyReply(reply: string, input: ReadInput, batch: ReadFee[], firstId: number, last = true): CheckOutcome {
  const problems: string[] = [];
  let body: any;
  try {
    body = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
  } catch {
    return { fees: [], problems: [`text ${input.textId}: the reply was not JSON; its ${batch.length} candidates were not decided`] };
  }
  const docWords = new Set(wordsOf(input.text));
  const nameOk = (name: string) => { const w = wordsOf(name); return w.length > 0 && w.every((x) => docWords.has(x)); };
  const fixes = new Map<number, any>();
  for (const f of Array.isArray(body.fix) ? body.fix : []) if (Number.isInteger(f?.id)) fixes.set(f.id, f);

  const fees: ReadFee[] = [];
  const kept = new Set<number>();
  for (const id of Array.isArray(body.keep) ? body.keep : []) {
    const c = batch[id - firstId];
    if (!Number.isInteger(id) || !c || kept.has(id)) continue;
    kept.add(id);
    const fee = { ...c };
    const f = fixes.get(id);
    if (f) {
      const name = text(f.feeName);
      if (name && nameOk(name)) fee.feeName = name;
      else if (name) problems.push(`text ${input.textId}: candidate ${id} name not taken, its words are not in the document`);
      if ('product' in f) {
        const product = f.product === null ? null : text(f.product);
        if (product === null || nameOk(product)) fee.product = product;
      }
      if (AUDIENCES.includes(f.audience)) fee.audience = f.audience as Audience;
      if (UNITS.includes(f.unit)) fee.unit = f.unit as Unit;
    }
    fees.push(fee);
  }

  for (const a of last && Array.isArray(body.add) ? body.add : []) {
    const quote = text(a?.quote, 600), feeName = text(a?.feeName);
    const kind = a?.priceKind as PriceKind;
    if (!quote || !feeName || !['flat', 'range', 'rate', 'free'].includes(kind)) {
      problems.push(`text ${input.textId}: an added fee was incomplete and was not kept`);
      continue;
    }
    const page = pageOfQuote(input, quote);
    if (page === undefined) { problems.push(`text ${input.textId}: an added fee's quote is not in the document; not kept`); continue; }
    const amount = kind === 'rate' || kind === 'free' ? null : num(a.amountUsd);
    const max = kind === 'range' ? num(a.amountMaxUsd) : null;
    const rate = kind === 'rate' ? num(a.ratePct) : null;
    if (!priceInQuote(quote, kind, amount, max, rate)) { problems.push(`text ${input.textId}: an added fee's price is not in its quote; not kept`); continue; }
    if (!nameOk(feeName)) { problems.push(`text ${input.textId}: an added fee's name is not in the document's words; not kept`); continue; }
    const product = text(a.product);
    fees.push({
      institutionId: input.institutionId, textId: input.textId, page, quote, feeName, priceKind: kind,
      amountUsd: amount, amountMaxUsd: max, ratePct: rate,
      unit: UNITS.includes(a.unit) ? a.unit : 'other', product: product && nameOk(product) ? product : null,
      audience: AUDIENCES.includes(a.audience) ? a.audience : 'unknown', conditions: null,
    });
  }
  return { fees, problems };
}

/** Check one document's candidates with Knox, a batch at a time. A failed batch drops its
 * candidates (the fee is not guessed) and says so in problems. Spend limits are the wrapper's. */
export async function checkDocument(client: ModelClient, runId: string, input: ReadInput, candidates: ReadFee[]): Promise<CheckOutcome> {
  const out: CheckOutcome = { fees: [], problems: [] };
  // A document with no candidates still gets one call, so Knox can read what the finder could not split.
  const batches = candidates.length ? Math.ceil(candidates.length / BATCH) : 1;
  for (let b = 0; b < batches; b++) {
    const batch = candidates.slice(b * BATCH, (b + 1) * BATCH);
    const firstId = b * BATCH + 1;
    const res = await client.call({
      agent: 'knox', runId, model: KNOX_MODEL, system: SYSTEM,
      messages: [{ role: 'user', content: buildMessage(input, batch, firstId, b === batches - 1) }], maxTokens: maxTokensFor(batch.length),
    });
    const r = applyReply(res.text, input, batch, firstId, b === batches - 1);
    out.fees.push(...r.fees);
    out.problems.push(...r.problems);
  }
  return { fees: dedupe(out.fees), problems: out.problems };
}

/** The same price on overlapping words counts once: an added fee that repeats a kept candidate goes. */
function dedupe(fees: ReadFee[]): ReadFee[] {
  const kept: ReadFee[] = [];
  for (const f of fees) {
    const q = squash(f.quote);
    const dup = kept.some((k) => k.priceKind === f.priceKind && k.amountUsd === f.amountUsd && k.amountMaxUsd === f.amountMaxUsd
      && k.ratePct === f.ratePct && (k.product ?? '') === (f.product ?? '') && (squash(k.quote).includes(q) || q.includes(squash(k.quote))));
    if (!dup) kept.push(f);
  }
  return kept;
}
