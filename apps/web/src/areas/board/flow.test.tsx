// @vitest-environment jsdom
import { createExamRegistry, type EnsLookup } from '@paperseal/chain';
import { encodeMessage, ens, examIdFromName, passkeyRecordValue, firstRoundAtOrAfter, encodeCriteria, criteriaHash, fromHex, inviteTag, roles, setterOwner, toHex, type Hex, type InviteRole } from '@paperseal/protocol';
import type { OutboxMessage, RegistrationEntry, StatusResponse, TeeClient } from '@paperseal/tee-client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createPublicClient, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../App';
import { getCurrentExamId, setCurrentExamId } from '../../shared/currentExam';
import { fakeChain, type FakeChainOptions } from '../../test/fakeChain';
import BoardArea from './BoardArea';
import { decideStep, type Snapshot } from './examState';
import { postApprovedListFlow, postBuildFlow } from './postFlow';
import { publishExam, type PublishEnvironment, type PublishRequest } from './publishFlow';
import { saveInvites, type BoardInvite } from './invites';
import { composeApprovedList, withRoles } from './registrations';
import { verifyOutboxBuild } from './outbox';
import { sealStateAt } from './StatusStep';

const verifyTee = vi.fn();
vi.mock('../../shared/attest', async (original) => ({
  ...(await original<typeof import('../../shared/attest')>()),
  verifyTee: (...args: unknown[]) => verifyTee(...args) as unknown,
}));

const board = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const name = 'physics-2027';
const examId = examIdFromName(name);
const key = (seed: number): Hex => toHex(new Uint8Array([4, ...new Uint8Array(64).fill(seed)]));
const noWait = { wait: () => Promise.resolve() };

const secretOf = (seed: number): Hex => toHex(new Uint8Array(32).fill(seed));
const tagFor = (secret: Hex, passkeyPublicKey: Hex): Hex => toHex(inviteTag(fromHex(secret), fromHex(passkeyPublicKey)));

/** A person the board invited, and the registration the TEE lists once they have used the invite. */
interface Person {
  invite: BoardInvite;
  registration: RegistrationEntry;
}
const person = (role: InviteRole, label: string, passkeyPublicKey: Hex, derivedPublicKey: Hex, seed: number): Person => {
  const inviteSecret = secretOf(seed);
  return {
    invite: { id: `invite-${String(seed)}`, role, label, ...(role === 'setter' ? {} : { owner: label }), inviteSecret },
    registration: {
      owner: role === 'setter' ? setterOwner(fromHex(passkeyPublicKey)) : label,
      passkeyPublicKey,
      derivedPublicKey,
      inviteTag: tagFor(inviteSecret, passkeyPublicKey),
    },
  };
};
const holder = (i: number, owner: string, role: InviteRole = 'keyholder') => person(role, owner, key(10 + i), key(50 + i), 100 + i);
const neutrals = [holder(0, 'Asha'), holder(1, 'Ben'), holder(2, 'Chen')];
const centres = Array.from({ length: 7 }, (_, i) => holder(3 + i, `Centre ${String(i + 1)}`, 'centre'));
const setter = person('setter', 'Setter 1', key(90), '0x', 190);
const everyone = [...neutrals, ...centres, setter];
const registrationsOf = (people: readonly Person[]) => people.map((p) => p.registration);
/** The invites are in the board's browser, as they are once it has made them. */
const stock = (people: readonly Person[]) => {
  saveInvites(examId, people.map((p) => p.invite));
};

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

const nowSeconds = () => Math.floor(Date.now() / 1000);

function request(times: { lock: number; start: number; end: number } = { lock: 3600, start: 7200, end: 14400 }): PublishRequest {
  const encoded = encodeCriteria({ maxSetterPercent: 20, minBankMultiple: 4, topics: [{ name: 'Mechanics', questions: 5 }] });
  const start = nowSeconds() + times.start;
  return {
    examId,
    fields: { commitHash: `0x${'a'.repeat(40)}`, imageDigest: `0x${'b'.repeat(64)}`, rpcHost: 'rpc.example.org', version: 'v1.0.0', run: 'https://example.org' },
    schedule: {
      examStart: start,
      delta: 600,
      lockRound: String(firstRoundAtOrAfter(nowSeconds() + times.lock)),
      unlockRound: String(firstRoundAtOrAfter(start - 600)),
      endRound: String(firstRoundAtOrAfter(nowSeconds() + times.end)),
    },
    criteria: { encoded: toHex(encoded), hash: toHex(criteriaHash(encoded)) },
  };
}

