import { examRegistryAbi } from '@paperseal/chain';
import { approvedListHash, fromHex, toHex } from '@paperseal/protocol';
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAbiItem,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';

/**
 * An in-memory ExamRegistry behind an EIP-1193 provider, for tests. It is used
 * both as the "browser wallet" and as the RPC node. It checks nothing about
 * rounds or criteria: that is the contract's job, and the real contract is
 * exercised by the anvil integration test.
 */
export interface FakeChainOptions {
  board: Address;
  /** The wallet's account. Defaults to `board`. */
  account?: Address | null;
  chainId?: number;
  /** The wallet moves to Sepolia when asked (`true`), or declines (`'decline'`). Unset: it has no such method. */
  switchable?: boolean | 'decline';
  /** Make `createExam` revert with this contract error. */
  revertWith?: {
    errorName:
      | 'NotBoard'
      | 'ZeroValue'
      | 'UnlockRoundMismatch'
      | 'ExamAlreadyExists'
      | 'ApprovedListNotPosted'
      | 'ApprovedListHashMismatch'
      | 'BuildAlreadyPosted';
    args?: unknown[];
    /** The write that reverts in the dry run. Defaults to `createExam`. */
    on?: 'createExam' | 'postApprovedList' | 'postBuild';
  };
  /** The wallet user rejects the transaction. */
  rejectSend?: boolean;
  /** Corrupt what is stored, to prove read-back catches it. */
  tamper?: (settings: { rpcHost: string }) => { rpcHost: string };
}

type CreateArgs = readonly [Hex, Hex, Record<string, unknown> & { examId: Hex; rpcHost: string }, Hex];

