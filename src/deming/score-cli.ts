// One command that prints the score: precision, recall and coverage against an answer key.
//   node src/deming/score-cli.ts --key <key.json> --fees <fees.json> [--by-institution]
// The fees file is a JSON list of fee lines (src/deming/score.ts, FeeLine). Plain code, no model.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { score, type FeeLine, type Score } from './score.ts';
import { keyFeeLines, loadKey, validateKey, type KeyFile } from './key-file.ts';

export const GATE = { precision: 0.97, recall: 0.85 };

const pct = (x: number | null) => (x == null ? '  n/a' : `${(100 * x).toFixed(1)}%`);
const range = (r: [number, number] | null) => (r ? `${(100 * r[0]).toFixed(1)} to ${(100 * r[1]).toFixed(1)}` : 'n/a');

export interface Coverage { covered: number; institutions: number; share: number | null }

/** Coverage: the share of the key's institutions for which the reader produced any fee. */
export function coverage(k: KeyFile, fees: FeeLine[]): Coverage {
  const have = new Set(fees.map((f) => f.institutionId));
  const covered = k.institutions.filter((i) => have.has(i.institutionId)).length;
  return { covered, institutions: k.institutions.length, share: k.institutions.length ? covered / k.institutions.length : null };
}

export function report(k: KeyFile, fees: FeeLine[], feesLabel: string, byInstitution: boolean): string {
  const { total, byInstitution: per } = score(keyFeeLines(k), fees);
  const cov = coverage(k, fees);
  const verdict = (x: number | null, gate: number, r: [number, number] | null) =>
    x == null ? 'no data' : r && r[0] >= gate ? 'PASS' : x >= gate ? 'pass, but the range dips under the gate' : 'FAIL';
  const out = [
    `Key:  ${k.name} (${k.kind}, ${k.status}), ${k.institutions.length} institutions, ${total.keyLines} scored lines`,
    `Fees: ${feesLabel}, ${fees.filter((f) => k.institutions.some((i) => i.institutionId === f.institutionId)).length} fees for these institutions`,
    '',
    `Precision ${pct(total.precision).padStart(6)}  (95% range ${range(total.precisionInterval)})  gate ${GATE.precision * 100}%: ${verdict(total.precision, GATE.precision, total.precisionInterval)}`,
    `Recall    ${pct(total.recall).padStart(6)}  (95% range ${range(total.recallInterval)})  gate ${GATE.recall * 100}%: ${verdict(total.recall, GATE.recall, total.recallInterval)}`,
    `Coverage  ${pct(cov.share).padStart(6)}  (${cov.covered} of ${cov.institutions} institutions have any fee)`,
    '',
    `Matched ${total.matched}, wrong price ${total.wrongPrice}, extra ${total.extra}, missed ${total.missed}, ` +
      `consumer/business mix-ups ${total.audienceMixUps}, unit differences ${total.unitMismatches}`,
  ];
  if (byInstitution) {
    out.push('', 'Institution                                   Key  Fees   Prec  Recall');
    const name = new Map(k.institutions.map((i) => [i.institutionId, i.name]));
    for (const [id, s] of per as Map<number, Score>) {
      out.push(`${`${id} ${name.get(id) ?? ''}`.slice(0, 44).padEnd(44)} ${String(s.keyLines).padStart(4)} ${String(s.readerFees).padStart(5)} ${pct(s.precision).padStart(6)} ${pct(s.recall).padStart(7)}`);
    }
  }
  return out.join('\n');
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { key: { type: 'string' }, fees: { type: 'string' }, 'by-institution': { type: 'boolean' } } });
  if (!values.key || !values.fees) {
    console.error('usage: node src/deming/score-cli.ts --key <key.json> --fees <fees.json> [--by-institution]');
    process.exit(2);
  }
  const k = loadKey(values.key);
  const problems = validateKey(k);
  if (problems.length) {
    console.error(`The key has ${problems.length} problem(s); it cannot be scored against:\n- ${problems.slice(0, 20).join('\n- ')}`);
    process.exit(1);
  }
  const fees = JSON.parse(readFileSync(values.fees, 'utf8')) as FeeLine[];
  console.log(report(k, fees, values.fees, Boolean(values['by-institution'])));
}
