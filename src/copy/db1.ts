// Turns rows copied read-only from today's system (DB1) into DB2's shapes, so DB1's answer key
// can serve as a practice key and DB1's live fees can be scored as the baseline. Data only:
// no DB1 code is used. Plain code, no model.

import type { FeeLine, PriceKind } from '../deming/score.ts';
import type { KeyFile, KeyLine } from '../deming/key-file.ts';
import type { Unit } from '../fees/record.ts';

const UNIT: Record<string, Unit> = {
  per_item: 'per_item', per_transaction: 'per_item', per_occurrence: 'per_item', per_transfer: 'per_item',
  per_page: 'per_item', per_sheet: 'per_item', per_document: 'per_item', per_image: 'per_item',
  monthly: 'per_month', annual: 'per_year', quarterly: 'per_quarter', daily: 'per_day', per_day: 'per_day',
  one_time: 'one_time', per_hour: 'per_hour', 'per hour': 'per_hour', hourly: 'per_hour',
  per_statement: 'per_statement', per_statement_cycle: 'per_statement', per_cycle: 'per_statement',
};

/** DB1's frequency words in DB2's units. Anything not on the list (half hours, blanks) is `other`. */
export function db1Unit(frequency: string | null): Unit {
  return (frequency && UNIT[frequency.trim().toLowerCase()]) || 'other';
}

/** DB1 keeps every price as fixed, free or varies. A fixed price of zero is free. */
export function db1Price(kind: string | null, amount: number | null): { priceKind: PriceKind; amountUsd: number | null } {
  if (kind === 'varies') return { priceKind: 'varies', amountUsd: null };
  if (kind === 'free' || amount === 0) return { priceKind: 'free', amountUsd: null };
  return { priceKind: 'flat', amountUsd: amount };
}

/** DB1's fee keys are snake case ("nsf_fee"); as a name they read as words. */
export const keyName = (k: string) => k.replace(/_/g, ' ').trim();

export interface Db1KeyInstitution { akid: number; inst: number; status: string; url: string; hash: string | null; name: string; charter: 'bank' | 'credit_union'; confirmed_at: string | null; prefilled_at: string | null }
/** [fee id, institution id, institution status, fee status, key, amount, kind, frequency, conditions, source line, uncertain] */
export type Db1KeyFee = [number, number, string, string, string, number | null, string | null, string | null, string | null, string | null, boolean | null];

/** DB1's answer key as a DB2 practice key. Only lines a person confirmed, from institutions a person
 * confirmed, are kept, unless `prefilled` is set. Lines with no source words cannot be checked and are
 * left out; the count is returned. */
export function db1PracticeKey(insts: Db1KeyInstitution[], fees: Db1KeyFee[], prefilled = false): { key: KeyFile; skipped: number } {
  const keep = insts.filter((i) => prefilled || i.status === 'confirmed');
  const byInst = new Map(keep.map((i) => [i.inst, i]));
  const lines: KeyLine[] = [];
  let skipped = 0;
  for (const [, inst, instStatus, status, key, amount, kind, freq, conditions, quote] of fees) {
    const i = byInst.get(inst);
    if (!i || (!prefilled && (instStatus !== 'confirmed' || status !== 'confirmed'))) continue;
    if (!quote?.trim()) { skipped++; continue; }
    const price = db1Price(kind, amount);
    lines.push({
      institutionId: inst, textId: i.akid, page: null, quote, feeName: keyName(key), ...price, amountMaxUsd: null,
      ratePct: null, unit: db1Unit(freq), conditions, product: null, audience: 'unknown',
      recordedBy: status === 'confirmed' ? 'person (DB1 answer key)' : 'DB1 prefill',
    });
  }
  return {
    skipped,
    key: {
      name: prefilled ? 'db1-practice-all' : 'db1-practice-confirmed', kind: 'dev', status: 'sealed', drawSeed: null,
      drawRule: 'DB1 answer key institutions (not a random draw; DB1 was tuned on them). For tuning DB2, never for proving it.',
      institutions: keep.map((i) => ({
        institutionId: i.inst, name: i.name, charter: i.charter, drawRank: null,
        documents: [{ textId: i.akid, sourceDocumentId: null, url: i.url, textSha: i.hash, fetchedAt: i.confirmed_at ?? i.prefilled_at }],
        notes: null,
      })),
      lines, confirmations: [],
    },
  };
}

/** [institution id, fee name, amount, frequency, audience, product, fee key] from DB1's published catalog. */
export type Db1LiveFee = [number, string | null, number | null, string | null, string | null, string | null, string | null];

/** DB1's live fees as reader fees. DB1 stores no quote with a live fee, so the name stands in for it. */
export function db1LiveFees(rows: Db1LiveFee[]): FeeLine[] {
  return rows.map(([inst, name, amount, freq, audience, product, key]) => {
    const feeName = name?.trim() || keyName(key ?? 'unnamed');
    return {
      institutionId: inst, feeName, quote: feeName, ...db1Price('fixed', amount), amountMaxUsd: null, ratePct: null,
      unit: db1Unit(freq), product: product ?? null, audience: audience ?? 'unknown',
    };
  });
}
