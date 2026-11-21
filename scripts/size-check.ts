// The size rule from CLAUDE.md, as a check: each agent folder under src/ stays under 1,500 lines
// of non-test code, and all of DB2 under 10,000. Run with `npm run size`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PER_AGENT = 1500, TOTAL = 10000;
const isCode = (f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('/fixtures/');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
}
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
let total = 0, bad = false;
for (const agent of readdirSync('src')) {
  const n = files(join('src', agent)).filter(isCode).reduce((s, f) => s + lines(f), 0);
  total += n;
  const over = n > PER_AGENT;
  bad ||= over;
  console.log(`${agent.padEnd(10)} ${String(n).padStart(6)}${over ? `  over the ${PER_AGENT}-line limit` : ''}`);
}
console.log(`${'total'.padEnd(10)} ${String(total).padStart(6)} of ${TOTAL}`);
if (bad || total > TOTAL) process.exit(1);