const listRoles: Record<string, number> = Object.fromEntries(
  everyone.map((p) => [p.registration.passkeyPublicKey, p.invite.role === 'setter' ? roles.setter : p.invite.role === 'keyholder' ? roles.neutral : roles.centreKeyHolder]),
);
const list = () => composeApprovedList(examId, withRoles(registrationsOf(everyone), listRoles));

function fakeTee(overrides: { status?: Partial<StatusResponse>; registrations?: RegistrationEntry[]; outbox?: OutboxMessage[] } = {}) {
  return {
    status: vi.fn(() => Promise.resolve({ stage: 'onboard', questionCount: 0, release: { released: [], required: 8 }, ...overrides.status })),
    registrations: vi.fn(() => Promise.resolve({ registrations: overrides.registrations ?? [] })),
    outbox: vi.fn(() => Promise.resolve({ messages: overrides.outbox ?? [] })),
    attestation: vi.fn(),
  } as unknown as TeeClient;
}

const instance = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const instancePublicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', instance.publicKey)));

async function signedBuild(): Promise<OutboxMessage> {
  const hash = (n: number): Hex => toHex(new Uint8Array(32).fill(n));
  const fields = {
    approvedListHash: list().hash,
    paperHash: hash(2),
    storageManifestHash: hash(3),
    saltedPaperHash: hash(4),
    selected: 5,
    bankSize: 40,
    criteriaHash: request().criteria.hash,
    builtRound: '35732267',
  };
  const message = encodeMessage('build', {
    examId: fromHex(examId),
    approvedListHash: fromHex(fields.approvedListHash),
    paperHash: fromHex(fields.paperHash),
    storageManifestHash: fromHex(fields.storageManifestHash),
    saltedPaperHash: fromHex(fields.saltedPaperHash),
    selected: fields.selected,
    bankSize: fields.bankSize,
    criteriaHash: fromHex(fields.criteriaHash),
    builtRound: BigInt(fields.builtRound),
  });
  let signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, instance.privateKey, new Uint8Array(message)));
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const s = BigInt(toHex(signature.subarray(32)));
  if (s > order / 2n) {
    signature = signature.slice();
    signature.set(fromHex(`0x${(order - s).toString(16).padStart(64, '0')}`), 32);
  }
  return { kind: 'build', examId, fields: fields as unknown as OutboxMessage['fields'], teeSignature: toHex(signature), instancePublicKey };
}

/** A chain with the exam published, and as far along as `upTo` says. */
async function seeded(upTo: 'exam' | 'list' | 'build', options: Partial<FakeChainOptions> = {}, times?: Parameters<typeof request>[0]) {
  const { node, env } = environment(options);
  await publishExam(env, request(times), undefined, noWait);
  if (upTo !== 'exam') await postApprovedListFlow(env, { examId, entries: list().encoded }, undefined, noWait);
  if (upTo === 'build') {
    const build = await verifyOutboxBuild(await signedBuild(), { examId, attestedInstancePublicKey: instancePublicKey });
    await postBuildFlow(env, build, undefined, noWait);
  }
  setCurrentExamId(examId);
  return { node, env };
}

