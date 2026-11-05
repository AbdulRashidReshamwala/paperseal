import { createExamRegistry } from '@paperseal/chain';
import {
  approvedListHash,
  encodeApprovedList,
  encodeMessage,
  fromHex,
  roles,
  setterOwner,
  toHex,
  type ApprovedListEntry,
  type Hex,
} from '@paperseal/protocol';
import type { OutboxMessage } from '@paperseal/tee-client';
import { createPublicClient, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import { fakeChain, type FakeChainOptions } from '../../test/fakeChain';
import { OutboxError, verifyOutboxBuild } from './outbox';
import { explainPostError, postApprovedListFlow, postBuildFlow, type BuildPost } from './postFlow';
import { PublishBlockedError, type PublishEnvironment } from './publishFlow';
import { composeApprovedList, rolesFor, tryCompose, withRoles } from './registrations';

const board = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const stranger = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' as Address;
const examId: Hex = `0x${'11'.repeat(32)}`;
const key = (seed: number): Hex => toHex(new Uint8Array([4, ...new Uint8Array(64).fill(seed)]));

const records = Array.from({ length: 10 }, (_, i) => ({
  owner: `holder-${String(i)}`,
  role: i < 3 ? roles.neutral : roles.centreKeyHolder,
  passkeyPublicKey: key(10 + i),
  derivedPublicKey: key(50 + i),
}));
const setter = { owner: setterOwner(fromHex(key(90))), role: roles.setter, passkeyPublicKey: key(90), derivedPublicKey: '0x' as Hex };
const entries = (): ApprovedListEntry[] => withRoles([...records, setter], Object.fromEntries([...records, setter].map((r) => [r.passkeyPublicKey, r.role])));

function environment(options: Partial<FakeChainOptions> = {}) {
  const node = fakeChain({ board, ...options });
  const env: PublishEnvironment = {
    registryAddress: node.registry,
    getProvider: () => node.provider,
    publicClient: createPublicClient({ chain: sepolia, transport: node.transport }),
    createRegistry: (wallet) =>
      createExamRegistry({ address: node.registry, transport: node.transport, ...(wallet ? { wallet } : {}) }),
  };
  return { node, env };
}

const noWait = { wait: () => Promise.resolve() };

describe('registrations', () => {
  it('composes a valid list and hashes it as the approvedList message', () => {
    const list = composeApprovedList(examId, entries());
    expect(list.encoded).toBe(toHex(encodeApprovedList(entries())));
    expect(list.hash).toBe(toHex(approvedListHash(fromHex(examId), fromHex(list.encoded))));
  });

  it('refuses a setter whose owner is a plain name, or the hash of another key', () => {
    const named = withRoles([{ ...setter, owner: 'Setter One' }], { [setter.passkeyPublicKey]: roles.setter });
    expect(() => composeApprovedList(examId, [...entries().slice(0, -1), ...named])).toThrow('setterOwner hash');
    const result = tryCompose(examId, [...entries().slice(0, -1), ...named]);
    expect(result.ok ? '' : result.reason).toContain('not the setterOwner hash');
    const other = withRoles([{ ...setter, owner: setterOwner(fromHex(key(91))) }], { [setter.passkeyPublicKey]: roles.setter });
    expect(tryCompose(examId, [...entries().slice(0, -1), ...other])).toMatchObject({ ok: false });
  });

  it('says in words why a list cannot be composed', () => {
    const short = withRoles(records, Object.fromEntries(records.slice(1).map((r) => [r.passkeyPublicKey, r.role])));
    const result = tryCompose(examId, short);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.reason).toContain('expected 3 neutral and 7 centre key holders');
    const repeated = [...entries(), ...entries().slice(0, 1)];
    expect(tryCompose(examId, repeated)).toMatchObject({ ok: false });
  });

  it('offers a setter only the setter role and a holder the three holder roles', () => {
    expect(rolesFor('0x')).toEqual([roles.setter]);
    expect(rolesFor(key(1))).toEqual([roles.neutral, roles.centreKeyHolder, roles.centre]);
  });

  it('leaves out registrations without a role', () => {
    expect(withRoles(records, {})).toEqual([]);
  });
});

describe('postApprovedListFlow', () => {
  it('posts from the board wallet and reads the list back', async () => {
    const { node, env } = environment();
    const { encoded } = composeApprovedList(examId, entries());
    const stages: string[] = [];
    const outcome = await postApprovedListFlow(env, { examId, entries: encoded }, (s) => stages.push(s), noWait);
    expect(stages).toEqual(['checking', 'simulating', 'wallet', 'mining', 'reading']);
    expect(node.sent).toHaveLength(1);
    expect(node.lists.get(examId)?.entries).toBe(encoded);
    expect(outcome.matches).toBe(true);
    expect(outcome.rows.map((row) => row.label)).toEqual(['List hash', 'Posted bytes']);
  });

  it('refuses a second post without sending', async () => {
    const { node, env } = environment();
    const { encoded } = composeApprovedList(examId, entries());
    await postApprovedListFlow(env, { examId, entries: encoded }, undefined, noWait);
    await expect(postApprovedListFlow(env, { examId, entries: encoded }, undefined, noWait)).rejects.toThrow('write-once');
    expect(node.sent).toHaveLength(1);
  });

  it('blocks an account that is not the board', async () => {
    const { node, env } = environment({ account: stranger });
    await expect(postApprovedListFlow(env, { examId, entries: '0x01' }, undefined, noWait)).rejects.toThrow('not the board address');
    expect(node.sent).toHaveLength(0);
  });

  it('explains a contract revert in plain words before the wallet is asked', async () => {
    const { node, env } = environment({ revertWith: { errorName: 'ApprovedListNotPosted', args: [examId], on: 'postApprovedList' } });
    const error = await postApprovedListFlow(env, { examId, entries: '0x01' }, undefined, noWait).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublishBlockedError);
    expect((error as Error).message).toBe('The approved list has not been posted yet, and a Build needs it.');
    expect(node.sent).toHaveLength(0);
  });

  it('reports a wallet rejection', async () => {
    const { env } = environment({ rejectSend: true });
    await expect(postApprovedListFlow(env, { examId, entries: '0x01' }, undefined, noWait)).rejects.toThrow('You rejected the request');
  });
});

