import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chain, type Hex } from '@paperseal/protocol';

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
  registry: (env.LIVE_REGISTRY ?? '0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb') as Hex,
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

export interface LiveGaps {
  /** Seconds from the moment `publish` runs. See the notes in schedule.ts. */
  lock: number;
  unlock: number;
  examStart: number;
  end: number;
  /** `run` refuses to start with less than this many seconds left before Lock. */
  minLeadBeforeLock: number;
  /** When the TEE sees a posted approved list, in words. */
  listDelay: string;
}

/** `chain.readBlock` decides how long a posted list takes to reach the TEE, so it picks the gaps. */
export function gapsFor(readBlock: string): LiveGaps {
  switch (readBlock) {
    case 'latest':
      return { lock: 330, unlock: 360, examStart: 375, end: 460, minLeadBeforeLock: 200, listDelay: 'within seconds, at the latest block' };
    case 'finalized':
      return { lock: 28 * 60, unlock: 31 * 60, examStart: 32 * 60, end: 36 * 60, minLeadBeforeLock: 20 * 60, listDelay: 'at the finalized block, in about 13 to 15 minutes' };
    default:
      throw new Error(`chain.readBlock must be latest or finalized, not ${readBlock}`);
  }
}

export const gaps = gapsFor(chain.readBlock);

export const participantCounts = { setters: 2, neutrals: 3, centreHolders: 7, centresWithoutShare: 1 } as const;
