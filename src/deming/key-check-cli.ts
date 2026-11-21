// node src/deming/key-check-cli.ts --key <key.json> --texts <texts.json> [--fill-pages] [--write] [--quiet]
// Runs the quote check on every key line against its stored text. The texts file maps a text id to
// { "text": ..., "pageStarts": [...] }. --fill-pages sets a missing PDF page from where the quote is;
// --write saves those pages back into the key. --quiet prints counts only, never a line's words.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkKeyLines, type StoredText } from './key-check.ts';
import { loadKey, validateKey } from './key-file.ts';

const { values } = parseArgs({ options: {
  key: { type: 'string' }, texts: { type: 'string' }, 'fill-pages': { type: 'boolean' }, write: { type: 'boolean' }, quiet: { type: 'boolean' },
} });
if (!values.key || !values.texts) { console.error('usage: --key <key.json> --texts <texts.json> [--fill-pages] [--write] [--quiet]'); process.exit(2); }
const k = loadKey(values.key);
const raw = JSON.parse(readFileSync(values.texts, 'utf8')) as Record<string, StoredText>;
const texts = new Map(Object.entries(raw).map(([id, t]) => [Number(id), t]));
const checks = checkKeyLines(k, texts, Boolean(values['fill-pages']));
const failed = checks.filter((c) => !c.result.ok);
const shape = validateKey(k).filter((p) => !/^line \d+:/.test(p));
console.log(`${k.name}: ${k.lines.length} lines, ${k.lines.length - failed.length} pass the quote check, ${failed.length} fail`);
for (const p of shape) console.log(`key problem: ${p}`);
const perInst = new Map<number, number>();
for (const f of failed) perInst.set(f.institutionId, (perInst.get(f.institutionId) ?? 0) + 1);
for (const [id, n] of perInst) console.log(`  institution ${id}: ${n} failing`);
if (!values.quiet) for (const f of failed) console.log(`line ${f.lineIndex}: ${f.result.problems.join('; ')}`);
if (values.write) writeFileSync(values.key, JSON.stringify(k, null, 1));
process.exit(failed.length || shape.length ? 1 : 0);
