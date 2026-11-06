#!/usr/bin/env node
// Prints the exact `cast send` commands that put key cards on names, and the directory list on the
// parent. It reads a resolver with one eth_call at most and sends nothing, so it needs no keystore.
//
//   node deploy/ens/records.mjs --name centre-1.paperseal-demo.eth --card card.json
//   node deploy/ens/records.mjs --directory names.json
//
// Names go in as encoded `--data`, because `cast` turns a string ending in `.eth` into the address it
// resolves to. See "Party Names" in spec/api.md and docs/ens-setup.md.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
// viem lives in the workspace, not next to this script.
const require = createRequire(resolve(here, '../../packages/chain/package.json'));
const { createPublicClient, encodeFunctionData, http, parseAbi, toHex } = require('viem');
const { sepolia } = require('viem/chains');
const { normalize, packetToBytes } = require('viem/ens');

const ens = JSON.parse(readFileSync(resolve(here, '../../spec/ens.json'), 'utf8'));

const abi = parseAbi([
  'function setAddress(bytes name, uint256 coinType, bytes value)',
  'function setText(bytes name, string key, string value)',
]);
const ETH = 60n;
/** Any address will do: it only makes the name exist. */
const NO_HOLDER = '0x000000000000000000000000000000000000dEaD';

const dnsName = (name) => toHex(packetToBytes(name));

function checkName(name) {
  if (normalize(name) !== name || !name.includes('.')) throw new Error(`${name} is not a normalised ENS name.`);
  return name;
}

/** The commands for one party: the address record, then the two text records. */
export function partyCalls(name, card) {
  const encoded = dnsName(checkName(name));
  return [
    { what: `${name}: address`, data: encodeFunctionData({ abi, functionName: 'setAddress', args: [encoded, ETH, NO_HOLDER] }) },
    { what: `${name}: ${ens.records.passkey}`, data: encodeFunctionData({ abi, functionName: 'setText', args: [encoded, ens.records.passkey, card.passkey] }) },
    { what: `${name}: ${ens.records.credential}`, data: encodeFunctionData({ abi, functionName: 'setText', args: [encoded, ens.records.credential, card.credentialId] }) },
  ];
}

/** The command for the directory: one text record on the parent, holding a JSON list of names. */
export function directoryCall(parent, names) {
  names.forEach(checkName);
  const value = JSON.stringify(names);
  if (Buffer.byteLength(value) > ens.directoryBytes) throw new Error(`The list is ${String(Buffer.byteLength(value))} bytes, over the limit of ${String(ens.directoryBytes)}.`);
  return { what: `${parent}: ${ens.records.directory}`, data: encodeFunctionData({ abi, functionName: 'setText', args: [dnsName(checkName(parent)), ens.records.directory, value] }) };
}

function readCard(path) {
  const card = JSON.parse(readFileSync(path, 'utf8'));
  if (card.kind !== 'paperseal-key-card' || card.version !== 1) throw new Error(`${path} is not a Paper Seal key card.`);
  if (!/^0x[0-9a-f]{64}$/.test(card.passkey ?? '')) throw new Error(`${path} has no valid passkey hash.`);
  if (!/^0x([0-9a-f]{2})+$/.test(card.credentialId ?? '')) throw new Error(`${path} has no valid credential ID.`);
  return card;
}

async function resolverOf(parent, rpcUrl) {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl), ccipRead: false });
  return client.getEnsResolver({ name: parent });
}

function print(calls, { resolver, account, passwordFile, rpcUrl }) {
  for (const { what, data } of calls) {
    console.log(`# ${what}`);
    console.log(`cast send ${resolver} --data ${data} --account ${account} --password-file ${passwordFile} --rpc-url ${rpcUrl}\n`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      card: { type: 'string' },
      directory: { type: 'string' },
      parent: { type: 'string', default: process.env.VITE_DIRECTORY_NAME || 'paperseal-demo.eth' },
      resolver: { type: 'string' },
      account: { type: 'string', default: 'paperseal-board' },
      'password-file': { type: 'string', default: '~/.paperseal/board-keystore-password' },
      'rpc-url': { type: 'string', default: process.env.VITE_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com' },
    },
  });
  const calls = [];
  if (values.name && values.card) calls.push(...partyCalls(values.name, readCard(values.card)));
  if (values.directory) calls.push(directoryCall(values.parent, JSON.parse(readFileSync(values.directory, 'utf8'))));
  if (calls.length === 0) {
    console.error('Give --name and --card, or --directory. Nothing was printed.');
    process.exit(2);
  }
  const rpcUrl = values['rpc-url'];
  const resolver = values.resolver ?? (await resolverOf(values.parent, rpcUrl));
  console.log(`# Nothing has been sent. Run each command with the wallet that controls ${values.parent}.\n`);
  print(calls, { resolver, account: values.account, passwordFile: values['password-file'], rpcUrl });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
