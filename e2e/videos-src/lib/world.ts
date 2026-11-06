import { createEnsLookup, createExamRegistry, type EnsLookup, type ExamRegistry } from '@paperseal/chain';
import { ens, type Hex } from '@paperseal/protocol';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

import { castSend } from '../../live/cast';
import { deployed } from '../../live/config';
import { partyParent } from '../../live/roster';
import { makeMockPki } from '../../mock/pki';
import { startMockTee } from '../../mock/mockTee';
import { startChain } from '../../src/chain';
import { startEnsRpc } from '../../src/ens';
import { testWalletScript } from '../../src/wallet';
import { castWalletScript } from '../../ui/castWallet';
import { startStorage } from '../../ui/lab';

/*
 * What a video runs against. `liveWorld` is the real system: Sepolia, the deployed registry and the
 * deployed machine. Every value is the public one in e2e/live/config.ts, and the wallet stand-in signs
 * with `cast send` from the board's keystore, which this code never opens. `mockWorld` is for working on
 * a video without spending: a local chain and a mock machine, as in `ui:mock`. Its footage is never the
 * finished video.
 */

export interface World {
  kind: 'live' | 'mock';
  /** The Vite mode and settings for the app. */
  mode: string;
  env: Record<string, string>;
  walletScript: string;
  bindings: Record<string, (...args: never[]) => unknown>;
  registry: ExamRegistry;
  registryAddress: Hex;
  lookup: EnsLookup;
  /** How many transactions left the wallet so far. */
  sent: () => number;
  stop: () => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tries a read again. The public RPC is load balanced and rate limited, so nodes lag and calls bounce. */
export async function retry<T>(what: string, read: () => Promise<T>, tries = 12, gapMs = 2500): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (attempt > 0) await sleep(gapMs);
    try {
      return await read();
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`${what}: ${last instanceof Error ? last.message : String(last)}`);
}

const refusedBeforeSending = /nonce too low|replacement|underpriced|429|too many requests|rate limit|timed? ?out|connection|error sending|503|502/i;

/**
 * The board's wallet. `--async` hands the transaction over and returns its hash, so the page waits for
 * the receipt itself, as it does with a real wallet. The nonce is the highest any node reports and never
 * below the last one used, because a lagging node reports an old one straight after a transaction.
 */
function castSigner() {
  const client = createPublicClient({ chain: sepolia, transport: http(deployed.rpcUrl) });
  let next = 0;
  let sent = 0;
  const pending = (address: Hex) => retry('reading the board account', () => client.getTransactionCount({ address, blockTag: 'pending' }));
  const send = async (board: Hex, data: Hex, to: Hex): Promise<Hex> => {
    for (let attempt = 0; ; attempt += 1) {
      const counts = await Promise.all([pending(board), pending(board), pending(board)]);
      const nonce = Math.max(next, ...counts);
      try {
        const hash = await castSend(data, to, 120_000, ['--async', '--nonce', String(nonce)]);
        next = nonce + 1;
        sent += 1;
        return hash;
      } catch (error) {
        if (attempt >= 5 || !refusedBeforeSending.test(String(error))) throw error;
        await sleep(4000);
      }
    }
  };
  return { send, sent: () => sent };
}

export async function liveWorld(): Promise<World> {
  const registry = createExamRegistry({ address: deployed.registry, rpcUrl: deployed.rpcUrl });
  const board = await retry('reading the board of the registry', () => registry.board());
  const signer = castSigner();
  return {
    kind: 'live',
    mode: 'demo-keys',
    env: {
      VITE_DEMO_KEYS: '1',
      VITE_RPC_URL: deployed.rpcUrl,
      VITE_REGISTRY_ADDRESS: deployed.registry,
      VITE_TEE_URL: deployed.teeUrl,
      VITE_STORAGE_URL: deployed.storageUrl,
      VITE_TEE_STORAGE_BUCKET: deployed.storageBucket,
      VITE_RELEASES_REPO: deployed.releasesRepo,
      VITE_EXAM_ID: '',
    },
    walletScript: castWalletScript(deployed.rpcUrl, board),
    bindings: { __castSend: (data: Hex, to: Hex) => signer.send(board, data, to) },
    registry,
    registryAddress: deployed.registry,
    lookup: createEnsLookup({ rpcUrl: deployed.rpcUrl }),
    sent: signer.sent,
    stop: () => Promise.resolve(),
  };
}

export async function mockWorld(): Promise<World> {
  const chain = await startChain();
  const names = await startEnsRpc(chain.rpcUrl);
  names.setPrimary(chain.board, partyParent);
  const people = [...[1, 2, 3].map((n) => `neutral-${String(n)}`), ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `centre-${String(n)}`)].map((who) => `${who}.${partyParent}`);
  names.set(partyParent, { texts: { [ens.records.directory]: JSON.stringify(people) } });
  const pki = makeMockPki();
  const storage = await startStorage();
  const registry = createExamRegistry({ address: chain.registry, rpcUrl: chain.rpcUrl });
  const bucket = 'mock-bucket';
  const tee = await startMockTee({ pki, registry, storage: storage.files, bucket, log: () => undefined });
  return {
    kind: 'mock',
    mode: 'mock',
    env: {
      VITE_DEMO_KEYS: '1',
      VITE_RPC_URL: names.rpcUrl,
      VITE_REGISTRY_ADDRESS: chain.registry,
      VITE_TEE_URL: tee.url,
      VITE_STORAGE_URL: storage.url,
      VITE_TEE_STORAGE_BUCKET: bucket,
      VITE_RELEASES_REPO: deployed.releasesRepo,
      VITE_EXAM_ID: '',
      VITE_MOCK_TRUST_ROOT: Buffer.from(pki.rootDer).toString('base64'),
    },
    walletScript: testWalletScript(chain.rpcUrl),
    bindings: {},
    registry,
    registryAddress: chain.registry,
    lookup: createEnsLookup({ rpcUrl: names.rpcUrl }),
    sent: () => 0,
    stop: async () => {
      await tee.stop();
      pki.stop();
      await storage.stop();
      await names.stop();
      await chain.stop();
    },
  };
}
