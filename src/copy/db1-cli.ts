// node src/copy/db1-cli.ts practice-key <export.json> <answer_key_fees.json> [--prefilled] > key.json
// node src/copy/db1-cli.ts live-fees <export.json> > fees.json
// The export files are read-only copies of DB1 rows (see docs/answer-key.md, "The DB1 copy").

import { readFileSync } from 'node:fs';
import { db1LiveFees, db1PracticeKey } from './db1.ts';

const [cmd, exportPath, feesPath] = process.argv.slice(2);
const exp = exportPath ? JSON.parse(readFileSync(exportPath, 'utf8')) : null;
if (cmd === 'practice-key' && exp && feesPath) {
  const { key, skipped } = db1PracticeKey(exp.key_institutions, JSON.parse(readFileSync(feesPath, 'utf8')), process.argv.includes('--prefilled'));
  console.error(`${key.institutions.length} institutions, ${key.lines.length} lines; ${skipped} lines left out for having no source words`);
  console.log(JSON.stringify(key, null, 1));
} else if (cmd === 'live-fees' && exp) {
  console.log(JSON.stringify(db1LiveFees(exp.catalog)));
} else {
  console.error('usage: practice-key <export.json> <answer_key_fees.json> [--prefilled] | live-fees <export.json>');
  process.exit(2);
}
