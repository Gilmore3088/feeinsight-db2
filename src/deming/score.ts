// Deming's scorer: plain code, no model. It compares the fees a reader produced with the
// sealed answer key and reports precision and recall. It is the only scorer in DB2.
// Rules are written out in docs/scoring.md. Change them there and here together.

export type PriceKind = 'flat' | 'rate' | 'range' | 'free' | 'varies';

export interface FeeLine {
  institutionId: number;
  feeName: string;
  quote: string;
  priceKind: PriceKind;
  amountUsd?: number | null;
  amountMaxUsd?: number | null;
  ratePct?: number | null;
  unit?: string | null;
  product?: string | null;
  audience?: string | null;
}

export interface Counts {
  keyLines: number;      // key lines that are scored (priced lines; 'varies' is left out)
  readerFees: number;    // every fee the reader produced, 'varies' included
  matched: number;       // one reader fee paired with one key line
  wrongPrice: number;    // same fee found, different price (counts against precision and recall)
  extra: number;         // reader fees with no key line at all (duplicates land here)
  missed: number;        // key lines no reader fee matched
  audienceMixUps: number; // matched pairs where one says consumer and the other business
  unitMismatches: number; // matched pairs with different units
}

export interface Score extends Counts {
  precision: number | null; // matched / readerFees
  recall: number | null;    // matched / keyLines
  precisionInterval: [number, number] | null; // 95% Wilson interval
  recallInterval: [number, number] | null;
}

export interface ScoreReport {
  total: Score;
  byInstitution: Map<number, Score>;
}

const SAME_FEE = 0.6; // share of words two fee descriptions must have in common

const cents = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100));

// Words that say nothing about which fee it is.
const FILLER = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'per', 'each', 'fee', 'fees', 'charge', 'charges', 'or', 'to', 'on', 'in']);

export function words(text: string): Set<string> {
  const all = text.toLowerCase().replace(/[$][\d,.]+|\d+(\.\d+)?%/g, ' ').match(/[a-z0-9]+/g) ?? [];
  const kept = all.filter((w) => !FILLER.has(w));
  return new Set(kept.length ? kept : all);
}

/** How much two descriptions share, 0 to 1: twice the shared words over the words in both.
 * A short name inside a much longer one scores low, so "NSF" does not pass for "Safe deposit box NSF". */
export function overlap(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** How alike two lines are as descriptions of one fee: the better of name and quote overlap. */
export function sameFee(a: FeeLine, b: FeeLine): number {
  const product = a.product && b.product && overlap(a.product, b.product) === 0 ? 0.5 : 1;
  return Math.max(overlap(a.feeName, b.feeName), overlap(a.quote, b.quote)) * product;
}

export function samePrice(a: FeeLine, b: FeeLine): boolean {
  if (a.priceKind !== b.priceKind) return false;
  switch (a.priceKind) {
    case 'free': return true;
    case 'flat': return cents(a.amountUsd) === cents(b.amountUsd) && cents(a.ratePct) === cents(b.ratePct);
    case 'range': return cents(a.amountUsd) === cents(b.amountUsd) && cents(a.amountMaxUsd) === cents(b.amountMaxUsd);
    case 'rate': return cents(a.ratePct) === cents(b.ratePct) && cents(a.amountUsd) === cents(b.amountUsd);
    case 'varies': return true;
  }
}

function wilson(hits: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96, p = hits / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

function finish(c: Counts): Score {
  return {
    ...c,
    precision: c.readerFees ? c.matched / c.readerFees : null,
    recall: c.keyLines ? c.matched / c.keyLines : null,
    precisionInterval: wilson(c.matched, c.readerFees),
    recallInterval: wilson(c.matched, c.keyLines),
  };
}

const empty = (): Counts => ({
  keyLines: 0, readerFees: 0, matched: 0, wrongPrice: 0, extra: 0, missed: 0, audienceMixUps: 0, unitMismatches: 0,
});

function scoreInstitution(key: FeeLine[], reader: FeeLine[]): Counts {
  const c = empty();
  const scoredKey = key.filter((k) => k.priceKind !== 'varies');
  c.keyLines = scoredKey.length;
  c.readerFees = reader.length;

  // Every possible pair that describes the same fee, best first; a right price beats a wrong one.
  const pairs: { k: number; r: number; like: number; price: boolean }[] = [];
  scoredKey.forEach((k, ki) => reader.forEach((r, ri) => {
    const like = sameFee(k, r);
    if (like >= SAME_FEE) pairs.push({ k: ki, r: ri, like, price: samePrice(k, r) });
  }));
  pairs.sort((a, b) => Number(b.price) - Number(a.price) || b.like - a.like || a.k - b.k || a.r - b.r);

  const keyUsed = new Set<number>(), readerUsed = new Set<number>();
  for (const p of pairs) {
    if (keyUsed.has(p.k) || readerUsed.has(p.r)) continue;
    keyUsed.add(p.k); readerUsed.add(p.r);
    if (!p.price) { c.wrongPrice++; continue; }
    c.matched++;
    const k = scoredKey[p.k], r = reader[p.r];
    const sides = new Set([k.audience, r.audience]);
    if (sides.has('consumer') && sides.has('business')) c.audienceMixUps++;
    if ((k.unit ?? 'other') !== (r.unit ?? 'other')) c.unitMismatches++;
  }
  c.missed = c.keyLines - keyUsed.size;
  c.extra = c.readerFees - readerUsed.size;
  return c;
}

/** Score a reader's fees against the key. Institutions come from the key: a reader fee for an
 * institution outside the key is ignored, and a key institution with no reader fees scores zero recall. */
export function score(key: FeeLine[], reader: FeeLine[]): ScoreReport {
  const ids = [...new Set(key.map((k) => k.institutionId))].sort((a, b) => a - b);
  const total = empty();
  const byInstitution = new Map<number, Score>();
  for (const id of ids) {
    const c = scoreInstitution(key.filter((k) => k.institutionId === id), reader.filter((r) => r.institutionId === id));
    byInstitution.set(id, finish(c));
    for (const f of Object.keys(total) as (keyof Counts)[]) total[f] += c[f];
  }
  return { total: finish(total), byInstitution };
}
