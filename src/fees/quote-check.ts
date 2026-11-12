// The full quote check: plain code, no model. A fee is kept only if its exact quote is in
// the stored text of its document, on the page it claims, and its price is inside that quote.
// Rules are written out in docs/fee-record.md. Change them there and here together.

import type { StandardPage, StandardSource } from '../rosetta/convert.ts';
import { containsQuote, normalizeText } from '../rosetta/normalize.ts';
import { validateFee, type FeeRecord } from './record.ts';

/** Changes whenever the same fee and text could get a different answer. */
export const QUOTE_CHECK_VERSION = 'quote-check-1';

export interface CheckResult {
  ok: boolean;
  problems: string[];
  /** The page the quote was found on: the claimed page when it is there, otherwise the first
   * page that holds it. Null for a web page, or when the quote was not found. */
  page: number | null;
}

export interface Figures { money: number[]; percents: number[] }

// A run of digits with its commas and points, an optional dollar sign before it and an
// optional percent or cents mark after it. A run that follows a letter, digit, point or
// comma is not a figure of its own ("A4", the tail of "1.500.00").
const FIGURE = /(\$\s*)?(?<![\d.,A-Za-z])(\.?\d[\d.,]*)(\s*(?:%|percent\b|¢|cents?\b))?/gi;
const WELL_FORMED = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?$/; // commas only as thousands separators

/** Every money figure and every percent figure in a piece of text, as numbers.
 * Money is: a number after a dollar sign ("$30", "$1,500", "$1.500" is 1.5); a bare number
 * with a point and exactly two digits ("30.00", "1,500.00"); or a number before a cents mark
 * ("25¢", "25 cents"). A bare whole number ("30 days", "300") is not money. A number before
 * "%" or "percent" is a percent and never money. A number with misplaced commas is nothing. */
export function figuresIn(text: string): Figures {
  const out: Figures = { money: [], percents: [] };
  for (const m of normalizeText(text).matchAll(FIGURE)) {
    const parts = WELL_FORMED.exec(m[2].replace(/[.,]+$/, '')); // drop sentence punctuation
    if (!parts || !/\d/.test(parts[0])) continue;
    const value = Number(`${parts[1].replace(/,/g, '') || '0'}.${parts[2] ?? '0'}`);
    const dollar = m[1] !== undefined;
    const mark = (m[3] ?? '').trim().toLowerCase();
    if (mark === '%' || mark === 'percent') { if (!dollar) out.percents.push(value); }
    else if (mark) { if (!dollar) out.money.push(value / 100); }
    else if (dollar || parts[2]?.length === 2) out.money.push(value);
  }
  return out;
}

const has = (list: number[], n: number) => list.some((v) => Math.abs(v - n) < 1e-9);
const usd = (n: number) => `$${n.toFixed(2)}`;

const FREE_PHRASE = /(?<![a-z])(free|no\s+charge|no\s+fee|n\/c|waived|included|complimentary|none)(?![a-z])/i;
const UP_TO = /(?<![a-z])(up\s+to|not\s+to\s+exceed|no\s+more\s+than|maximum|max)(?![a-z])/i;
// Words that say nothing about which fee it is.
const FILLER = new Set(['fee', 'fees', 'charge', 'charges', 'the', 'and', 'for', 'per', 'each']);
// Ways of taking text that this check does not trust on a page marked for image reading.
// A later image-reading method is not on this list.
const TEXT_METHODS = ['pdf_text', 'html_visible', 'none'];

/** Problems with the price: is every stored number inside the quote? */
function priceProblems(r: FeeRecord): string[] {
  const p: string[] = [];
  const { money, percents } = figuresIn(r.quote);
  const upTo = UP_TO.test(normalizeText(r.quote)) || UP_TO.test(normalizeText(r.conditions ?? ''));
  const need = (n: number | null, what: string) => {
    if (n != null && !has(money, n)) p.push(`${what} ${usd(n)} is not in the quote as a dollar figure`);
  };
  switch (r.priceKind) {
    case 'flat':
      need(r.amountUsd, 'the amount');
      need(r.amountMaxUsd, 'the highest amount');
      break;
    case 'range':
      // "Up to $20" is a range from 0 to 20: the 0 is not printed, so it need not be found.
      if (!(r.amountUsd === 0 && upTo)) need(r.amountUsd, 'the lowest amount');
      need(r.amountMaxUsd, 'the highest amount');
      break;
    case 'rate':
      if (r.ratePct != null && !has(percents, r.ratePct)) p.push(`the percent ${r.ratePct}% is not in the quote as a percent figure`);
      break;
    case 'free':
      if (!has(money, 0) && !FREE_PHRASE.test(normalizeText(r.quote))) p.push('the quote does not say the fee is free (free, no charge, no fee, n/c, waived, included, complimentary, none or $0)');
      need(r.amountMaxUsd, 'the highest amount');
      break;
    case 'varies':
      if (normalizeText(r.quote).split(' ').length < 2) p.push('the quote for a fee that varies must be at least two words');
      need(r.amountUsd, 'the amount');
      need(r.amountMaxUsd, 'the highest amount');
      break;
  }
  return p;
}

/** Does the quote hold at least one telling word of the fee's name? */
function nameIsInQuote(feeName: string, quote: string): boolean {
  const text = normalizeText(quote).toLowerCase();
  const all = normalizeText(feeName).toLowerCase().match(/[a-z]{3,}/g) ?? [];
  const telling = all.filter((w) => !FILLER.has(w));
  const wanted = telling.length ? telling : all;
  // A name with no word of three letters ("PO") must appear whole.
  if (wanted.length === 0) return text.includes(normalizeText(feeName).toLowerCase());
  return wanted.some((w) => text.includes(w));
}

/** The pages of the source that hold the quote. A quote is never matched across two pages. */
function pagesWithQuote(source: StandardSource, quote: string): StandardPage[] {
  return source.pages.filter((pg) => containsQuote({ ...source, pages: [pg] }, quote).found);
}

/** The whole check. It passes only when the record is valid, the quote is in the stored
 * text on the claimed page, that page's text is trusted, the price is inside the quote and
 * the quote names the fee. */
export function checkFee(record: FeeRecord, source: StandardSource): CheckResult {
  const problems = validateFee(record);
  if (source.sourceDocumentId !== record.sourceDocumentId) problems.push('the text given is not the text of the fee\'s source document');
  if (typeof record.quote !== 'string' || typeof record.feeName !== 'string') return { ok: false, problems, page: null };

  const holders = pagesWithQuote(source, record.quote);
  const claimed = holders.find((pg) => pg.page === record.page);
  const at = claimed ?? holders[0];
  if (holders.length === 0) {
    problems.push('the quote is not in the stored text of the document');
  } else if (!claimed) {
    const where = holders.map((pg) => (pg.page == null ? 'a web page with no page number' : `page ${pg.page}`)).join(', ');
    problems.push(`the quote is not on ${record.page == null ? 'a web page (no page was given)' : `page ${record.page}`}; it was found on ${where}`);
  }
  if (at?.needsImageReading && TEXT_METHODS.includes(at.method)) {
    problems.push('the quote sits on a page marked for image reading; its text is not trusted');
  }

  problems.push(...priceProblems(record));
  if (!nameIsInQuote(record.feeName, record.quote)) problems.push('no word of the fee name is in the quote');
  return { ok: problems.length === 0, problems, page: at?.page ?? null };
}
