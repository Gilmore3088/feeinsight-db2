// The answer key as a file: what Deming scores against. Plain code, no model.
// Rules are in docs/answer-key.md and docs/scoring.md. The same fields as sealed.key_lines
// (supabase/migrations/0001_answer_key.sql), so a key file can be loaded into the database as is.

import { readFileSync } from 'node:fs';
import type { FeeLine, PriceKind } from './score.ts';
import { validateFee, type Audience, type FeeRecord, type Unit } from '../fees/record.ts';

export const KEY_KINDS = ['sealed', 'dev'] as const;
export const KEY_STATUSES = ['drafting', 'confirming', 'sealed', 'retired'] as const;

/** One stored text a key line was recorded from. */
export interface KeyDocument {
  textId: number;            // the stored text's id (DB1 agent_source_texts.id for a DB1 copy)
  sourceDocumentId: number | null;
  url: string;
  textSha: string | null;    // hash of the stored text, so a later reader can prove it is the same text
  fetchedAt: string | null;  // when the document was fetched (date)
}

export interface KeyInstitution {
  institutionId: number;     // DB1 institution id
  name: string;
  charter: 'bank' | 'credit_union';
  drawRank: number | null;   // place in the random draw; null for a dev key
  documents: KeyDocument[];  // every document the lines were recorded from
  notes: string | null;      // what the recorder saw: no full schedule, a second schedule, a conflict
}

export interface KeyLine {
  institutionId: number;
  textId: number;            // the KeyDocument the line was recorded from
  page: number | null;
  quote: string;             // the exact words of the document
  feeName: string;
  priceKind: PriceKind;
  amountUsd: number | null;
  amountMaxUsd: number | null;
  ratePct: number | null;
  unit: Unit;
  conditions: string | null;
  product: string | null;
  audience: Audience;
  recordedBy: string;        // a person, or the drafting session
}

export interface KeyConfirmation {
  institutionId: number;
  lineIndex: number | null;  // index into `lines`; null for a line the recorder missed
  verdict: 'agree' | 'disagree' | 'missing_line';
  note: string | null;
  confirmedBy: string;       // a person, never a model
}

export interface KeyFile {
  name: string;              // e.g. 'key-2026-11-21'
  kind: (typeof KEY_KINDS)[number];
  status: (typeof KEY_STATUSES)[number];
  drawSeed: string | null;
  drawRule: string;          // plain words: population, exclusions, how many of each
  institutions: KeyInstitution[];
  lines: KeyLine[];
  confirmations: KeyConfirmation[];
}

/** A key line as a fee record, so the same rules for the numbers apply to both. */
export function asRecord(l: KeyLine): FeeRecord {
  return {
    institutionId: l.institutionId, sourceDocumentId: l.textId, page: l.page, quote: l.quote, feeName: l.feeName,
    category: null, priceKind: l.priceKind, amountUsd: l.amountUsd, amountMaxUsd: l.amountMaxUsd, ratePct: l.ratePct,
    unit: l.unit, conditions: l.conditions, product: l.product, audience: l.audience, documentDate: null,
    readAt: '2000-01-01T00:00:00Z', runId: 'key', status: 'read', withdrawalReason: null, quoteCheckedAt: null,
    quoteCheckVersion: null,
  };
}

/** Every problem with the key, in plain words. An empty list means it can be scored against. */
export function validateKey(k: KeyFile): string[] {
  const p: string[] = [];
  if (!KEY_KINDS.includes(k.kind)) p.push(`the key kind "${k.kind}" is not sealed or dev`);
  if (!KEY_STATUSES.includes(k.status)) p.push(`the key status "${k.status}" is not on the list`);
  if (k.kind === 'sealed' && !k.drawSeed) p.push('a sealed key needs its draw seed, so the draw can be repeated');
  const insts = new Map(k.institutions.map((i) => [i.institutionId, i]));
  if (insts.size !== k.institutions.length) p.push('an institution is listed twice');
  k.lines.forEach((l, n) => {
    const inst = insts.get(l.institutionId);
    if (!inst) { p.push(`line ${n}: institution ${l.institutionId} is not in the key`); return; }
    if (!inst.documents.some((d) => d.textId === l.textId)) p.push(`line ${n}: document ${l.textId} is not one of the institution's documents`);
    if (!l.recordedBy?.trim()) p.push(`line ${n}: who recorded it is missing`);
    for (const q of validateFee(asRecord(l))) p.push(`line ${n}: ${q}`);
  });
  for (const c of k.confirmations) {
    if (!insts.has(c.institutionId)) p.push(`a confirmation names institution ${c.institutionId}, which is not in the key`);
    if ((c.verdict === 'missing_line') !== (c.lineIndex == null)) p.push('a confirmation names a line only when it agrees or disagrees with one');
    if (c.lineIndex != null && k.lines[c.lineIndex]?.institutionId !== c.institutionId) p.push(`a confirmation points at line ${c.lineIndex}, which is not that institution's`);
    if (!c.confirmedBy?.trim() || /claude|model|agent|session/i.test(c.confirmedBy)) p.push('a confirmation must name the person who made it; a model cannot confirm');
  }
  if (k.status === 'sealed' && k.kind === 'sealed') {
    const checked = new Set(k.confirmations.map((c) => c.institutionId));
    if (checked.size < Math.ceil(k.institutions.length * 0.2)) p.push('a sealed key needs a person to have checked at least 20% of its institutions');
  }
  return p;
}

/** Share of a person's checked lines that agree, and how many lines they found missing. */
export function confirmationSummary(k: KeyFile): { institutions: number; checked: number; agreed: number; missing: number } {
  const c = k.confirmations;
  return {
    institutions: new Set(c.map((x) => x.institutionId)).size,
    checked: c.filter((x) => x.verdict !== 'missing_line').length,
    agreed: c.filter((x) => x.verdict === 'agree').length,
    missing: c.filter((x) => x.verdict === 'missing_line').length,
  };
}

/** The key's lines as the scorer sees them. */
export function keyFeeLines(k: KeyFile): FeeLine[] {
  return k.lines.map((l) => ({
    institutionId: l.institutionId, feeName: l.feeName, quote: l.quote, priceKind: l.priceKind,
    amountUsd: l.amountUsd, amountMaxUsd: l.amountMaxUsd, ratePct: l.ratePct, unit: l.unit, product: l.product,
    audience: l.audience,
  }));
}

export function loadKey(path: string): KeyFile {
  const k = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
  k.confirmations ??= [];
  return k;
}
