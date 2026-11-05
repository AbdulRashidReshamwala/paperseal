import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Hex } from '@paperseal/protocol';

/*
 * The deployed system the live run drives. Every value here is public. The board's key never enters
 * this process: `cast send --account <keystore>` signs, and only the path of the password file is
 * given to it. This code never opens that file.
 */

export const liveDir = fileURLToPath(new URL('.', import.meta.url));
export const e2eDir = resolve(liveDir, '..');
export const stateDir = resolve(e2eDir, '.live');
export const statePath = resolve(stateDir, 'state.json');
export const reportPath = resolve(stateDir, 'report.json');
export const logPath = resolve(stateDir, 'run.log');

const env = process.env;

export const deployed = {
  registry: (env.LIVE_REGISTRY ?? '0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8') as Hex,
  rpcUrl: env.LIVE_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  teeUrl: (env.LIVE_TEE_URL ?? 'https://tee.abdulrashid.dev').replace(/\/+$/, ''),
  storageUrl: (env.LIVE_STORAGE_URL ?? 'https://storage.googleapis.com/paperseal-demo-paperseal-exams').replace(/\/+$/, ''),
  /** The one environment value the token check allows: the bucket the TEE writes to. */
  storageBucket: env.LIVE_STORAGE_BUCKET ?? 'paperseal-demo-paperseal-exams',
  keystoreAccount: env.LIVE_KEYSTORE ?? 'paperseal-board',
  /** A path only. It is handed to `cast --password-file` and never read here. */
  passwordFile: env.LIVE_PASSWORD_FILE ?? resolve(homedir(), '.paperseal/board-keystore-password'),
  releasesRepo: env.LIVE_RELEASES_REPO ?? 'AbdulRashidReshamwala/paperseal',
};

export const rpcHost = new URL(deployed.rpcUrl).hostname;

/** Gaps from the moment `publish` runs, in seconds. See the notes in schedule.ts. */
export const gaps = { lock: 40 * 60, unlock: 52 * 60, examStart: 55 * 60, end: 65 * 60 } as const;

export const participantCounts = { setters: 2, neutrals: 3, centreHolders: 7, centresWithoutShare: 1 } as const;