export function fakeChain(options: FakeChainOptions) {
  const { board } = options;
  const account = options.account === undefined ? board : options.account;
  const registry = '0x00000000000000000000000000000000000000aa' as Address;
  const sent: { method: string; params: unknown }[] = [];
  const exams = new Map<string, { args: CreateArgs; block: bigint }>();
  const lists = new Map<string, { entries: Hex; block: bigint }>();
  const builds = new Map<string, Hex[]>();
  const txs = new Map<string, bigint>();
  let block = 100n;
  let walletChain = options.chainId ?? 11155111;

  const created = getAbiItem({ abi: examRegistryAbi, name: 'ExamCreated' });
  const posted = getAbiItem({ abi: examRegistryAbi, name: 'ApprovedListPosted' });
  const zero32 = `0x${'00'.repeat(32)}` as Hex;

  const request = (({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case 'eth_chainId':
        return Promise.resolve(`0x${walletChain.toString(16)}`);
      case 'wallet_switchEthereumChain':
        if (options.switchable === true) {
          walletChain = Number(BigInt((params as [{ chainId: string }])[0].chainId));
          return Promise.resolve(null);
        }
        if (options.switchable === 'decline') return Promise.reject(new Error('User rejected the request.'));
        throw new Error(`unexpected ${method}`);
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return Promise.resolve(account ? [account] : []);
      case 'eth_blockNumber':
        return Promise.resolve(`0x${block.toString(16)}`);
      case 'eth_call': {
        const [{ data }] = params as [{ data: Hex }];
        const call = decodeFunctionData({ abi: examRegistryAbi, data });
        if (call.functionName === 'createExam' || call.functionName === 'postApprovedList' || call.functionName === 'postBuild') {
          if (options.revertWith && (options.revertWith.on ?? 'createExam') === call.functionName) {
            const { errorName, args } = options.revertWith;
            return Promise.reject(
              Object.assign(new Error('execution reverted'), {
                code: 3,
                data: encodeErrorResult({ abi: examRegistryAbi, errorName, args } as never),
              }),
            );
          }
          return Promise.resolve('0x');
        }
        if (call.functionName === 'board') {
          return Promise.resolve(encodeFunctionResult({ abi: examRegistryAbi, functionName: 'board', result: board }));
        }
        if (call.functionName === 'getApprovedList') {
          const [examId] = call.args as [Hex];
          const found = lists.get(examId);
          const result = found
            ? {
                listHash: toHex(approvedListHash(fromHex(examId), fromHex(found.entries))),
                postedAt: 1n,
                postedBlock: found.block,
              }
            : { listHash: zero32, postedAt: 0n, postedBlock: 0n };
          return Promise.resolve(
            encodeFunctionResult({ abi: examRegistryAbi, functionName: 'getApprovedList', result } as never),
          );
        }
        if (call.functionName === 'getBuild') {
          const [examId] = call.args as [Hex];
          const found = builds.get(examId);
          const result = found
            ? {
                approvedListHash: found[1],
                paperHash: found[2],
                storageManifestHash: found[3],
                saltedPaperHash: found[4],
                selected: Number(found[5]),
                bankSize: Number(found[6]),
                postedAt: 1n,
                criteriaHash: found[7],
                teeSignature: found[8],
                instancePublicKey: found[9],
              }
            : {
                approvedListHash: zero32,
                paperHash: zero32,
                storageManifestHash: zero32,
                saltedPaperHash: zero32,
                selected: 0,
                bankSize: 0,
                postedAt: 0n,
                criteriaHash: zero32,
                teeSignature: '0x' as Hex,
                instancePublicKey: '0x' as Hex,
              };
          return Promise.resolve(
            encodeFunctionResult({ abi: examRegistryAbi, functionName: 'getBuild', result } as never),
          );
        }
        if (call.functionName === 'getExam') {
          const [examId] = call.args as [Hex];
          const found = exams.get(examId);
          const [commitHash, imageDigest, settings] = found?.args ?? [
            `0x${'00'.repeat(20)}`,
            `0x${'00'.repeat(32)}`,
            {},
          ];
          const stored = { ...(settings as Record<string, unknown>), ...(options.tamper && found ? options.tamper(settings as { rpcHost: string }) : {}) };
          const result = found
            ? { commitHash, imageDigest, createdAt: 1n, createdBlock: found.block, settings: stored }
            : {
                commitHash,
                imageDigest,
                createdAt: 0n,
                createdBlock: 0n,
                settings: {
                  examId: `0x${'00'.repeat(32)}`,
                  examStart: 0n,
                  delta: 0n,
                  lockRound: 0n,
                  unlockRound: 0n,
                  endRound: 0n,
                  criteriaHash: `0x${'00'.repeat(32)}`,
                  rpcHost: '',
                },
              };
          return Promise.resolve(
            encodeFunctionResult({ abi: examRegistryAbi, functionName: 'getExam', result } as never),
          );
        }
        throw new Error(`unexpected call ${call.functionName}`);
      }
      case 'eth_sendTransaction': {
        sent.push({ method, params });
        if (options.rejectSend) {
          return Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
        }
        const [{ data }] = params as [{ data: Hex }];
        const call = decodeFunctionData({ abi: examRegistryAbi, data });
        block += 1n;
        if (call.functionName === 'postApprovedList') {
          const [examId, entries] = call.args as unknown as [Hex, Hex];
          lists.set(examId, { entries, block });
        } else if (call.functionName === 'postBuild') {
          const args = call.args as unknown as [Hex, ...Hex[]];
          builds.set(args[0], args as unknown as Hex[]);
        } else if (call.functionName === 'createExam') {
          const args = call.args as unknown as CreateArgs;
          exams.set(args[2].examId, { args, block });
        } else {
          throw new Error('unexpected write');
        }
        const hash = `0x${block.toString(16).padStart(64, '0')}`;
        txs.set(hash, block);
        return Promise.resolve(hash);
      }
      case 'eth_getTransactionReceipt': {
        const [hash] = params as [string];
        const found = txs.get(hash);
        if (found === undefined) return Promise.resolve(null);
        return Promise.resolve({
          transactionHash: hash,
          transactionIndex: '0x0',
          blockHash: `0x${'bb'.repeat(32)}`,
          blockNumber: `0x${found.toString(16)}`,
          from: account,
          to: registry,
          cumulativeGasUsed: '0x1',
          gasUsed: '0x1',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x1',
          type: '0x2',
        });
      }
      case 'eth_getLogs': {
        const logs = [...exams.values()].map(({ args, block: at }) => {
          const [commitHash, imageDigest, settings, criteria] = args;
          const data = encodeAbiParameters(
            created.inputs.filter((input) => !('indexed' in input && input.indexed)),
            [
              commitHash,
              imageDigest,
              settings.examStart,
              settings.delta,
              settings.lockRound,
              settings.unlockRound,
              settings.endRound,
              settings.criteriaHash,
              settings.rpcHost,
              criteria,
            ] as never,
          );
          return {
            address: registry,
            topics: encodeEventTopics({ abi: examRegistryAbi, eventName: 'ExamCreated', args: { examId: settings.examId } }),
            data,
            blockNumber: `0x${at.toString(16)}`,
            blockHash: `0x${'bb'.repeat(32)}`,
            transactionHash: `0x${at.toString(16).padStart(64, '0')}`,
            transactionIndex: '0x0',
            logIndex: '0x0',
            removed: false,
          };
        });
        const listLogs = [...lists.entries()].map(([examId, { entries, block: at }]) => ({
          address: registry,
          topics: encodeEventTopics({ abi: examRegistryAbi, eventName: 'ApprovedListPosted', args: { examId: examId as Hex } }),
          data: encodeAbiParameters(
            posted.inputs.filter((input) => !('indexed' in input && input.indexed)),
            [toHex(approvedListHash(fromHex(examId), fromHex(entries))), entries] as never,
          ),
          blockNumber: `0x${at.toString(16)}`,
          blockHash: `0x${'bb'.repeat(32)}`,
          transactionHash: `0x${at.toString(16).padStart(64, '0')}`,
          transactionIndex: '0x0',
          logIndex: '0x0',
          removed: false,
        }));
        const filter = (params as [{ topics: (string | null)[]; fromBlock: string; toBlock: string }])[0];
        // Public RPCs reject wide ranges, so the stub accepts one block only: the record's own.
        if (!/^0x[0-9a-f]+$/.test(filter.fromBlock) || filter.fromBlock !== filter.toBlock) {
          return Promise.reject(
            Object.assign(new Error('eth_getLogs must name exactly one block'), { code: -32602 }),
          );
        }
        const wanted = filter.topics[1];
        const wantedEvent = filter.topics[0];
        return Promise.resolve(
          [...logs, ...listLogs].filter(
            (log) =>
              log.blockNumber === filter.fromBlock &&
              (!wanted || log.topics[1] === wanted) &&
              (!wantedEvent || log.topics[0] === wantedEvent),
          ),
        );
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  }) as unknown as EIP1193Provider['request'];

  const provider = { request } as EIP1193Provider;
  return { provider, transport: custom(provider), registry, sent, exams, lists, builds };
}
