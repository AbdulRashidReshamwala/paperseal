import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { examRegistryAbi } from '@paperseal/chain';
import type { Hex } from '@paperseal/protocol';
import { encodeFunctionData, type Address } from 'viem';

import { deployed } from './config';
import { errorText } from './util';

/*
 * Every board transaction is `cast send --account <keystore> --password-file <path>` with calldata
 * viem builds from the ABI. The key stays in Foundry's keystore and cast prompts for nothing,
 * because the password comes from the file. This process only passes the file's path along: it
 * never reads the file, and it never logs the command line, which holds only public data anyway.
 */

export type RegistryWrite = 'createExam' | 'postApprovedList' | 'postBuild';

export function calldata(functionName: RegistryWrite, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: examRegistryAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
}

/** The argument vector for `cast send`. Pure, so the dry check can inspect it offline. */
export function castSendArgs(to: Address, data: Hex): string[] {
  return [
    'send',
    to,
    '--data',
    data,
    '--account',
    deployed.keystoreAccount,
    '--password-file',
    deployed.passwordFile,
    '--rpc-url',
    deployed.rpcUrl,
    '--json',
  ];
}

export function castSend(data: Hex, to: Address = deployed.registry, timeoutMs = 10 * 60_000, extra: readonly string[] = []): Promise<Hex> {
  if (!existsSync(deployed.passwordFile)) {
    return Promise.reject(new Error(`the password file ${deployed.passwordFile} does not exist (its contents are never read here)`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('cast', [...castSendArgs(to, data), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cast send did not finish in ${String(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`could not run cast: ${errorText(error)}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`cast send exited ${String(code)}: ${(err || out).trim().slice(0, 1500)}`));
        return;
      }
      try {
        const receipt = JSON.parse(out) as { transactionHash?: string; status?: string | number };
        if (!receipt.transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash)) throw new Error('no transaction hash');
        resolve(receipt.transactionHash.toLowerCase() as Hex);
      } catch {
        // Fall back to the last 0x-hash cast printed.
        const match = /0x[0-9a-fA-F]{64}/.exec(out);
        if (match) resolve(match[0].toLowerCase() as Hex);
        else reject(new Error(`could not read a transaction hash from cast: ${out.trim().slice(0, 500)}`));
      }
    });
  });
}
