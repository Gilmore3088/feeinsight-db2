// The plain-code reader: finds every priced line in a document's stored text and turns each price
// into one fee line with the bank's exact words. No model. Rules are written out in docs/reader.md.
// It keeps what it cannot price ('varies') out, because an unpriced line is not scored and only
// lowers precision.

import type { FeeLine, PriceKind } from '../deming/score.ts';
import type { Audience, Unit } from '../fees/record.ts';

export interface ReadFee extends FeeLine {
  textId: number;
  page: number | null;
  conditions: string | null;
  unit: Unit;
  audience: Audience;
}

export interface ReadInput {
  textId: number;
  institutionId: number;
  text: string;
  pageStarts: number[] | null;
}

interface Price {
  kind: PriceKind;
  amountUsd: number | null;
  amountMaxUsd: number | null;
  ratePct: number | null;
}

const MONEY = String.raw`\$\s?(\d[\d,]*(?:\.\d+)?|\.\d+)`;
const RANGE = new RegExp(String.raw`${MONEY}\s*(?:-|–|—|to)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)`, 'gi');
const AMOUNT = new RegExp(MONEY, 'gi');
const RATE = /(\d+(?:\.\d+)?)\s?%/g;
const FREE_CELL = /^(?:\$\s?0(?:\.00)?(?![.\d])|no\s+(?:monthly\s+)?(?:charge|fee|cost)s?\b|free\b|none\b|waived\b|n\/c\b)/i;
// A row that states a balance, a deposit or a limit, not a fee.
const CONDITION_NAME = /((minimum|min\.?|initial|opening)\s+(daily\s+|average\s+|opening\s+)?(balance|deposit)|to (avoid|open|earn|obtain)|\blimits?\b|balance (to|required)|tier \d|apy|dividend|interest rate|annual percentage)/i;
const FEE_NAME = /(fee|charge|assessment|surcharge|penalty|cost)/i;
// Out of scope: DB2 holds deposit-side service fees. Loan, mortgage and trust fees are not read.
const OUT_OF_SCOPE = /\b(loans?|mortgages?|heloc|home equity|escrow|(?<!ach )origination|appraisal|underwriting|closing costs?|trust (?:fees?|services))\b/i;

// Words near an amount that make it a condition (a balance, a limit), not the fee's price.
const BEFORE_CONDITION = /(minimum|lose|limit of|maximum charge of|cap of|balance|less than|more than|greater than|over|under|above|below|exceeds?|up to|at least|limit(?:ed)? to|totaling|no more than|maximum of|max(?:imum)?|deposits? of|purchases? of|withdrawals? of|transactions? of|in excess of|first|loans? of|line of)\s*(?:a|an|the|of|daily|average)?\s*$/i;
const AFTER_CONDITION = /^\s*(?:maximum|max\b|cap\b|daily maximum|or more|or less|or greater|minimum|min\b|balance|average|daily balance|in (?:deposits|transactions|purchases)|limit|increments|and above|and up|or higher|per day limit)/i;
const RATE_NOT_FEE = /(apr|apy|annual percentage|interest|dividend|rate of|yield|withhold|tax)/i;
const FEE_WORD = /\b(fees?|charges?d?|assessed|costs?|service charge|we (?:will )?charge|price|surcharge|per item|each|monthly)\b/i;

function num(s: string): number { return Number(s.replace(/,/g, '')); }

/** Prices in a piece of text, in order. Amounts that read as conditions are left out. */
export function prices(text: string): Price[] {
  const out: { at: number; p: Price }[] = [];
  const taken: [number, number][] = [];
  for (const m of text.matchAll(RANGE)) {
    const lo = num(m[1]), hi = num(m[2]);
    if (hi > lo) { out.push({ at: m.index!, p: { kind: 'range', amountUsd: lo, amountMaxUsd: hi, ratePct: null } }); taken.push([m.index!, m.index! + m[0].length]); }
  }
  for (const m of text.matchAll(AMOUNT)) {
    const at = m.index!;
    if (taken.some(([a, b]) => at >= a && at < b)) continue;
    const before = text.slice(Math.max(0, at - 40), at), after = text.slice(at + m[0].length, at + m[0].length + 30);
    if (BEFORE_CONDITION.test(before) || AFTER_CONDITION.test(after)) continue;
    const v = num(m[1]);
    if (!(v >= 0) || v >= 5000) continue;
    out.push({ at, p: v === 0 ? { kind: 'free', amountUsd: null, amountMaxUsd: null, ratePct: null } : { kind: 'flat', amountUsd: v, amountMaxUsd: null, ratePct: null } });
  }
  for (const m of text.matchAll(RATE)) {
    const near = text.slice(Math.max(0, m.index! - 60), m.index! + m[0].length + 30);
    if (RATE_NOT_FEE.test(near)) continue;
    out.push({ at: m.index!, p: { kind: 'rate', amountUsd: null, amountMaxUsd: null, ratePct: Number(m[1]) } });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.p);
}

