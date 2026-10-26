// Runs every fixture file through the parser and prints pass rates + first failures.
// Usage: pnpm --filter @arclight/parser report [-- <substring filter>] [--all]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCase, type FixtureCase } from '../src/fixture-check.js';

const root = join(fileURLToPath(import.meta.url), '..', '..', 'fixtures');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
const showAll = process.argv.includes('--all');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : [],
  );
}

let totalPass = 0;
let totalCases = 0;
for (const file of walk(root)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  if (filter && !rel.includes(filter)) continue;
  const data = JSON.parse(readFileSync(file, 'utf8')) as { cases: FixtureCase[] };
  let pass = 0;
  const failures: string[] = [];
  for (const c of data.cases) {
    const result = checkCase(rel, c);
    if (result.ok) pass++;
    else failures.push(`    ${JSON.stringify(c.input)}\n      ${result.problems.join('\n      ')}`);
  }
  totalPass += pass;
  totalCases += data.cases.length;
  const pct = ((pass / data.cases.length) * 100).toFixed(1).padStart(5);
  console.log(`${pct}%  ${String(pass).padStart(4)}/${String(data.cases.length).padEnd(4)} ${rel}`);
  for (const f of showAll ? failures : failures.slice(0, 6)) console.log(f);
  if (!showAll && failures.length > 6) console.log(`    … ${failures.length - 6} more`);
}
console.log(`\nTOTAL ${totalPass}/${totalCases} (${((totalPass / totalCases) * 100).toFixed(1)}%)`);
