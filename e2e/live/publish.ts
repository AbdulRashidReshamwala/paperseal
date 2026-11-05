import { decodeCriteria, fromHex, type Hex } from '@paperseal/protocol';

import { boardSend, checkDeployment, connectChain } from './chainio';
import { deployed, rpcHost } from './config';
import { fetchRelease } from './github';
import { computeSchedule, examName, liveCriteria, plan, runTeeArgs } from './schedule';
import { loadState, saveState, type PublishedExam } from './state';
import { stamp } from './util';

/*
 * `publish --release v0.2.0 [--repo owner/name] [--name "Exam name"]`
 *
 * Reads the release, computes the schedule from now, runs checkSchedule, creates the exam from the
 * board keystore through cast, reads it back and prints the exact run-tee.sh arguments.
 */

export function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0) return argv[at + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const at = (unix: number) => `${new Date(unix * 1000).toISOString()} (${String(unix)})`;

export async function publish(argv: string[]): Promise<void> {
  const tag = option(argv, 'release') ?? argv.find((a) => /^v\d+\.\d+\.\d+$/.test(a));
  if (!tag) throw new Error('usage: publish --release v<major>.<minor>.<patch> [--repo owner/name] [--name "Exam name"]');
  const repo = option(argv, 'repo') ?? deployed.releasesRepo;

  const existing = loadState();
  if (existing.exam && existing.run?.status === 'running') {
    throw new Error('a run is in progress for the exam in the state file; wait for it or remove e2e/.live/state.json');
  }

  console.log(`reading release ${tag} from ${repo} ...`);
  const release = await fetchRelease(repo, tag);
  console.log(`  commit       ${release.commit}\n  image digest ${release.imageDigest}\n  run          ${release.run}`);

  const io = connectChain();
  console.log(`checking the deployment: ${await checkDeployment(io)}`);

  const name = option(argv, 'name') ?? examName();
  const schedule = computeSchedule(Math.floor(Date.now() / 1000));
  const built = plan(name, schedule); // runs checkSchedule
  console.log('checkSchedule passed');
  console.log(`  now          ${at(schedule.createdAtUnix)}`);
  console.log(`  Lock         ${at(schedule.lockAtUnix)}  round ${schedule.lockRound}`);
  console.log(`  T - delta    ${at(schedule.unlockAtUnix)}  round ${schedule.unlockRound}`);
  console.log(`  T            ${at(schedule.examStart)}  delta ${String(schedule.delta)}s`);
  console.log(`  End          ${at(schedule.endAtUnix)}  round ${schedule.endRound}`);
  console.log(`  exam         "${name}"  ${built.examId}`);

  if (await io.read(() => io.registry.getExam(built.examId))) throw new Error('an exam with this name is already published');

  const settings = {
    examId: built.examId,
    examStart: BigInt(schedule.examStart),
    delta: BigInt(schedule.delta),
    lockRound: BigInt(schedule.lockRound),
    unlockRound: BigInt(schedule.unlockRound),
    endRound: BigInt(schedule.endRound),
    criteriaHash: built.criteriaHash,
    rpcHost,
  };
  console.log('sending createExam through cast (the board keystore signs) ...');
  const sent = await boardSend(io, 'createExam', [release.commit, release.imageDigest, settings, built.criteriaEncoded]);
  console.log(`  mined in block ${sent.blockNumber.toString()}  ${sent.transactionHash}`);

  // Read back what the chain stored, and compare every value.
  let exam = null;
  for (let attempt = 0; attempt < 8 && !exam; attempt += 1) {
    exam = await io.read(() => io.registry.getExam(built.examId));
    if (!exam) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!exam) throw new Error('createExam was mined but getExam returns nothing yet; run publish again only after checking the chain');
  const criteria = await io.read(() => io.registry.getCriteria(built.examId));
  const rows: [string, string, string][] = [
    ['commitHash', release.commit, exam.commitHash],
    ['imageDigest', release.imageDigest, exam.imageDigest],
    ['examStart', String(schedule.examStart), String(exam.settings.examStart)],
    ['delta', String(schedule.delta), String(exam.settings.delta)],
    ['lockRound', schedule.lockRound, String(exam.settings.lockRound)],
    ['unlockRound', schedule.unlockRound, String(exam.settings.unlockRound)],
    ['endRound', schedule.endRound, String(exam.settings.endRound)],
    ['criteriaHash', built.criteriaHash, exam.settings.criteriaHash],
    ['rpcHost', rpcHost, exam.settings.rpcHost],
    ['criteria bytes', built.criteriaEncoded, criteria ?? 'missing'],
  ];
  const wrong = rows.filter(([, want, got]) => want.toLowerCase() !== got.toLowerCase());
  for (const [label, want, got] of rows) console.log(`  ${want.toLowerCase() === got.toLowerCase() ? 'ok  ' : 'DIFF'} ${label}`);
  if (wrong.length > 0) throw new Error(`read-back differs for: ${wrong.map(([l]) => l).join(', ')}`);
  decodeCriteria(fromHex(criteria as Hex));

  const args = runTeeArgs(built.settings, release.imageDigest);
  const published: PublishedExam = {
    name,
    examId: built.examId,
    publishedAt: stamp(),
    release: { ...release, repo },
    schedule,
    criteria: liveCriteria,
    criteriaEncoded: built.criteriaEncoded,
    criteriaHash: built.criteriaHash,
    rpcHost,
    registry: deployed.registry,
    chainId: built.settings.chainId,
    transactionHash: sent.transactionHash,
    blockNumber: sent.blockNumber.toString(),
    runTeeArgs: args,
  };
  saveState({ version: 1, exam: published });

  console.log('\nexam published and read back. Start the TEE with exactly:\n');
  console.log(`  DRY_RUN=1 deploy/gcp/run-tee.sh \\\n${args.map((a) => `    ${a}`).join(' \\\n')}\n`);
  console.log('(unset DRY_RUN to run for real). Then: node e2e/live/cli.mjs run');
  console.log(`Registration must start soon: Lock is at ${new Date(schedule.lockAtUnix * 1000).toISOString()}.`);
}
