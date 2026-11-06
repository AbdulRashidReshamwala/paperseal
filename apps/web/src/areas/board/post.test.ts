import { createExamRegistry } from '@paperseal/chain';
import {
  approvedListHash,
  encodeApprovedList,
  encodeMessage,
  fromHex,
  limits,
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
import { splitDetails } from './details';
import { OutboxError, verifyOutboxBuild } from './outbox';
import { explainPostError, postApprovedListFlow, postBuildFlow, type BuildPost } from './postFlow';
import { PublishBlockedError, type PublishEnvironment } from './publishFlow';
import { composeApprovedList, tryCompose, withRoles } from './registrations';

const board = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const stranger = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' as Address;
const examId: Hex = `0x${'11'.repeat(32)}`;
const key = (seed: number): Hex => toHex(new Uint8Array([4, ...new Uint8Array(64).fill(seed)]));

const records = Array.from({ length: 10 }, (_, i) => ({
  owner: `holder-${String(i)}.maths-board.eth`,
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

  it('refuses a key holder or centre whose owner is not an ENS name, and says which entry', () => {
    const plain = entries().map((entry, index) => (index === 0 ? { ...entry, owner: 'holder-0' } : entry));
    expect(() => composeApprovedList(examId, plain)).toThrow('entry 0 owner "holder-0" is not an ENS name');
    expect(tryCompose(examId, plain)).toMatchObject({ ok: false });
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
    await expect(postApprovedListFlow(env, { examId, entries: encoded }, undefined, noWait)).rejects.toThrow('already posted');
    expect(node.sent).toHaveLength(1);
  });

  it('asks the wallet to switch to Sepolia before posting, and shows the instruction if it declines', async () => {
    const { encoded } = composeApprovedList(examId, entries());
    const switched = environment({ chainId: 1, switchable: true });
    expect((await postApprovedListFlow(switched.env, { examId, entries: encoded }, undefined, noWait)).matches).toBe(true);
    const declined = environment({ chainId: 1, switchable: 'decline' });
    await expect(postApprovedListFlow(declined.env, { examId, entries: encoded }, undefined, noWait)).rejects.toThrow('wrong network');
    expect(declined.node.sent).toHaveLength(0);
  });

  it('refuses a list too long to post, before the wallet is asked', async () => {
    const { node, env } = environment();
    const tooLong = toHex(new Uint8Array(limits.entriesBytes + 1));
    await expect(postApprovedListFlow(env, { examId, entries: tooLong }, undefined, noWait)).rejects.toThrow('The list is too long to post');
    const many = entries();
    const padded = Array.from({ length: limits.entries + 1 }, (_, i) => ({ role: roles.setter, owner: 'x', derivedPublicKey: new Uint8Array(), passkeyPublicKey: fromHex(key(i % 200)), ...many[0] }));
    await expect(postApprovedListFlow(env, { examId, entries: toHex(encodeApprovedList(padded)) }, undefined, noWait)).rejects.toThrow('The list is too long to post');
    expect(node.sent).toHaveLength(0);
  });

  it('blocks an account that is not the board', async () => {
    const { node, env } = environment({ account: stranger });
    await expect(postApprovedListFlow(env, { examId, entries: '0x01' }, undefined, noWait)).rejects.toThrow('not the exam board’s account');
    expect(node.sent).toHaveLength(0);
  });

  it('explains a contract revert in plain words before the wallet is asked', async () => {
    const { node, env } = environment({ revertWith: { errorName: 'ApprovedListNotPosted', args: [examId], on: 'postApprovedList' } });
    const error = await postApprovedListFlow(env, { examId, entries: '0x01' }, undefined, noWait).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublishBlockedError);
    expect((error as Error).message).toBe('The list of people has not been posted yet. Post the list first.');
    expect(node.sent).toHaveLength(0);
  });

  it('reports a wallet rejection', async () => {
    const { env } = environment({ rejectSend: true });
    await expect(postApprovedListFlow(env, { examId, entries: '0x01' }, undefined, noWait)).rejects.toThrow('You declined in your wallet');
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
    builtRound: '35732267',
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
    builtRound: BigInt(fields.builtRound),
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
    expect(build).toMatchObject({ selected: 5, bankSize: 40, builtRound: 35732267n, instancePublicKey, teeSignature: outbox.teeSignature });
  });

  it('rejects a changed field, because the signature no longer verifies', async () => {
    const { outbox, instancePublicKey } = await signedBuild();
    const tampered = { ...outbox, fields: { ...outbox.fields, paperHash: `0x${'99'.repeat(32)}` } };
    await expect(verifyOutboxBuild(tampered, { examId, attestedInstancePublicKey: instancePublicKey })).rejects.toThrow('does not verify');
  });

  it('rejects a changed, missing or malformed builtRound', async () => {
    const { outbox, instancePublicKey } = await signedBuild();
    const expected = { examId, attestedInstancePublicKey: instancePublicKey };
    const withRound = (builtRound: unknown) => ({ ...outbox, fields: { ...outbox.fields, builtRound } }) as OutboxMessage;
    await expect(verifyOutboxBuild(withRound('35732268'), expected)).rejects.toThrow('does not verify');
    await expect(verifyOutboxBuild(withRound(35732268), expected)).rejects.toThrow('does not verify');
    for (const bad of ['0', '-1', '1.5', '', 'abc', '18446744073709551616', null]) {
      await expect(verifyOutboxBuild(withRound(bad), expected)).rejects.toThrow('not a drand round');
    }
    const { builtRound: _removed, ...rest } = outbox.fields;
    await expect(verifyOutboxBuild({ ...outbox, fields: rest } as OutboxMessage, expected)).rejects.toThrow('exactly the fields');
    expect(_removed).toBe('35732267');
  });

  it('accepts a builtRound sent as a number', async () => {
    const { outbox, instancePublicKey } = await signedBuild();
    const asNumber = { ...outbox, fields: { ...outbox.fields, builtRound: 35732267 } } as OutboxMessage;
    await expect(verifyOutboxBuild(asNumber, { examId, attestedInstancePublicKey: instancePublicKey })).resolves.toMatchObject({ builtRound: 35732267n });
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
    expect(outcome.rows).toHaveLength(10);
  });

  it('refuses a second Build without sending', async () => {
    const { node, env } = environment();
    const post = await build();
    await postBuildFlow(env, post, undefined, noWait);
    await expect(postBuildFlow(env, post, undefined, noWait)).rejects.toThrow('cannot be recorded twice');
    expect(node.sent).toHaveLength(1);
  });

  it('explains a list hash mismatch in plain words', async () => {
    const { node, env } = environment({ revertWith: { errorName: 'ApprovedListHashMismatch', args: [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`], on: 'postBuild' } });
    await expect(postBuildFlow(env, await build(), undefined, noWait)).rejects.toThrow('different list of people');
    expect(node.sent).toHaveLength(0);
  });
});

describe('explainPostError', () => {
  it('passes plain errors through', () => {
    expect(splitDetails(explainPostError(new Error('boom')))).toEqual({
      say: expect.stringContaining('Try again'),
      detail: 'boom',
    });
  });
});
