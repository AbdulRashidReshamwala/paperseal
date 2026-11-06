import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';

/*
 * A test-only stand-in for ENS on the lab's anvil chain, which has no Universal Resolver. It sits in
 * front of the chain's RPC and answers the Universal Resolver's calls for a name's records, a primary
 * name and a resolver, from a table the test fills in. A resolver stand-in lives at `standInResolver`,
 * an address with no code: its `multicall` answers a dry run, and a mined transaction to it is applied
 * to the table the first time its receipt is read, which is what the board's wallet flow does. Every
 * other call goes to the chain unchanged. The apps are built and run exactly as in production and read
 * through their own RPC URL; nothing in `apps/` or `packages/` knows this exists.
 */

const universalResolver = sepolia.contracts.ensUniversalResolver.address.toLowerCase();
const resolverAbi = parseAbi([
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)',
  'function reverseWithGateways(bytes reverseName, uint256 coinType, string[] gateways) view returns (string, address, address)',
  'function findResolver(bytes name) view returns (address, bytes32, uint256)',
]);
const writesAbi = parseAbi([
  'function multicall(bytes[] data) returns (bytes[] results)',
  'function setAddress(bytes name, uint256 coinType, bytes value)',
  'function setText(bytes name, string key, string value)',
]);
const recordsAbi = parseAbi(['function addr(bytes32 node) view returns (address)', 'function text(bytes32 node, string key) view returns (string)']);

/** A name's records. `address` is its `addr` record, and `texts` its text records by key. */
export interface EnsName {
  address?: Address;
  texts?: Record<string, string>;
}

export interface EnsRpc {
  /** The URL the apps are given as their RPC. */
  rpcUrl: string;
  /** Sets up a name, replacing any earlier records. */
  set: (name: string, records?: EnsName) => void;
  /** Makes `name` the address's primary name, both ways, whatever `set` later does to the name's other records. */
  setPrimary: (address: Address, name: string) => void;
  names: Map<string, EnsName>;
  stop: () => Promise<void>;
}

const aName = '0x00000000000000000000000000000000000000ee' as Address;
/** The resolver every name in the table reports. Writes to it land in the table. */
export const standInResolver = '0x00000000000000000000000000000000000e2e05' as Address;

/** The DNS-encoded name in a Universal Resolver call, as dotted text again. */
function dotted(encoded: Hex): string {
  const bytes = Buffer.from(encoded.slice(2), 'hex');
  const labels: string[] = [];
  for (let at = 0; at < bytes.length && bytes[at] !== 0; ) {
    const length = bytes[at] as number;
    labels.push(bytes.subarray(at + 1, at + 1 + length).toString('utf8'));
    at += 1 + length;
  }
  return labels.join('.');
}

function answer(names: Map<string, EnsName>, primaries: Map<string, string>, data: Hex): Hex {
  const decoded = decodeFunctionData({ abi: resolverAbi, data });
  if (decoded.functionName === 'findResolver') {
    return encodeFunctionResult({ abi: resolverAbi, functionName: 'findResolver', result: [standInResolver, `0x${'00'.repeat(32)}`, 0n] });
  }
  if (decoded.functionName === 'reverseWithGateways') {
    const primary = primaries.get(decoded.args[0].toLowerCase()) ?? '';
    return encodeFunctionResult({ abi: resolverAbi, functionName: 'reverseWithGateways', result: [primary, aName, aName] });
  }
  const [encodedName, inner] = decoded.args;
  const name = dotted(encodedName);
  const found = names.get(name);
  const none = encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], ['0x', zeroAddress]);
  const owner = [...primaries].find(([, primary]) => primary === name)?.[0] as Address | undefined;
  if (!found && !owner) return none;
  const call = decodeFunctionData({ abi: recordsAbi, data: inner });
  let result: Hex;
  if (call.functionName === 'addr') {
    const address = owner ?? found?.address;
    if (!address) return none;
    result = encodeFunctionResult({ abi: recordsAbi, functionName: 'addr', result: address });
  } else {
    const value = found?.texts?.[call.args[1]];
    if (value === undefined) return none;
    result = encodeFunctionResult({ abi: recordsAbi, functionName: 'text', result: value });
  }
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [result, aName]);
}

/** What a `multicall` to the stand-in resolver writes. */
function applyWrites(names: Map<string, EnsName>, data: Hex): void {
  const outer = decodeFunctionData({ abi: writesAbi, data });
  if (outer.functionName !== 'multicall') return;
  for (const one of outer.args[0]) {
    const call = decodeFunctionData({ abi: writesAbi, data: one });
    if (call.functionName === 'setAddress') {
      const name = dotted(call.args[0]);
      names.set(name, { ...names.get(name), address: call.args[2] });
    } else if (call.functionName === 'setText') {
      const name = dotted(call.args[0]);
      const entry = names.get(name);
      names.set(name, { ...entry, texts: { ...entry?.texts, [call.args[1]]: call.args[2] } });
    }
  }
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

interface Call {
  id?: unknown;
  method?: string;
  params?: [{ to?: string; data?: Hex } | undefined, ...unknown[]];
}

export async function startEnsRpc(upstream: string): Promise<EnsRpc> {
  const names = new Map<string, EnsName>();
  const primaries = new Map<string, string>();
  const applied = new Set<string>();
  const ask = async (call: unknown): Promise<unknown> => {
    const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call) });
    return (await response.json()) as unknown;
  };
  const one = async (call: Call): Promise<unknown> => {
    const target = call.params?.[0];
    if (call.method === 'eth_call' && target?.to?.toLowerCase() === universalResolver && target.data) {
      try {
        return { jsonrpc: '2.0', id: call.id, result: answer(names, primaries, target.data) };
      } catch {
        // Not a call this stand-in knows: the chain answers it, and it finds no code there.
      }
    }
    if (call.method === 'eth_call' && target?.to?.toLowerCase() === standInResolver.toLowerCase()) {
      return { jsonrpc: '2.0', id: call.id, result: encodeFunctionResult({ abi: writesAbi, functionName: 'multicall', result: [] }) };
    }
    const reply = await ask(call);
    if (call.method === 'eth_getTransactionReceipt') {
      const receipt = (reply as { result?: { to?: string | null; status?: string; transactionHash?: string } | null }).result;
      if (receipt?.to?.toLowerCase() === standInResolver.toLowerCase() && receipt.status === '0x1' && receipt.transactionHash && !applied.has(receipt.transactionHash)) {
        applied.add(receipt.transactionHash);
        const tx = (await ask({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [receipt.transactionHash] })) as { result?: { input?: Hex } };
        if (tx.result?.input) applyWrites(names, tx.result.input);
      }
    }
    return reply;
  };
  const server: Server = createServer((request, response) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'content-type': 'application/json' };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    readBody(request)
      .then(async (text) => {
        const body = JSON.parse(text) as Call | Call[];
        const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
        response.writeHead(200, cors);
        response.end(JSON.stringify(out));
      })
      .catch((error: unknown) => {
        response.writeHead(500, cors);
        response.end(JSON.stringify({ error: String(error) }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the ENS stand-in has no port');
  return {
    rpcUrl: `http://127.0.0.1:${String(address.port)}`,
    names,
    set: (name, records = { address: aName }) => {
      names.set(name, records);
    },
    setPrimary: (address, name) => {
      primaries.set(address.toLowerCase(), name);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