function renderBoard(env: PublishEnvironment | undefined, tee: TeeClient | null, path = `/board/exam/${examId}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/board/*" element={<BoardArea {...(env ? { environment: env } : {})} tee={tee} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const button = (label: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name: label });

beforeEach(() => {
  localStorage.clear();
  verifyTee.mockReset();
  verifyTee.mockResolvedValue({ instancePublicKey, encryptionPublicKey: '0x04', verdict: {} });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('decideStep', () => {
  const blank: Snapshot = { found: null, list: null, build: null, status: null, teeProblem: null, outbox: [] };
  const found = {} as NonNullable<Snapshot['found']>;
  const posted = {} as NonNullable<Snapshot['list']>;
  const build = {} as NonNullable<Snapshot['build']>;
  const message = {} as OutboxMessage;

  it.each([
    ['draft', blank],
    ['people', { ...blank, found }],
    ['wait', { ...blank, found, list: posted }],
    ['post-build', { ...blank, found, list: posted, outbox: [message] }],
    ['status', { ...blank, found, list: posted, build }],
    ['status', { ...blank, found, list: posted, build, outbox: [message] }],
  ] as const)('shows %s', (step, snapshot) => {
    expect(decideStep(snapshot)).toBe(step);
  });
});

describe('sealStateAt', () => {
  it('follows the unlock and end times', () => {
    expect(sealStateAt(1, 2, 3)).toBe('sealed');
    expect(sealStateAt(2, 2, 3)).toBe('opening');
    expect(sealStateAt(3, 2, 3)).toBe('open');
  });
});

describe('step 3, bring people in', () => {
  const storedInvites = () => JSON.parse(localStorage.getItem(`paperseal.invites.${examId}`) ?? '[]') as BoardInvite[];
  const addInvite = (role: string, text: string) => {
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: role } });
    fireEvent.change(screen.getByLabelText(/^(Name to show on the public list|A note for yourself)/), { target: { value: text } });
    fireEvent.click(button('Add invite'));
  };

  it('makes an invite per person, keeps it in the browser and copies a link with the secret in the fragment', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Invite people' });
    addInvite('keyholder', 'Asha');
    await screen.findByText('Waiting for them to register');
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    fireEvent.click(button('Copy the link for Asha (Key holder)'));
    await screen.findByText('Copied');
    const link = (writeText.mock.calls[0] as unknown as [string])[0];
    const url = new URL(link);
    expect(url.search).toBe('');
    const stored = JSON.parse(localStorage.getItem(`paperseal.invites.${examId}`) ?? '[]') as BoardInvite[];
    expect(stored).toHaveLength(1);
    const fragment = new URLSearchParams(url.hash.slice('#/join?'.length));
    expect(fragment.get('exam')).toBe(examId);
    expect(fragment.get('role')).toBe('keyholder');
    expect(fragment.get('owner')).toBe('Asha');
    expect(fragment.get('secret')).toBe(stored[0]?.inviteSecret);
  });

  it('asks for a name for a key holder, refuses a repeat, and needs none for a setter', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Invite people' });
    addInvite('keyholder', '  ');
    expect(await screen.findByText('Enter the name to show on the public list.')).toBeTruthy();
    addInvite('keyholder', 'Asha');
    await screen.findByText('Waiting for them to register');
    addInvite('keyholder', 'Asha');
    expect(await screen.findByText('Asha already has an invite.')).toBeTruthy();
    addInvite('setter', '');
    expect(await screen.findByText('Setter 1 (Setter)')).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem(`paperseal.invites.${examId}`) ?? '[]') as BoardInvite[];
    expect(stored.find((i) => i.role === 'setter')?.owner).toBeUndefined();
    expect(new Set(stored.map((i) => i.inviteSecret)).size).toBe(2);
  });

  it('says plainly that invites live in this browser, and that a backup is private', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Invite people' });
    expect(screen.getByText(/kept in this browser only/)).toBeTruthy();
    expect(screen.getByText(/The backup is private, because it holds everyone’s links/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save a backup' })).toBeNull();
  });

  it('saves a backup file and restores it into an empty browser', async () => {
    const { env } = await seeded('exam');
    stock([neutrals[0] as Person, setter]);
    const blobs: Blob[] = [];
    let downloaded = '';
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), 'blob:test'), revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    renderBoard(env, fakeTee());
    await screen.findByText('Asha (Key holder)');
    fireEvent.click(button('Save a backup'));
    expect(downloaded).toMatch(/^paperseal-invites-.*\.json$/);
    const text = await blobs[0]?.text();
    expect(text).toContain(neutrals[0]?.invite.inviteSecret);
    click.mockRestore();
    cleanup();

    localStorage.removeItem(`paperseal.invites.${examId}`);
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Invite people' });
    expect(screen.queryByText('Asha (Key holder)')).toBeNull();
    const file = new File([text ?? ''], 'backup.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Restore from a backup'), { target: { files: [file] } });
    expect(await screen.findByText('Asha (Key holder)')).toBeTruthy();
    expect(screen.getByText('Brought back 2 invites.')).toBeTruthy();
    expect(storedInvites()).toHaveLength(2);
  });

  it('refuses a backup that is not for this exam or not a backup at all', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Invite people' });
    const restore = async (content: string) => {
      fireEvent.change(screen.getByLabelText('Restore from a backup'), { target: { files: [new File([content], 'x.json')] } });
    };
    await restore('not json');
    expect(await screen.findByText(/not an invite backup from Paper Seal/)).toBeTruthy();
    await restore(JSON.stringify({ kind: 'paperseal-invites', examId: `0x${'12'.repeat(32)}`, invites: [] }));
    expect(await screen.findByText(/for a different exam/)).toBeTruthy();
    expect(storedInvites()).toHaveLength(0);
  });

  it('prints the link when it cannot be copied', async () => {
    const { env } = await seeded('exam');
    stock([setter]);
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Invite people' });
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    fireEvent.click(button('Copy the link for Setter 1 (Setter)'));
    expect(await screen.findByText(/#\/join\?exam=/)).toBeTruthy();
  });

  it('keeps the invites when the board is opened again', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Invite people' });
    addInvite('keyholder', 'Asha');
    await screen.findByText('Waiting for them to register');
    cleanup();
    renderBoard(env, fakeTee());
    expect(await screen.findByText('Asha (Key holder)')).toBeTruthy();
  });

  it('counts against what is needed, and holds the list until it is complete', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf([...neutrals, ...centres.slice(1), setter]) }));
    expect(await screen.findByText('3 of 3')).toBeTruthy();
    expect(screen.getByText('6 of 7')).toBeTruthy();
    expect(screen.getByText(/1, at least 5 needed/)).toBeTruthy();
    await screen.findByText(/needs exactly 3 key holders and 7 centres holding part of the key/);
    expect(button('Post the list').disabled).toBe(true);
    expect(node.sent).toHaveLength(sent);
  });

  it('composes the list by itself from matching invites, posts with one action, and moves on', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone) }));
    // A centre's key place is the only choice, and it is already made. Key holders and setters have none.
    const role = await screen.findByLabelText<HTMLSelectElement>('Role for Centre 1');
    expect(within(role).getByRole<HTMLOptionElement>('option', { name: 'Centre holding part of the key' }).selected).toBe(true);
    expect(screen.queryByLabelText('Role for Asha')).toBeNull();
    expect(screen.queryByLabelText('Role for Setter 1')).toBeNull();
    expect(screen.getAllByText('Registered')).toHaveLength(11);
    await waitFor(() => {
      expect(button('Post the list').disabled).toBe(false);
    });
    fireEvent.click(button('Post the list'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Nothing to do until/);
    });
    expect(node.lists.get(examId)?.entries).toBe(list().encoded);
    expect(node.sent).toHaveLength(sent + 1);
  });

  it('never defaults anyone to a centre without a key', async () => {
    const { env } = await seeded('exam');
    const extra = holder(20, 'Centre 8', 'centre');
    stock([...everyone, extra]);
    renderBoard(env, fakeTee({ registrations: registrationsOf([...everyone, extra]) }));
    expect((await screen.findByLabelText<HTMLSelectElement>('Role for Centre 8')).value).toBe('');
  });

  it('lets the board change a centre, and the rules of the list follow', async () => {
    const { env } = await seeded('exam');
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone) }));
    const role = await screen.findByLabelText('Role for Centre 1');
    await waitFor(() => {
      expect(button('Post the list').disabled).toBe(false);
    });
    fireEvent.change(role, { target: { value: '' } });
    expect(button('Post the list').disabled).toBe(true);
    expect(screen.getByText('6 of 7')).toBeTruthy();
  });

  it('keeps a registration without a valid tag off the list and says so', async () => {
    const { env } = await seeded('exam');
    stock(everyone);
    const guessed: RegistrationEntry = { ...holder(30, 'Asha').registration, inviteTag: `0x${'77'.repeat(32)}` };
    renderBoard(env, fakeTee({ registrations: [...registrationsOf(everyone.slice(1)), guessed] }));
    await screen.findByText('This person registered without one of your invites, so they are not on the list.');
    expect(screen.getAllByText('Waiting for them to register')).toHaveLength(1);
    expect(screen.getByText('2 of 3')).toBeTruthy();
  });

  it('refuses a tag copied from someone else, and a right tag under another name', async () => {
    const { env } = await seeded('exam');
    stock(everyone);
    const [asha, ...rest] = neutrals;
    const copied: RegistrationEntry = { ...holder(31, 'Asha').registration, inviteTag: (asha as Person).registration.inviteTag };
    const renamed: RegistrationEntry = { ...(rest[0] as Person).registration, owner: 'Someone Else' };
    renderBoard(env, fakeTee({ registrations: [copied, renamed, ...registrationsOf(centres), setter.registration] }));
    await waitFor(() => {
      expect(screen.getAllByText('This person registered without one of your invites, so they are not on the list.')).toHaveLength(2);
    });
    expect(screen.getByText('0 of 3')).toBeTruthy();
  });

  it('refuses both keys when two use one invite, until the board reissues it', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    const twin: RegistrationEntry = {
      ...holder(40, 'Asha').registration,
      inviteTag: tagFor((neutrals[0] as Person).invite.inviteSecret, key(40 + 10)),
    };
    renderBoard(env, fakeTee({ registrations: [...registrationsOf(everyone), twin] }));
    await screen.findByText('Two security keys used this invite, so neither is on the list.');
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(button('Post the list').disabled).toBe(true);
    expect(node.sent).toHaveLength(sent);
    const before = (JSON.parse(localStorage.getItem(`paperseal.invites.${examId}`) ?? '[]') as BoardInvite[]).find((i) => i.id === 'invite-100');
    fireEvent.click(button('Make a new link for Asha (Key holder)'));
    await waitFor(() => {
      expect(screen.queryByText('Two security keys used this invite, so neither is on the list.')).toBeNull();
    });
    const after = (JSON.parse(localStorage.getItem(`paperseal.invites.${examId}`) ?? '[]') as BoardInvite[]).find((i) => i.id === 'invite-100');
    expect(after?.inviteSecret).not.toBe(before?.inviteSecret);
    expect(screen.getAllByText('Waiting for them to register')).toHaveLength(1);
    // Both old keys now match nothing, so neither is listed, and a new link can be copied.
    expect(screen.getAllByText('This person registered without one of your invites, so they are not on the list.')).toHaveLength(2);
    expect(button('Copy the link for Asha (Key holder)')).toBeTruthy();
  });

  it('blocks posting while the sealed machine is not at this stage, and says why', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone), status: { stage: 'submit' } }));
    await screen.findByText(/Stage: submit\./);
    expect(button('Post the list').disabled).toBe(true);
    expect(node.sent).toHaveLength(sent);
  });

  it('blocks posting for a machine that fails its proof', async () => {
    verifyTee.mockRejectedValue(new TypeError('network down'));
    const { env } = await seeded('exam');
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone) }));
    await screen.findByText(/network down/);
    expect(button('Post the list').disabled).toBe(true);
  });

  it('checks again right before sending', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    const tee = fakeTee({ registrations: registrationsOf(everyone) });
    renderBoard(env, tee);
    await waitFor(() => {
      expect(button('Post the list').disabled).toBe(false);
    });
    verifyTee.mockRejectedValue(new TypeError('gone'));
    fireEvent.click(button('Post the list'));
    await screen.findByText(/gone/);
    expect(node.sent).toHaveLength(sent);
  });

  it('says so when the sealed machine is not connected', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, null);
    await screen.findByText(/not connected, so nobody can register yet/);
    expect(button('Post the list').disabled).toBe(true);
  });
});

describe('step 5, wait', () => {
  it('shows questions against the bank and time until Lock, with nothing to press', async () => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee({ status: { stage: 'submit', questionCount: 7 } }));
    await screen.findByText('7 of at least 20');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Nothing to do until/);
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(document.querySelector('.ps-primary')).toBeNull();
  });

  it('says the list is going final while the machine is still at onboard', async () => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee());
    expect(await screen.findByText(/Setters can start sending questions in about 20 minutes/)).toBeTruthy();
  });

  it('says the machine is building once questions close', async () => {
    const { env } = await seeded('list', {}, { lock: -60, start: 3600, end: 7200 });
    renderBoard(env, fakeTee({ status: { stage: 'build', questionCount: 20 } }));
    expect(await screen.findByText('The paper is being built')).toBeTruthy();
  });

  it('reports a failed machine, and an unreachable one as not checked', async () => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee({ status: { stage: 'failed' } }));
    expect(await screen.findByText('The paper could not be built')).toBeTruthy();
    cleanup();
    const tee = fakeTee();
    vi.mocked(tee.status).mockRejectedValue(new Error('refused'));
    renderBoard(env, tee);
    expect(await screen.findByText('refused')).toBeTruthy();
    expect(screen.getByText('Not checked')).toBeTruthy();
  });
});

describe('step 6, post the Build', () => {
  it('verifies the outbox, posts with one action, and shows the seal', async () => {
    const { node, env } = await seeded('list');
    renderBoard(env, fakeTee({ outbox: [await signedBuild()], status: { stage: 'build' } }));
    await screen.findByText('The paper is ready');
    await screen.findByText(/5 questions, chosen from the 40 sent in/);
    fireEvent.click(button('Post the paper’s record'));
    await screen.findByRole('img', { name: 'Sealed' });
    expect(node.builds.get(examId)).toBeDefined();
  });

  it('blocks a message the attested key did not sign', async () => {
    verifyTee.mockResolvedValue({ instancePublicKey: key(1), encryptionPublicKey: '0x04', verdict: {} });
    const { env } = await seeded('list');
    renderBoard(env, fakeTee({ outbox: [await signedBuild()] }));
    await screen.findByText(/signed by a key other than the attested instance key/);
    expect(button('Post the paper’s record').disabled).toBe(true);
  });

  it('blocks everything when the machine fails its proof', async () => {
    const { env } = await seeded('list');
    const message = await signedBuild();
    verifyTee.mockRejectedValue(new Error('bad token'));
    renderBoard(env, fakeTee({ outbox: [message] }));
    await screen.findByText(/Paper Seal could not be confirmed for this exam/);
    expect(button('Post the paper’s record').disabled).toBe(true);
  });
});

describe('step 7, exam status', () => {
  it('shows the seal, the countdown and the holders released', async () => {
    const { env } = await seeded('build');
    renderBoard(env, fakeTee({ status: { stage: 'distribute', release: { released: [key(1), key(2)], required: 8 } } }));
    await screen.findByRole('img', { name: 'Sealed' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Sealed\. Nothing to do until/);
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(screen.getByText('2 of 8 needed')).toBeTruthy();
  });

  it('links the public verifier when its address is set, and says so when not', async () => {
    const { env } = await seeded('build');
    renderBoard(env, fakeTee());
    await screen.findByText(/link is not set up yet/);
    cleanup();
    vi.stubEnv('VITE_VERIFIER_URL', 'https://verify.example.org/');
    renderBoard(env, fakeTee());
    expect((await screen.findByText('Open the public page')).closest('a')?.getAttribute('href')).toBe(`https://verify.example.org/?exam=${examId}`);
    expect(screen.getByRole('button', { name: 'Copy public link' })).toBeTruthy();
  });

  /** The value beside a record's label in the ENS card. */
  const recordValue = (card: HTMLElement, label: string) =>
    within(card).getByText(label, { selector: 'li > span:first-child' }).nextElementSibling?.textContent;

  it('lists the ENS records to set, with the values this app uses', async () => {
    vi.stubEnv('VITE_TEE_URL', 'https://tee.example.org/');
    vi.stubEnv('VITE_STORAGE_URL', 'https://storage.googleapis.com/exam-bucket');
    vi.stubEnv('VITE_TEE_STORAGE_BUCKET', 'exam-bucket');
    vi.stubEnv('VITE_VERIFIER_URL', 'https://verify.example.org/');
    const { env } = await seeded('build');
    renderBoard(env, fakeTee());
    const fold = await screen.findByText('Give this exam an ENS name (optional)');
    const card = fold.parentElement as HTMLElement;
    expect(within(card).getByText(/See docs\/ens-setup\.md/)).toBeTruthy();
    expect(recordValue(card, 'ETH address')).toMatch(new RegExp(`^${env.registryAddress ?? ''}`));
    expect(recordValue(card, 'Text paperseal.tee')).toMatch(/^https:\/\/tee\.example\.org(Copy)?$/);
    expect(recordValue(card, 'Text paperseal.storage')).toMatch(/^https:\/\/storage\.googleapis\.com\/exam-bucket(Copy)?$/);
    expect(recordValue(card, 'Text paperseal.bucket')).toMatch(/^exam-bucket(Copy)?$/);
    // This session didn't publish the exam, so it doesn't know the name, only its hash.
    expect(recordValue(card, 'Subname')).toBe('<exam name>');
    expect(recordValue(card, 'Public page by name')).toBe('https://verify.example.org/#/name/<exam name>.<your-name>.eth');
    expect(within(card).getByRole('button', { name: 'Copy Text paperseal.tee' })).toBeTruthy();
  });

  it('says which ENS values are not set, and leaves out the verifier link without its address', async () => {
    const { env } = await seeded('build');
    renderBoard(env, fakeTee());
    const card = (await screen.findByText('Give this exam an ENS name (optional)')).parentElement as HTMLElement;
    expect(recordValue(card, 'Text paperseal.tee')).toMatch(/Ask whoever installed Paper Seal to set VITE_TEE_URL\.$/);
    expect(recordValue(card, 'Text paperseal.storage')).toMatch(/Ask whoever installed Paper Seal to set VITE_STORAGE_URL\.$/);
    expect(recordValue(card, 'Text paperseal.bucket')).toMatch(/Ask whoever installed Paper Seal to set VITE_TEE_STORAGE_BUCKET\.$/);
    expect(within(card).queryByText('Public page by name')).toBeNull();
  });

  it('opens once the end time has passed', async () => {
    const { env } = await seeded('build', {}, { lock: -7200, start: -3000, end: -60 });
    renderBoard(env, fakeTee({ status: { stage: 'released' } }));
    await screen.findByRole('img', { name: 'Open' });
    expect(screen.getByText('The exam is over')).toBeTruthy();
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('sets up another exam from here', async () => {
    const { env } = await seeded('build');
    renderBoard(env, fakeTee());
    fireEvent.click(await screen.findByText('Set up another exam'));
    expect(await screen.findByText('Create the exam')).toBeTruthy();
    expect((screen.getByLabelText(/^Exam name/) as HTMLInputElement).value).toBe('');
  });
});

