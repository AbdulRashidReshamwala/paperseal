// Runs every recording, then prints a table from the result files they wrote.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = resolve(root, 'videos/results');
const names = ['board-publish', 'verifier-checks', 'mock-security-key'];

rmSync(results, { recursive: true, force: true });
const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.config.ts'], { cwd: root, stdio: 'inherit' });

const rows = names.map((name) => {
  const file = resolve(results, `${name}.json`);
  if (!existsSync(file)) return { name, result: 'NO RESULT', duration: '-', file: '-' };
  const r = JSON.parse(readFileSync(file, 'utf8'));
  return { name, result: r.result, duration: `${(r.durationMs / 1000).toFixed(1)}s`, file: relative(process.cwd(), r.file) };
});
const width = (key) => Math.max(key.length, ...rows.map((r) => r[key].length));
const cols = ['name', 'result', 'duration', 'file'];
const line = (r) => cols.map((c) => r[c].padEnd(width(c))).join('  ');
console.log('\n' + line(Object.fromEntries(cols.map((c) => [c, c]))));
console.log(cols.map((c) => '-'.repeat(width(c))).join('  '));
rows.forEach((r) => console.log(line(r)));
const failed = rows.filter((r) => r.result !== 'PASS');
for (const name of failed.map((r) => r.name)) {
  const file = resolve(results, `${name}.json`);
  if (!existsSync(file)) continue;
  for (const a of JSON.parse(readFileSync(file, 'utf8')).assertions.filter((x) => !x.ok)) console.log(`  ${name}: FAIL ${a.label}: ${a.detail}`);
}
process.exit(failed.length === 0 && run.status === 0 ? 0 : 1);
