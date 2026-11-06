import { gaps } from './config';
import { dryCheck } from './dry-check';
import { registryCheck } from './registry-check';
import { proof } from './proof';
import { publish } from './publish';
import { run } from './run';
import { status } from './status';

const usage = `Paper Seal live run (Sepolia, the deployed TEE, real Chrome)

  node e2e/live/cli.mjs publish --release v<x.y.z> [--repo owner/name] [--name exam-name]
  node e2e/live/cli.mjs run        long-running; keep it alive until the end proof (about ${String(Math.ceil(gaps.end / 60))} minutes)
  node e2e/live/cli.mjs status
  node e2e/live/cli.mjs proof      the public proof for the exam in the state file: no browser, passkey or TEE
  node e2e/live/cli.mjs dry-check  offline: schedule, calldata, cast arguments, release parsing
  node e2e/live/cli.mjs registry-check  read-only: the deployed contract against the code pin

State: e2e/.live/state.json   Report: e2e/.live/report.json`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'publish':
      return publish(rest);
    case 'run':
      return run();
    case 'status':
      return status();
    case 'proof':
      return proof();
    case 'registry-check':
      return registryCheck();
    case 'dry-check':
      return dryCheck();
    default:
      console.log(usage);
      if (command !== undefined && command !== 'help') process.exitCode = 2;
  }
}