describe('deep links', () => {
  it.each(['', '/blueprint', '/schedule', '/publish'])('/board%s starts a new exam when there is none', (path) => {
    renderBoard(environment().env, null, `/board${path}`);
    expect(screen.getByText('Create the exam')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it.each(['/onboarding', '/list', '/outbox'])('/board%s shows what the last published exam needs now', async (path) => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee(), `/board${path}`);
    expect(await screen.findByText(/Setters can start sending questions in about 20 minutes/)).toBeTruthy();
  });

  it('opens the create page at /board even when this browser has an exam, and /board/exam/<id> opens the exam', async () => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee(), '/board');
    expect(await screen.findByText('Create the exam')).toBeTruthy();
    cleanup();
    renderBoard(env, fakeTee(), `/board/exam/${examId}`);
    expect(await screen.findByText(/Setters can start sending questions in about 20 minutes/)).toBeTruthy();
    expect(screen.queryByText('Create the exam')).toBeNull();
  });

  it('opens an exam named by ?exam= on the start page', async () => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee(), `/board?exam=${examId}`);
    expect(await screen.findByText(/Setters can start sending questions in about 20 minutes/)).toBeTruthy();
  });

  it('says so when the chain has never heard of the exam in the route, and offers the way back', async () => {
    renderBoard(environment().env, fakeTee(), `/board/exam/${examId}`);
    expect(await screen.findByText('We cannot find this exam')).toBeTruthy();
    expect(screen.getByText('All your exams and drafts')).toBeTruthy();
  });

  it('goes to the create page for an exam id that is not one, or an old link with no exam', () => {
    renderBoard(environment().env, null, '/board/exam/nonsense');
    expect(screen.getByText('Create the exam')).toBeTruthy();
    cleanup();
    renderBoard(environment().env, null, '/board/list');
    expect(screen.getByText('Create the exam')).toBeTruthy();
  });
});

