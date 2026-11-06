import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { createExamRegistry } from '@paperseal/chain';
import { chain, examIdFromName } from '@paperseal/protocol';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluateBlueprint, evaluatePublish, evaluateSchedule } from '../areas/board/form';
import {
  explainError,
  publishExam,
  readBack,
  type PublishEnvironment,
  type PublishRequest,
} from '../areas/board/publishFlow';

/*
 * Real contract, real chain code. Starts `anvil` as Sepolia (chain id 11155111),
 * deploys ExamRegistry from contracts/out, then runs packages/chain createExam
 * and the app's own publish flow against it.
 *
 * ANVIL_DEV_KEY is anvil's first well-known, public development key. It controls
 * nothing of value anywhere and exists only in this test file. The app has no
 * private keys.
 */
const ANVIL_DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

const artifactPath = resolve(import.meta.dirname, '../../../../contracts/out/ExamRegistry.sol/ExamRegistry.json');

let anvil: ChildProcess;
let rpcUrl: string;
let registryAddress: Address;
const devAccount = privateKeyToAccount(ANVIL_DEV_KEY);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message: string; code: number; data?: unknown } };
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
  return body.result;
}

beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${String(port)}`;
  anvil = spawn('anvil', ['--chain-id', String(chain.chainId), '--port', String(port), '--silent'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const failed = new Promise<never>((_, reject) => {
    anvil.once('error', (error) => {
      reject(new Error(`could not start anvil (is Foundry installed and on PATH?): ${error.message}`));
    });
  });
  const ready = (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await rpc('eth_chainId');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('anvil did not start');
  })();
  await Promise.race([ready, failed]);

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const wallet = createWalletClient({ account: devAccount, chain: sepolia, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [devAccount.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('ExamRegistry was not deployed');
  registryAddress = receipt.contractAddress;
});

afterAll(() => {
  anvil.kill();
});

function requestFor(name: string, unlockOffset = 0): PublishRequest {
  const blueprint = evaluateBlueprint({
    name,
    topics: [
      { name: 'Mechanics', questions: '5' },
      { name: 'Optics', questions: '3' },
    ],
    maxSetterPercent: '20',
    minBankMultiple: '4',
  });
  const day = new Date(Date.now() + 30 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${String(day.getFullYear())}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  const earlier = new Date(Date.now() + 29 * 86_400_000);
  const lockDate = `${String(earlier.getFullYear())}-${pad(earlier.getMonth() + 1)}-${pad(earlier.getDate())}`;
  const schedule = evaluateSchedule({
    examStart: `${date} 09:30`,
    deltaMinutes: '30',
    lockTime: `${lockDate} 12:00`,
    endTime: `${date} 12:30`,
  });
  const fields = evaluatePublish(
    { rpcHost: 'sepolia.example.org' },
    {
      version: 'v1.0.0',
      commit: '0x1234567890abcdef1234567890abcdef12345678',
      imageDigest: `0x${'ab'.repeat(32)}`,
      run: 'https://github.com/example/paperseal/actions/runs/1',
      publishedAt: 0,
    },
  );
  if (!blueprint.examId || !blueprint.encoded || !blueprint.criteriaHash || !schedule.settings || !fields.fields) {
    throw new Error('the test inputs are invalid');
  }
  return {
    examId: blueprint.examId,
    fields: fields.fields,
    schedule: { ...schedule.settings, unlockRound: String(Number(schedule.settings.unlockRound) + unlockOffset) },
    criteria: { encoded: blueprint.encoded, hash: blueprint.criteriaHash },
  };
}

/** The wallet is anvil's own unlocked account, so no key is involved in this path. */
function unlockedWallet(): EIP1193Provider {
  return { request: ({ method, params }: { method: string; params?: unknown }) => rpc(method, params as unknown[]) } as EIP1193Provider;
}

function environment(): PublishEnvironment {
  return {
    registryAddress,
    getProvider: unlockedWallet,
    publicClient: createPublicClient({ chain: sepolia, transport: http(rpcUrl) }),
    createRegistry: (wallet) =>
      createExamRegistry({ address: registryAddress, rpcUrl, ...(wallet ? { wallet } : {}) }),
  };
}

describe('ExamRegistry on anvil', () => {
  it('createExam through packages/chain, then getExam and getCriteria match', async () => {
    const wallet = createWalletClient({ account: devAccount, chain: sepolia, transport: http(rpcUrl) });
    const registry = createExamRegistry({ address: registryAddress, rpcUrl, wallet });
    const request = requestFor('integration-exam-a');
    expect(await registry.board()).toBe(devAccount.address);
    expect(await registry.getExam(request.examId)).toBeNull();

    const hash = await registry.createExam(
      request.fields.commitHash,
      request.fields.imageDigest,
      {
        examId: request.examId,
        examStart: BigInt(request.schedule.examStart),
        delta: BigInt(request.schedule.delta),
        lockRound: BigInt(request.schedule.lockRound),
        unlockRound: BigInt(request.schedule.unlockRound),
        endRound: BigInt(request.schedule.endRound),
        criteriaHash: request.criteria.hash,
        rpcHost: request.fields.rpcHost,
      },
      request.criteria.encoded,
    );
    await createPublicClient({ chain: sepolia, transport: http(rpcUrl) }).waitForTransactionReceipt({ hash });

    const back = await readBack(registry, request, 1);
    expect(back.rows.filter((row) => !row.match)).toEqual([]);
    expect(back.matches).toBe(true);
    expect(back.criteria?.topics).toHaveLength(2);
  });

  it('the app publish flow sends from the board and reads back what it wrote', async () => {
    const request = requestFor('integration-exam-b');
    const outcome = await publishExam(environment(), request);
    expect(outcome.matches).toBe(true);
    expect(outcome.rows.every((row) => row.match)).toBe(true);
  });

  it('refuses to publish the same exam twice', async () => {
    await expect(publishExam(environment(), requestFor('integration-exam-b'))).rejects.toThrow(/already published/);
  });

  it('explains the contract revert for a wrong unlock round before anything is sent', async () => {
    const request = requestFor('integration-exam-c', 1);
    const error = await publishExam(environment(), request).catch((e: unknown) => e);
    expect(explainError(error)).toMatch(/The release time was not accepted/);
    const registry = createExamRegistry({ address: registryAddress, rpcUrl });
    expect(await registry.getExam(examIdFromName('integration-exam-c'))).toBeNull();
  });

  it('refuses an account that is not the board', async () => {
    const accounts = (await rpc('eth_accounts')) as Address[];
    const other = accounts[1];
    if (!other) throw new Error('anvil exposes a second account');
    const provider = {
      request: ({ method, params }: { method: string; params?: unknown }) =>
        method === 'eth_accounts' || method === 'eth_requestAccounts'
          ? Promise.resolve([other])
          : rpc(method, params as unknown[]),
    } as EIP1193Provider;
    await expect(
      publishExam({ ...environment(), getProvider: () => provider }, requestFor('integration-exam-d')),
    ).rejects.toThrow(/not the exam board’s account/);
  });
});
