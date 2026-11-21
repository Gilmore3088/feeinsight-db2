// Read stored texts and write the fees as a JSON list of fee lines, ready for the scorer.
//   node src/reader/read-cli.ts --texts <texts.json> > fees.json
// The texts file holds { texts: [{ textId, institutionId, text, pageStarts }] }. Plain code, no model.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readDocument, type ReadInput } from './read.ts';

const { values } = parseArgs({ options: { texts: { type: 'string' } } });
if (!values.texts) {
  console.error('usage: node src/reader/read-cli.ts --texts <texts.json>');
  process.exit(2);
}
const { texts } = JSON.parse(readFileSync(values.texts, 'utf8')) as { texts: ReadInput[] };
const fees = texts.flatMap((t) => readDocument(t));
console.error(`${texts.length} texts, ${fees.length} fees`);
console.log(JSON.stringify(fees));