/** A TEE instance key and a signed Build, as the outbox serves it. */
async function signedBuild(overrides: Partial<Record<string, string | number>> = {}) {
  const subtle = globalThis.crypto.subtle;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const instancePublicKey = toHex(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const hash = (n: number): Hex => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
  const fields = {
    approvedListHash: hash(1),
    paperHash: hash(2),
    storageManifestHash: hash(3),
    saltedPaperHash: hash(4),
    selected: 5,
    bankSize: 40,
    criteriaHash: hash(6),
    ...overrides,
  };
  const message = encodeMessage('build', {
    examId: fromHex(examId),
    approvedListHash: fromHex(fields.approvedListHash as Hex),
    paperHash: fromHex(fields.paperHash as Hex),
    storageManifestHash: fromHex(fields.storageManifestHash as Hex),
    saltedPaperHash: fromHex(fields.saltedPaperHash as Hex),
    selected: Number(fields.selected),
    bankSize: Number(fields.bankSize),
    criteriaHash: fromHex(fields.criteriaHash as Hex),
  });
  let signature = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(message)));
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const s = BigInt(toHex(signature.subarray(32)));
  if (s > order / 2n) {
    signature = signature.slice();
    signature.set(fromHex(`0x${(order - s).toString(16).padStart(64, '0')}`), 32);
  }
  const outbox: OutboxMessage = {
    kind: 'build',
    examId,
    fields: { ...fields, selected: String(fields.selected) } as OutboxMessage['fields'],
    teeSignature: toHex(signature),
    instancePublicKey,
  };
  return { outbox, instancePublicKey };
}

describe('verifyOutboxBuild', () => {
  it('accepts a Build signed by the attested instance key', async () => {
    const { outbox, instancePublicKey } = await signedBuild();
    const build = await verifyOutboxBuild(outbox, { examId, attestedInstancePublicKey: instancePublicKey });
    expect(build).toMatchObject({ selected: 5, bankSize: 40, instancePublicKey, teeSignature: outbox.teeSignature });
  });

  it('rejects a changed field, because the signature no longer verifies', async () => {
    const { outbox, instancePublicKey } = await signedBuild();
    const tampered = { ...outbox, fields: { ...outbox.fields, paperHash: `0x${'99'.repeat(32)}` } };
    await expect(verifyOutboxBuild(tampered, { examId, attestedInstancePublicKey: instancePublicKey })).rejects.toThrow('does not verify');
  });

  it('rejects a valid signature from a key that is not the attested one', async () => {
    const { outbox } = await signedBuild();
    const other = await signedBuild();
    await expect(verifyOutboxBuild(outbox, { examId, attestedInstancePublicKey: other.instancePublicKey as Hex })).rejects.toThrow('other than the attested');
  });

  it('rejects another exam and unexpected fields', async () => {
    const { outbox, instancePublicKey } = await signedBuild();
    await expect(
      verifyOutboxBuild(outbox, { examId: `0x${'22'.repeat(32)}`, attestedInstancePublicKey: instancePublicKey }),
    ).rejects.toBeInstanceOf(OutboxError);
    const extra = { ...outbox, fields: { ...outbox.fields, more: '0x01' } };
    await expect(verifyOutboxBuild(extra, { examId, attestedInstancePublicKey: instancePublicKey })).rejects.toThrow('exactly the fields');
  });
});

describe('postBuildFlow', () => {
  const build = async (): Promise<BuildPost> => {
    const { outbox, instancePublicKey } = await signedBuild();
    return verifyOutboxBuild(outbox, { examId, attestedInstancePublicKey: instancePublicKey });
  };

  it('posts the Build and reads every field back', async () => {
    const { node, env } = environment();
    const post = await build();
    const outcome = await postBuildFlow(env, post, undefined, noWait);
    expect(node.builds.get(examId)).toBeDefined();
    expect(outcome.matches).toBe(true);
    expect(outcome.rows).toHaveLength(9);
  });

  it('refuses a second Build without sending', async () => {
    const { node, env } = environment();
    const post = await build();
    await postBuildFlow(env, post, undefined, noWait);
    await expect(postBuildFlow(env, post, undefined, noWait)).rejects.toThrow('only one');
    expect(node.sent).toHaveLength(1);
  });

  it('explains a list hash mismatch in plain words', async () => {
    const { node, env } = environment({ revertWith: { errorName: 'ApprovedListHashMismatch', args: [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`], on: 'postBuild' } });
    await expect(postBuildFlow(env, await build(), undefined, noWait)).rejects.toThrow('different approved list');
    expect(node.sent).toHaveLength(0);
  });
});

describe('explainPostError', () => {
  it('passes plain errors through', () => {
    expect(explainPostError(new Error('boom'))).toBe('boom');
  });
});
