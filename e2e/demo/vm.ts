import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { chain, type Hex } from '@paperseal/protocol';
import { keccak256, toBytes } from 'viem';

import { connectChain } from '../live/chainio';
import { deployed } from '../live/config';

/*
 * `pnpm demo:vm <exam name>`: starts the sealed machine for an exam already published, by name, with
 * the settings read back from ExamRegistry. Needs gcloud signed in to the project below.
 */
const gcp = { PROJECT_ID: 'paperseal-demo', REGION: 'asia-south2', ZONE: 'asia-south2-a', BUCKET: deployed.storageBucket };

export async function main(argv: string[]): Promise<void> {
  const label = argv[0]?.split('.')[0];
  if (!label) throw new Error('usage: pnpm demo:vm <exam name>');
  const examId = keccak256(toBytes(label));
  const io = connectChain();
  const exam = await io.read(() => io.registry.getExam(examId as Hex));
  if (!exam) throw new Error(`no exam named ${label} on ${deployed.registry}`);
  const { settings, imageDigest } = exam;
  const args = [
    `--exam-id=${examId}`,
    `--exam-start=${String(settings.examStart)}`,
    `--delta=${String(settings.delta)}`,
    `--lock-round=${String(settings.lockRound)}`,
    `--unlock-round=${String(settings.unlockRound)}`,
    `--end-round=${String(settings.endRound)}`,
    `--criteria-hash=${settings.criteriaHash}`,
    `--rpc-host=${settings.rpcHost}`,
    `--registry=${deployed.registry.toLowerCase()}`,
    `--chain-id=${String(chain.chainId)}`,
    `--image-digest=sha256:${imageDigest.slice(2)}`,
    '--reset',
  ];
  const script = fileURLToPath(new URL('../../deploy/gcp/run-tee.sh', import.meta.url));
  const run = spawnSync(script, args, { stdio: 'inherit', env: { ...process.env, ...gcp } });
  if (run.status !== 0) throw new Error('run-tee.sh failed');
  console.log(`\nThe machine is rebooting on ${label}. It answers in about a minute.`);
}