const UNIT_WORDS: [RegExp, Unit][] = [
  [/per hour|\/hr|hourly|an hour/i, 'per_hour'],
  [/per statement|per cycle|statement cycle/i, 'per_statement'],
  [/per month|monthly|a month|\/mo\b/i, 'per_month'],
  [/per quarter|quarterly/i, 'per_quarter'],
  [/per year|annual(?:ly)?|a year|\/yr\b|yearly/i, 'per_year'],
  [/per day|daily|a day/i, 'per_day'],
  [/one[- ]time|at opening|setup/i, 'one_time'],
  [/each|per (?:item|check|transfer|transaction|occurrence|request|copy|page|roll|package|order|card|wire|withdrawal|deposit|inquiry|use|box|book)|\bea\.?\b/i, 'per_item'],
];
export function unitOf(text: string): Unit {
  for (const [re, u] of UNIT_WORDS) if (re.test(text)) return u;
  return 'other';
}

export function audienceOf(text: string): Audience {
  const b = /\b(business|commercial|corporate|merchant|non-?profit)\b/i.test(text);
  const c = /\b(personal|consumer|individual)\b/i.test(text);
  return b && !c ? 'business' : c && !b ? 'consumer' : 'unknown';
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const hasPrice = (s: string) => /\$\s?\.?\d|\d\s?%|\bno (?:monthly )?(?:charge|fee)s?\b|^free$/i.test(s);
const nameOf = (s: string) => clean(s.replace(RANGE, ' ').replace(AMOUNT, ' ').replace(RATE, ' ').replace(/\.{2,}/g, ' ').replace(/[|:–—-]\s*$/, ''));
const wordCount = (s: string) => (s.match(/[a-z]{2,}/gi) ?? []).length;

/** A heading: a short line with no price, ending in a colon or written like a title. */
function headingOf(line: string): string | null {
  const t = clean(line);
  if (!t || t.length > 70 || hasPrice(t) || t.includes(' | ')) return null;
  if (/:$/.test(t)) return t.replace(/:$/, '');
  const ws = t.split(' ');
  if (ws.length <= 6 && ws.every((w) => /^[A-Z0-9&(/'’-]/.test(w) || /^(of|and|or|the|for|to|a|an|in|on|with)$/.test(w))) return t;
  return null;
}

/** Split a line into a name part and price cells. Dot leaders and "Name – $5" count as cells. */
function cellsOf(line: string): string[] {
  let t = line.replace(/\s*\.{3,}\s*/g, ' | ');
  if (!t.includes(' | ')) t = t.replace(/\s+[–—-]\s+(?=\$|no charge|no fee|free\b)/i, ' | ');
  const cells = t.split(' | ').map(clean).filter(Boolean);
  // "$ | 2.00": a lone dollar sign belongs to the number in the next cell.
  for (let i = cells.length - 2; i >= 0; i--) if (cells[i] === '$' && /^\d/.test(cells[i + 1])) cells.splice(i, 2, `$${cells[i + 1]}`);
  return cells;
}

function pageAt(pageStarts: number[] | null, offset: number): number | null {
  if (!pageStarts || pageStarts.length === 0) return null;
  let p = 0;
  for (let i = 0; i < pageStarts.length; i++) if (pageStarts[i] <= offset) p = i;
  return p + 1;
}

function row(input: ReadInput, offset: number, quote: string, feeName: string, p: Price, context: string, product: string | null, conditions: string | null): ReadFee | null {
  if (OUT_OF_SCOPE.test(feeName)) return null;
  return {
    institutionId: input.institutionId, textId: input.textId, page: pageAt(input.pageStarts, offset),
    quote, feeName, priceKind: p.kind, amountUsd: p.amountUsd, amountMaxUsd: p.amountMaxUsd, ratePct: p.ratePct,
    unit: unitOf(context), product, audience: audienceOf(context), conditions,
  };
}

/** Read one document: one fee line per price found, with the line the price came from as the quote. */
export function readDocument(input: ReadInput): ReadFee[] {
  const out: ReadFee[] = [];
  const push = (f: ReadFee | null) => { if (f) out.push(f); };
  const lines = input.text.split('\n');
  let offset = 0, heading: string | null = null, header: string[] | null = null, lastName: string | null = null;
  for (const raw of lines) {
    const here = offset;
    offset += raw.length + 1;
    const line = clean(raw);
    if (!line) continue;
    const h = headingOf(line);
    if (h) { heading = h; header = null; lastName = h; continue; }
    const cells = cellsOf(line);
    const priced = cells.map((c) => hasPrice(c));
    if (!priced.some(Boolean)) {
      // A row of short cells with no prices is a table header: its cells name the price columns.
      header = cells.length >= 2 && cells.every((c) => c.length <= 40) ? cells : null;
      if (cells.length === 1 && line.length <= 120) lastName = line;
      continue;
    }
    // A single short line with a price and no separator: "Stop Payment: $30.00/item".
    let parts = cells;
    if (cells.length === 1 && line.length <= 140) {
      const m = line.match(/\$\s?\.?\d|\d+(?:\.\d+)?\s?%|\bno (?:monthly )?(?:charge|fee)s?\b|\bfree\b/i);
      if (m && m.index! > 0) parts = [clean(line.slice(0, m.index)), clean(line.slice(m.index))];
      else if (m && m.index === 0 && lastName) parts = [line];
    }
    const flags = parts.map((c) => hasPrice(c));
    const priceCellsOk = parts.filter((_, i) => flags[i]).every((c) => c.length <= 70 || hasPrice(c.slice(0, 25)));
    const namesOk = parts.filter((_, i) => !flags[i]).every((c) => c.length <= 160);
    if ((parts.length >= 2 || (parts.length === 1 && lastName && line.length <= 70)) && priceCellsOk && namesOk) {
      // Pair each price cell with the name cells before it. A price cell right after another price
      // cell is another column of the same fee (a product column).
      const pairs: { name: string; cell: string; i: number }[] = [];
      let pending: string[] = [], current: string | null = null;
      parts.forEach((c, i) => {
        if (!flags[i]) { pending.push(c); return; }
        if (pending.length) { current = nameOf(pending.join(' ')); pending = []; }
        pairs.push({ name: current ?? '', cell: c, i });
      });
      const many = new Set(pairs.map((p) => p.name)).size > 1;
      for (const pr of pairs) {
        let name = pr.name, quote = many ? `${pr.name} | ${pr.cell}` : line;
        if (wordCount(name) === 0 && lastName) { name = lastName; quote = `${lastName} | ${line}`; }
        if (wordCount(name) === 0) continue;
        const context = `${heading ?? ''} ${header?.join(' ') ?? ''} ${name}`;
        if (CONDITION_NAME.test(`${heading ?? ''} ${name} ${pr.cell}`) && !FEE_NAME.test(name)) continue;
        // Every price at the head of the cell is its own row ("$20.00 $10.00", "$35/$60"); words
        // further on are conditions, so their amounts are not read.
        let ps = FREE_CELL.test(pr.cell) ? [{ kind: 'free' as const, amountUsd: null, amountMaxUsd: null, ratePct: null }] : prices(pr.cell.slice(0, 60));
        if (ps[0]?.kind === 'rate' && (!FEE_NAME.test(`${name} ${pr.cell}`) || RATE_NOT_FEE.test(context))) ps = ps.filter((x) => x.kind !== 'rate');
        ps = ps.filter((x) => (x.amountUsd ?? 0) < 1000 || FEE_NAME.test(name));
        // A free price needs a short fee name; a long one is an account description ("$0.00 to open").
        if (wordCount(name) > 14) ps = ps.filter((x) => x.kind !== 'free');
        if (ps.length === 0) continue;
        const sameName = pairs.filter((x) => x.name === pr.name).length;
        const product = sameName > 1 && header && header.length === parts.length ? header[pr.i] : null;
        const feeName = heading && !name.toLowerCase().includes(heading.toLowerCase()) ? `${heading}: ${name}` : name;
        for (const pz of ps) push(row(input, here, quote, feeName, pz, `${heading ?? ''} ${name} ${pr.cell}`, product, /\$/.test(name) ? name : null));
      }
      continue;
    }
    // Prose: each sentence that names a fee and holds a price.
    for (const cell of cells) {
      for (const s of cell.split(/(?<=[.;!?])\s+|\s+•\s+/)) {
        const sentence = clean(s);
        if (!hasPrice(sentence) || !FEE_WORD.test(sentence) || sentence.length > 400) continue;
        const ps = prices(sentence).filter((x) => x.kind !== 'free' && (x.amountUsd ?? 0) < 1000);
        if (ps.length === 0) continue;
        const name = nameOf(sentence).slice(0, 160);
        if (wordCount(name) < 2) continue;
        push(row(input, here, sentence, heading ? `${heading}: ${name}` : name, ps[0], `${heading ?? ''} ${sentence}`, null, null));
      }
    }
  }
  return dedupe(out);
}

/** The same words and the same price read twice (a repeated table) count once. */
function dedupe(fees: ReadFee[]): ReadFee[] {
  const seen = new Set<string>();
  return fees.filter((f) => {
    const k = [f.quote, f.priceKind, f.amountUsd, f.amountMaxUsd, f.ratePct, f.product].join('\u0001');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
