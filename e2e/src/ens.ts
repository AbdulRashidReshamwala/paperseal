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
 * front of the chain's RPC and answers one thing, the Universal Resolver's `resolveWithGateways` for a
 * name's `addr` and `text` records, from a table the test fills in. Every other call goes to the chain
 * unchanged. The apps are built and run exactly as in production and read through their own RPC URL;
 * nothing in `apps/` or `packages/` knows this exists.
 */

const universalResolver = sepolia.contracts.ensUniversalResolver.address.toLowerCase();
const resolverAbi = parseAbi(['function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)']);
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
  names: Map<string, EnsName>;
  stop: () => Promise<void>;
}

const aName = '0x00000000000000000000000000000000000000ee' as Address;

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

function answer(names: Map<string, EnsName>, data: Hex): Hex {
  const { args } = decodeFunctionData({ abi: resolverAbi, data });
  const [encodedName, inner] = args;
  const name = dotted(encodedName);
  const found = names.get(name);
  const none = encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], ['0x', zeroAddress]);
  if (!found) return none;
  const call = decodeFunctionData({ abi: recordsAbi, data: inner });
  let result: Hex;
  if (call.functionName === 'addr') {
    if (!found.address) return none;
    result = encodeFunctionResult({ abi: recordsAbi, functionName: 'addr', result: found.address });
  } else {
    const value = found.texts?.[call.args[1]];
    if (value === undefined) return none;
    result = encodeFunctionResult({ abi: recordsAbi, functionName: 'text', result: value });
  }
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [result, aName]);
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
  const one = async (call: Call): Promise<unknown> => {
    const target = call.params?.[0];
    if (call.method === 'eth_call' && target?.to?.toLowerCase() === universalResolver && target.data) {
      try {
        return { jsonrpc: '2.0', id: call.id, result: answer(names, target.data) };
      } catch {
        // Not a call this stand-in knows: the chain answers it, and it finds no code there.
      }
    }
    const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call) });
    return (await response.json()) as unknown;
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
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
