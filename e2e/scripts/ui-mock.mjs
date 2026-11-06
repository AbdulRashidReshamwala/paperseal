// The mock run, then the video cuts, whatever the run's result, so a failed step still leaves its footage.
// Exit status is non-zero if either failed. See ui/examRun.ts for what is real and what is replaced.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.ui.config.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, UI_MOCK: '1' } });
const cut = spawnSync('node', ['scripts/cut-videos.mjs', '.ui/mock-video-plan.json', 'videos', 'mock'], { cwd: root, stdio: 'inherit' });
process.exit(run.status === 0 && cut.status === 0 ? 0 : 1);
