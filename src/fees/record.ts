// The fee record: one row per price, in the format the owner approved. Plain code, no model.
// The rules here mirror the check constraints in supabase/migrations/0004_fees.sql and are
// written out in docs/fee-record.md. Change all three together.

import type { FeeLine, PriceKind } from '../deming/score.ts';

export const PRICE_KINDS = ['flat', 'rate', 'range', 'free', 'varies'] as const;
export const UNITS = ['per_item', 'per_day', 'per_month', 'per_quarter', 'per_year', 'per_statement',
  'one_time', 'per_hour', 'other'] as const;
export const AUDIENCES = ['consumer', 'business', 'both', 'unknown'] as const;
export const STATUSES = ['read', 'checked', 'live', 'withdrawn'] as const;

export type Unit = (typeof UNITS)[number];
export type Audience = (typeof AUDIENCES)[number];
export type Status = (typeof STATUSES)[number];

export interface FeeRecord {
  institutionId: number;
  sourceDocumentId: number;        // no document, no fee
  page: number | null;             // PDF page from 1; null for a web page
  quote: string;                   // the bank's exact words holding the fee's name and its price
  feeName: string;                 // as the bank writes it
  category: string | null;         // null = not yet sorted; never a guess
  priceKind: PriceKind;
  amountUsd: number | null;        // flat price, or the low end of a range; null or 0 when free
  amountMaxUsd: number | null;     // high end of a range
  ratePct: number | null;          // 1.5 means 1.5%; set only for a rate
  unit: Unit;
  conditions: string | null;
  product: string | null;
  audience: Audience;
  documentDate: string | null;     // as printed
  readAt: string;                  // timestamp
  runId: string;
  status: Status;
  withdrawalReason: string | null; // required when withdrawn
  quoteCheckedAt: string | null;   // set by the plain-code quote check
  quoteCheckVersion: string | null;
}

const blank = (s: unknown) => typeof s !== 'string' || s.trim() === '';
const isId = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
const badNumber = (n: number | null) => n != null && !(Number.isFinite(n) && n >= 0);

/** Every problem with the record, in plain words. An empty list means it is valid. */
export function validateFee(r: FeeRecord): string[] {
  const p: string[] = [];
  if (!isId(r.institutionId)) p.push('the institution is missing');
  if (!isId(r.sourceDocumentId)) p.push('the source document is missing: no document, no fee');
  if (r.page != null && !(Number.isInteger(r.page) && r.page >= 1)) p.push('the page must be a whole number from 1, or empty for a web page');
  if (blank(r.quote)) p.push('the quote is missing');
  if (blank(r.feeName)) p.push('the fee name is missing');
  if (r.category != null && blank(r.category)) p.push('the category must be a name from the list or empty (not yet sorted)');
  if (!PRICE_KINDS.includes(r.priceKind)) p.push(`the price kind "${r.priceKind}" is not one of ${PRICE_KINDS.join(', ')}`);
  if (!UNITS.includes(r.unit)) p.push(`the unit "${r.unit}" is not on the list`);
  if (!AUDIENCES.includes(r.audience)) p.push(`the audience "${r.audience}" is not one of ${AUDIENCES.join(', ')}`);
  if (!STATUSES.includes(r.status)) p.push(`the status "${r.status}" is not one of ${STATUSES.join(', ')}`);

  if (badNumber(r.amountUsd)) p.push('the amount must be a number, zero or more');
  if (badNumber(r.amountMaxUsd)) p.push('the highest amount must be a number, zero or more');
  if (badNumber(r.ratePct)) p.push('the percent must be a number, zero or more');
  if (r.priceKind === 'flat' && r.amountUsd == null) p.push('a flat fee needs an amount');
  if (r.priceKind === 'range') {
    if (r.amountUsd == null || r.amountMaxUsd == null) p.push('a range needs a lowest and a highest amount');
    else if (r.amountMaxUsd < r.amountUsd) p.push('the highest amount of a range is below the lowest');
  }
  if (r.priceKind === 'free' && (r.amountUsd ?? 0) !== 0) p.push('a free fee cannot have an amount above zero');
  if (r.priceKind === 'rate') {
    if (r.ratePct == null) p.push('a rate needs a percent');
    if (r.amountUsd != null || r.amountMaxUsd != null) p.push('a percent fee cannot also hold a dollar amount; a minimum or cap goes in the conditions');
  } else if (r.ratePct != null) {
    p.push('only a rate can hold a percent; a dollar fee and a percent fee are separate rows');
  }

  if (blank(r.readAt) || Number.isNaN(Date.parse(r.readAt))) p.push('the time the fee was read is missing');
  if (blank(r.runId)) p.push('the run that read the fee is missing');
  if (r.status === 'withdrawn' && blank(r.withdrawalReason)) p.push('a withdrawn fee needs a reason');
  if ((r.status === 'checked' || r.status === 'live') && r.quoteCheckedAt == null) p.push(`a fee cannot be ${r.status} before it has passed the quote check`);
  if ((r.quoteCheckedAt == null) !== (r.quoteCheckVersion == null)) p.push('the quote check time and version must be set together');
  return p;
}

/** The fee as the scorer sees it, field for field. */
export function toFeeLine(r: FeeRecord): FeeLine {
  return {
    institutionId: r.institutionId,
    feeName: r.feeName,
    quote: r.quote,
    priceKind: r.priceKind,
    amountUsd: r.amountUsd,
    amountMaxUsd: r.amountMaxUsd,
    ratePct: r.ratePct,
    unit: r.unit,
    product: r.product,
    audience: r.audience,
  };
}
