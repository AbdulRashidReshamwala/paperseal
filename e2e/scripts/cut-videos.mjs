// Cuts the raw window recordings of a live run into one video per flow, named by flow.
// Input:  .ui/video-plan.json, written by ui/live.ui-live.ts (each recorded window and its marks).
// Output: videos/<flow>.mp4 and a table of lengths. Nothing here is generated: every second is a cut of a real recording.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planFile = resolve(root, process.argv[2] ?? '.ui/video-plan.json');
const outDir = resolve(root, process.argv[3] ?? 'videos');
const plan = JSON.parse(readFileSync(planFile, 'utf8'));

/** Seconds before `from` and after `to` are kept, so a viewer sees the screen settle. */
const cuts = [
  { name: 'setter-adds-questions-and-seals', who: 'setter-1', from: 'composer', to: 'sealed-choice', before: 1, after: 6 },
  { name: 'board-publishes-the-exam', who: 'board', from: 'create-start', to: 'published', before: 1, after: 3 },
  { name: 'board-posts-the-list', who: 'board', from: 'post-list-start', to: 'list-posted', before: 2, after: 3 },
  { name: 'board-posts-the-paper-record', who: 'board', from: 'paper-ready', to: 'build-posted', before: 2, after: 3 },
  { name: 'key-holder-releases-part-of-key', who: 'neutral-1', from: 'release-visible', to: 'count-8', before: 15, after: 3 },
  { name: 'centre-releases-part-of-key', who: 'centre-1', from: 'release-visible', to: 'release-sent', before: 6, after: 12 },
  { name: 'centre-waits-for-key-holders', who: 'centre-8', from: 'holders-waiting', to: 'open-visible', before: 3, after: 2 },
  { name: 'centre-opens-the-paper', who: 'centre-8', from: 'open-visible', to: 'paper-shown', before: 2, after: 2 },
  { name: 'centre-hands-out-the-paper', who: 'centre-8', from: 'handout-start', to: 'handout-end', before: 2, after: 2 },
  { name: 'verifier-finished-exam', who: 'verifier', from: 'after-end', to: 'verifier-shown', before: 2, after: 10 },
];

mkdirSync(outDir, { recursive: true });
const rows = [];
for (const cut of cuts) {
  const entry = plan.find((p) => p.who === cut.who);
  const mark = (name) => entry?.marks.find((m) => m.name === name);
  const from = mark(cut.from);
  const to = mark(cut.to);
  const out = resolve(outDir, `${cut.name}.mp4`);
  if (!entry?.file || !existsSync(entry.file) || !from || !to) {
    rows.push({ name: cut.name, result: `NOT RECORDED (${!entry?.file ? 'no video' : !from ? `no mark ${cut.from}` : `no mark ${cut.to}`})`, seconds: '-' });
    continue;
  }
  const start = Math.max(0, (from.at - entry.startedAt) / 1000 - cut.before);
  const end = (to.at - entry.startedAt) / 1000 + cut.after;
  rmSync(out, { force: true });
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', start.toFixed(2), '-to', end.toFixed(2), '-i', entry.file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out], { stdio: 'inherit' });
  rows.push({ name: cut.name, result: run.status === 0 ? 'OK' : 'FFMPEG FAILED', seconds: (end - start).toFixed(1), file: out });
}
for (const row of rows) console.log(`${row.name.padEnd(36)} ${row.result.padEnd(14)} ${String(row.seconds).padStart(6)}s  ${row.file ?? ''}`);
process.exit(rows.every((r) => r.result === 'OK') ? 0 : 1);
