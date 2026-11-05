import { existsSync, readFileSync } from 'node:fs';

import { reportPath } from './config';
import { loadState, type ReportEntry } from './state';

const age = (iso: string) => `${String(Math.round((Date.now() - Date.parse(iso)) / 1000))}s ago`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `status`: the state file and the report, without touching the chain, the TEE or the board key. */
export function status(): void {
  const { exam, run } = loadState();
  if (!exam) {
    console.log('No exam published yet. Run: node e2e/live/cli.mjs publish --release v<x.y.z>');
    return;
  }
  const s = exam.schedule;
  const at = (unix: number) => new Date(unix * 1000).toISOString();
  console.log(`Exam      ${exam.name}\nexamId    ${exam.examId}\nrelease   ${exam.release.version} (${exam.release.commit})\nimage     sha256:${exam.release.imageDigest.slice(2)}`);
  console.log(`createExam block ${exam.blockNumber}  ${exam.transactionHash}`);
  console.log(`Lock      ${at(s.lockAtUnix)}  round ${s.lockRound}\nT - delta ${at(s.unlockAtUnix)}  round ${s.unlockRound}\nT         ${at(s.examStart)}\nEnd       ${at(s.endAtUnix)}  round ${s.endRound}`);
  console.log(`now       ${new Date().toISOString()}`);
  if (!run) {
    console.log('\nNo run yet. Start the TEE with the run-tee.sh arguments, then: node e2e/live/cli.mjs run');
    return;
  }
  const live = run.status === 'running' ? (alive(run.pid) ? 'running' : 'DEAD (the process is gone; virtual passkeys died with it, so start from a new exam)') : run.status;
  console.log(`\nRun       ${live}, phase ${run.phase}, pid ${String(run.pid)}, started ${run.startedAt}, updated ${age(run.updatedAt)}`);
  if (run.stopReason) console.log(`Stopped   ${run.stopReason}`);
  if (run.approvedList) console.log(`List      ${run.approvedList.hash} block ${run.approvedList.blockNumber}${run.approvedList.seenByTeeAt ? `, TEE saw it ${run.approvedList.seenByTeeAt}` : ', not yet seen by the TEE'}`);
  console.log(`Receipts  ${String(run.receipts.length)}   Released ${String(run.released.length)} of 8${run.build ? `\nBuild     posted, instance key ${run.build.instancePublicKey.slice(0, 20)}...` : ''}`);
  if (run.paperSha256) console.log(`Paper     sha256 ${run.paperSha256}`);
  if (run.reveal) console.log(`Reveal    ${run.reveal.map((r) => `${r.name} ${r.onChain ? 'on chain' : 'NOT on chain'}`).join(', ')}`);
  if (!existsSync(reportPath)) return;
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { summary: { pass: number; fail: number }; entries: ReportEntry[] };
  console.log(`\nReport    ${String(report.summary.pass)} Pass, ${String(report.summary.fail)} Fail  (${reportPath})`);
  for (const e of report.entries.slice(-8)) console.log(`  ${e.ts}  ${e.result.toUpperCase()}  [${e.step}] ${e.label}`);
  for (const e of report.entries.filter((x) => x.result === 'Fail')) console.log(`  FAIL [${e.step}] ${e.label}: ${e.detail}`);
}