describe('when the public record cannot be read', () => {
  it('says the page is not connected rather than guessing a step', () => {
    setCurrentExamId(examId);
    renderBoard({ ...environment().env, createRegistry: null }, null);
    expect(screen.getByText('This page is not ready to use yet')).toBeTruthy();
  });

  it('says so when the read fails', async () => {
    setCurrentExamId(examId);
    const { env } = environment();
    const failing = { ...env, createRegistry: () => ({ getExam: () => Promise.reject(new Error('rpc down')) }) as never };
    renderBoard(failing, null);
    expect(await screen.findByText('Your exam cannot be loaded right now')).toBeTruthy();
  });
});

describe('landing page', () => {
  const home = (path = '/') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

  it('names each role in plain words, with the seal', () => {
    home();
    for (const label of ['Exam board', 'Question setter', 'Exam centre', 'Key holder']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('img', { name: 'The Paper Seal' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/TEE|chain|hash|passkey|timelock|drand/i);
  });

  it('follows the exam a link names', async () => {
    home(`/?exam=${examId}`);
    await waitFor(() => {
      expect(getCurrentExamId()).toBe(examId);
    });
  });

  it('ignores anything that is not an exam ID', () => {
    home('/?exam=0x1234');
    expect(getCurrentExamId()).toBeNull();
  });
});

describe('step 3, ENS names for key holders and centres', () => {
  const storedInvites = () => JSON.parse(localStorage.getItem(`paperseal.invites.${examId}`) ?? '[]') as BoardInvite[];
  const addInvite = (role: string, text: string) => {
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: role } });
    fireEvent.change(screen.getByLabelText(/^(Name to show on the public list|A note for yourself)/), { target: { value: text } });
    fireEvent.click(button('Add invite'));
  };

  const asha = holder(0, 'asha.eth');
  const ashaValue = passkeyRecordValue(asha.registration.passkeyPublicKey);
  const others = [...neutrals.slice(1), ...centres, setter];

  /** The reads of ENS, with `record` standing for what `asha.eth`'s paperseal.passkey says. */
  function ensLookup(record: string | null | (() => Promise<string | null>), owner = 'asha.eth'): EnsLookup {
    const read = typeof record === 'function' ? record : () => Promise.resolve(record);
    return {
      address: (n) => Promise.resolve(n === owner ? ('0x00000000000000000000000000000000000000ee' as Address) : null),
      primaryName: () => Promise.resolve(null),
      text: (n, k) => (n === owner && k === ens.records.passkey ? read() : Promise.resolve(null)),
      code: () => Promise.resolve(undefined),
      board: () => Promise.reject(new Error('not read')),
    };
  }

  async function open(record: Parameters<typeof ensLookup>[0], registered: readonly Person[] = [asha, ...others]) {
    const { env } = await seeded('exam');
    stock([asha, ...others]);
    renderBoard({ ...env, ensLookup: ensLookup(record) }, fakeTee({ registrations: registrationsOf(registered) }));
  }

  it('recognises an ENS name, refuses one that is not normalised, and still takes a plain name', async () => {
    const { env } = await seeded('exam');
    renderBoard({ ...env, ensLookup: ensLookup(null) }, fakeTee());
    await screen.findByRole('heading', { name: 'Invite people' });
    fireEvent.change(screen.getByLabelText(/^Name to show on the public list/), { target: { value: 'dr-rao.eth' } });
    expect(screen.getByText(/This is an ENS name/)).toBeTruthy();
    addInvite('keyholder', 'Dr-Rao.eth');
    expect(await screen.findByText(/Did you mean dr-rao\.eth\?/)).toBeTruthy();
    expect(storedInvites()).toHaveLength(0);
    addInvite('keyholder', 'Dr. Rao');
    await screen.findByText('Dr. Rao (Key holder)');
    addInvite('keyholder', 'dr-rao.eth');
    await screen.findByText('dr-rao.eth (Key holder)');
    expect(storedInvites().map((i) => i.owner)).toEqual(['Dr. Rao', 'dr-rao.eth']);
  });

  it('shows a waiting ENS invite as found on the name, and says Sepolia names prove nothing', async () => {
    const { env } = await seeded('exam');
    stock([asha]);
    renderBoard({ ...env, ensLookup: ensLookup(null) }, fakeTee());
    await screen.findByText('Name found');
    expect(screen.getByText('Waiting for them to register')).toBeTruthy();
    expect(screen.getByText(/Sepolia, a test network, where anyone can register a similar name/)).toBeTruthy();
  });

  it('confirms a key holder whose record is the hash of the registered key, and lists them', async () => {
    await open(ashaValue);
    await screen.findByText('Name confirmed');
    expect(screen.getByText('3 of 3')).toBeTruthy();
  });

  it('keeps a key holder off the list when the record names another key, whatever the board chooses', async () => {
    await open(passkeyRecordValue(key(77)));
    await screen.findByText(/is for a different security key, so they are not on the list/);
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Go ahead without the name/ })).toBeNull();
    expect(button('Make a new link for asha.eth (Key holder)')).toBeTruthy();
    expect(button('Post the list').disabled).toBe(true);
  });

  it('waits for a missing record, and lets the board go ahead with the name marked unconfirmed', async () => {
    await open(null);
    await screen.findByText(/Waiting for asha\.eth to be set up with their security key/);
    expect(screen.getByText('2 of 3')).toBeTruthy();
    fireEvent.click(button('Go ahead without the name for asha.eth (Key holder)'));
    await screen.findByText('On the list, but asha.eth is not confirmed.');
    expect(screen.getByText('3 of 3')).toBeTruthy();
    expect(storedInvites().find((i) => i.owner === 'asha.eth')?.goAhead).toBe(true);
    fireEvent.click(button('Wait for the name for asha.eth (Key holder)'));
    await screen.findByText(/Waiting for asha\.eth/);
    expect(storedInvites().find((i) => i.owner === 'asha.eth')?.goAhead).toBeUndefined();
  });

  it('treats a name the chain refuses to answer as unconfirmed, not as a failure', async () => {
    await open(() => Promise.reject(new Error('gateway needed')));
    await screen.findByText(/can't be read right now/);
    expect(screen.getByText('2 of 3')).toBeTruthy();
  });

  it('reads a key holder only once their key has registered, so a waiting invite never reads a record', async () => {
    const text = vi.fn(() => Promise.resolve(null));
    const { env } = await seeded('exam');
    stock([asha]);
    renderBoard({ ...env, ensLookup: { ...ensLookup(null), text } }, fakeTee());
    await screen.findByText('Name found');
    expect(text).not.toHaveBeenCalled();
  });

  it('leaves a centre on the list whatever its name says, and says the name proves nothing about independence', async () => {
    const north = holder(20, 'north.centres.maths-board.eth', 'centre');
    const { env } = await seeded('exam');
    stock([...everyone.filter((p) => p.invite.role !== 'centre' || p.invite.owner !== 'Centre 1'), north]);
    const registered = [...registrationsOf(everyone.filter((p) => p.invite.owner !== 'Centre 1')), north.registration];
    renderBoard({ ...env, ensLookup: ensLookup(null, 'north.centres.maths-board.eth') }, fakeTee({ registrations: registered }));
    await screen.findByText(/is a name for the list\. It does not show that this centre is independent\./);
    expect(screen.getByText('7 of 7')).toBeTruthy();
  });

  it('without a way to read names, keeps the key holder waiting and lets the board go ahead', async () => {
    const { env } = await seeded('exam');
    stock([asha, ...others]);
    renderBoard(env, fakeTee({ registrations: registrationsOf([asha, ...others]) }));
    await screen.findByText(/asha\.eth can't be read from this page/);
    expect(screen.getByText('2 of 3')).toBeTruthy();
  });
});
