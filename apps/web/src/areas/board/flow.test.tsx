// @vitest-environment jsdom
import { createExamRegistry, type EnsLookup } from '@paperseal/chain';
import { encodeMessage, ens, examIdFromName, noInviteTag, passkeyRecordValue, firstRoundAtOrAfter, encodeCriteria, criteriaHash, fromHex, inviteTag, roles, setterOwner, toHex, type Hex } from '@paperseal/protocol';
import type { OutboxMessage, RegistrationEntry, StatusResponse, TeeClient } from '@paperseal/tee-client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createPublicClient, HttpRequestError, type Address } from 'viem';
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
import { saveParties } from './parties';
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

/** A party with a permanent name, or a setter with an invite, and what the TEE lists once they register. */
interface Person {
  owner: string;
  role: number;
  invite?: BoardInvite;
  registration: RegistrationEntry;
}
const party = (i: number, owner: string, role: number): Person => {
  const passkeyPublicKey = key(10 + i);
  return { owner, role, registration: { owner, passkeyPublicKey, derivedPublicKey: key(50 + i), inviteTag: toHex(noInviteTag) } };
};
const setterPerson = (label: string, passkeyPublicKey: Hex, seed: number): Person => {
  const inviteSecret = secretOf(seed);
  const owner = setterOwner(fromHex(passkeyPublicKey));
  return {
    owner,
    role: roles.setter,
    invite: { id: `invite-${String(seed)}`, role: 'setter', label, inviteSecret },
    registration: { owner, passkeyPublicKey, derivedPublicKey: '0x', inviteTag: tagFor(inviteSecret, passkeyPublicKey) },
  };
};
const neutrals = [party(0, 'asha.eth', roles.neutral), party(1, 'ben.eth', roles.neutral), party(2, 'chen.eth', roles.neutral)];
const centres = Array.from({ length: 7 }, (_, i) => party(3 + i, `centre-${String(i + 1)}.paperseal-demo.eth`, roles.centreKeyHolder));
const setter = setterPerson('Setter 1', key(90), 190);
const everyone = [...neutrals, ...centres, setter];
const registrationsOf = (people: readonly Person[]) => people.map((p) => p.registration);
/** What the board's browser holds once it has chosen these names and made these invites. */
const stock = (people: readonly Person[]) => {
  saveInvites(examId, people.flatMap((p) => (p.invite ? [p.invite] : [])));
  saveParties(examId, people.flatMap((p) => (p.invite ? [] : [{ name: p.owner, role: p.role }])));
};

/**
 * Names the board's chain knows: every party has a record naming their own key, and the directory
 * lists them. Tests with another idea of the chain pass their own `ensLookup`.
 */
function directory(extra: readonly Person[] = []): EnsLookup {
  const parties = [...everyone, ...extra].filter((p) => !p.invite);
  const named = new Map(parties.map((p) => [p.owner, p] as const));
  return {
    address: () => Promise.resolve(null),
    primaryName: () => Promise.resolve(null),
    text: (n, k) => {
      if (n === 'paperseal-demo.eth' && k === ens.records.directory) return Promise.resolve(JSON.stringify(parties.map((p) => p.owner)));
      const found = named.get(n);
      if (found && k === ens.records.passkey) return Promise.resolve(passkeyRecordValue(found.registration.passkeyPublicKey));
      if (found && k === ens.records.credential) return Promise.resolve('0x0a0b');
      return Promise.resolve(null);
    },
    code: () => Promise.resolve(undefined),
    board: () => Promise.reject(new Error('not read')),
  };
}

function environment(options: Partial<FakeChainOptions> = {}) {
  const node = fakeChain({ board, ...options });
  const env: PublishEnvironment = {
    ensLookup: directory(),
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
  everyone.map((p) => [p.registration.passkeyPublicKey, p.role]),
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
  const storedParties = () => JSON.parse(localStorage.getItem(`paperseal.parties.${examId}`) ?? '[]') as { name: string; role: number | null }[];
  const addInvite = (text: string) => {
    fireEvent.change(screen.getByLabelText(/^A note for yourself/), { target: { value: text } });
    fireEvent.click(button('Add invite'));
  };
  const tick = async (name: string) => {
    fireEvent.click(await screen.findByLabelText(`Include ${name}`));
  };

  it('makes a setter invite, keeps it in the browser and copies a link with the secret in the fragment', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Bring everyone in' });
    addInvite('');
    await screen.findByText('Waiting for them to register');
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    fireEvent.click(button('Copy the link for Setter 1'));
    await screen.findByText('Copied');
    const link = (writeText.mock.calls[0] as unknown as [string])[0];
    const url = new URL(link);
    expect(url.search).toBe('');
    const stored = storedInvites();
    expect(stored).toHaveLength(1);
    const fragment = new URLSearchParams(url.hash.slice('#/join?'.length));
    expect(fragment.get('exam')).toBe(examId);
    expect(fragment.get('role')).toBe('setter');
    expect(fragment.get('owner')).toBeNull();
    expect(fragment.get('secret')).toBe(stored[0]?.inviteSecret);
  });

  it('shows one public exam link that holds no secret', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Bring everyone in' });
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    fireEvent.click(button('Copy the exam link'));
    await screen.findByText('Copied');
    const link = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(new URL(link).hash).toBe(`#/exam?exam=${examId}`);
  });

  it('lists the directory with a tick per name, and finds a name by searching', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    expect(await screen.findByLabelText('Include asha.eth')).toBeTruthy();
    expect(screen.getByLabelText('Include centre-7.paperseal-demo.eth')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search the directory'), { target: { value: 'centre-7' } });
    await waitFor(() => {
      expect(screen.queryByLabelText('Include asha.eth')).toBeNull();
    });
    expect(screen.getByLabelText('Include centre-7.paperseal-demo.eth')).toBeTruthy();
  });

  it('fills the neutral places, then the key places, and never defaults anyone to a centre without a key', async () => {
    const { env } = await seeded('exam');
    const eighth = party(20, 'centre-8.paperseal-demo.eth', roles.centre);
    renderBoard({ ...env, ensLookup: directory([eighth]) }, fakeTee());
    for (const person of [...neutrals, ...centres, eighth]) await tick(person.owner);
    expect(storedParties().map((chosen) => chosen.role)).toEqual([
      ...neutrals.map(() => roles.neutral),
      ...centres.map(() => roles.centreKeyHolder),
      null,
    ]);
    expect((await screen.findByLabelText<HTMLSelectElement>('Role for centre-8.paperseal-demo.eth')).value).toBe('');
  });

  it('adds a name that is not listed, and refuses a plain name or a repeat', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByLabelText('Include asha.eth');
    const add = (text: string) => {
      fireEvent.change(screen.getByLabelText(/^Add a name that isn't listed/), { target: { value: text } });
      fireEvent.click(button('Add name'));
    };
    add('Dr. Rao');
    expect(await screen.findByText('Use an ENS name, like iit-delhi.eth.')).toBeTruthy();
    add('Dr-Rao.eth');
    expect(await screen.findByText(/Did you mean dr-rao\.eth\?/)).toBeTruthy();
    add('asha.eth');
    expect(await screen.findByText('asha.eth is already here.')).toBeTruthy();
    add('dr-rao.eth');
    expect(await screen.findByLabelText('Include dr-rao.eth')).toBeTruthy();
    expect(storedParties()).toEqual([{ name: 'dr-rao.eth', role: roles.neutral }]);
  });

  it('says plainly that invites live in this browser, and that a backup is private', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Bring everyone in' });
    expect(screen.getByText(/kept in this browser only/)).toBeTruthy();
    expect(screen.getByText(/The backup is private, because it holds everyone’s links/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save a backup' })).toBeNull();
  });

  it('saves a backup file and restores it into an empty browser', async () => {
    const { env } = await seeded('exam');
    const second = setterPerson('Setter 2', key(91), 191);
    stock([setter, second]);
    const blobs: Blob[] = [];
    let downloaded = '';
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), 'blob:test'), revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    renderBoard(env, fakeTee());
    await screen.findByText('Setter 1');
    fireEvent.click(button('Save a backup'));
    expect(downloaded).toMatch(/^paperseal-invites-.*\.json$/);
    const text = await blobs[0]?.text();
    expect(text).toContain(setter.invite?.inviteSecret);
    click.mockRestore();
    cleanup();

    localStorage.removeItem(`paperseal.invites.${examId}`);
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Bring everyone in' });
    expect(screen.queryByText('Setter 1')).toBeNull();
    const file = new File([text ?? ''], 'backup.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Restore from a backup'), { target: { files: [file] } });
    expect(await screen.findByText('Setter 1')).toBeTruthy();
    expect(screen.getByText('Brought back 2 invites.')).toBeTruthy();
    expect(storedInvites()).toHaveLength(2);
  });

  it('refuses a backup that is not for this exam or not a backup at all', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Bring everyone in' });
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
    await screen.findByRole('heading', { name: 'Bring everyone in' });
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    fireEvent.click(button('Copy the link for Setter 1'));
    expect(await screen.findByText(/#\/join\?exam=/)).toBeTruthy();
  });

  it('keeps the chosen names and invites when the board is opened again', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await tick('asha.eth');
    addInvite('');
    await screen.findByText('Setter 1');
    cleanup();
    renderBoard(env, fakeTee());
    expect(await screen.findByText('Setter 1')).toBeTruthy();
    expect((await screen.findByLabelText<HTMLInputElement>('Include asha.eth')).checked).toBe(true);
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
    expect(screen.queryByRole('button', { name: 'Post the list' })).toBeNull();
    expect(node.sent).toHaveLength(sent);
  });

  it('composes the list by itself from matching records, posts with one action, and moves on', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone) }));
    const role = await screen.findByLabelText<HTMLSelectElement>('Role for centre-1.paperseal-demo.eth');
    expect(within(role).getByRole<HTMLOptionElement>('option', { name: 'Centre holding part of the key' }).selected).toBe(true);
    expect(await screen.findAllByText('Name confirmed')).toHaveLength(10);
    expect(screen.getAllByText('Registered')).toHaveLength(1);
    await waitFor(() => {
      expect(button('Post the list')).toBeTruthy();
    });
    fireEvent.click(button('Post the list'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Nothing to do until/);
    });
    const posted = node.lists.get(examId)?.entries;
    expect(posted).toBeDefined();
    expect(node.sent).toHaveLength(sent + 1);
  });

  it('lets the board change a role, and the rules of the list follow', async () => {
    const { env } = await seeded('exam');
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone) }));
    const role = await screen.findByLabelText('Role for centre-1.paperseal-demo.eth');
    await waitFor(() => {
      expect(button('Post the list')).toBeTruthy();
    });
    fireEvent.change(role, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Post the list' })).toBeNull();
    });
    expect(screen.getByText('6 of 7')).toBeTruthy();
  });

  it('keeps a stranger off the list, and shows only a count however many there are', async () => {
    const { env } = await seeded('exam');
    stock(everyone);
    const strangers = [party(30, 'mallory.eth', roles.neutral).registration, party(31, 'mallet.eth', roles.neutral).registration];
    renderBoard(env, fakeTee({ registrations: [...registrationsOf(everyone), ...strangers] }));
    await screen.findByText('2 other registrations match nobody here, so they are not on the list.');
    expect(screen.queryByText('mallory.eth')).toBeNull();
  });

  it('refuses both keys when two use one setter invite, until the board reissues it', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    const twin = setterPerson('Twin', key(92), 190).registration;
    renderBoard(env, fakeTee({ registrations: [...registrationsOf(everyone), twin] }));
    await screen.findByText('Two security keys used this invite, so neither is on the list.');
    expect(screen.getByText(/^0, at least 5 needed/)).toBeTruthy();
    expect(node.sent).toHaveLength(sent);
    const before = storedInvites().find((i) => i.id === 'invite-190');
    fireEvent.click(button('Make a new link for Setter 1'));
    await waitFor(() => {
      expect(screen.queryByText('Two security keys used this invite, so neither is on the list.')).toBeNull();
    });
    expect(storedInvites().find((i) => i.id === 'invite-190')?.inviteSecret).not.toBe(before?.inviteSecret);
    expect(button('Copy the link for Setter 1')).toBeTruthy();
  });

  it('blocks posting while the sealed machine is not at this stage, and says why', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone), status: { stage: 'submit' } }));
    await screen.findByText(/Stage: submit\./);
    expect(screen.queryByRole('button', { name: 'Post the list' })).toBeNull();
    expect(node.sent).toHaveLength(sent);
  });

  it('blocks posting for a machine that fails its proof', async () => {
    verifyTee.mockRejectedValue(new TypeError('network down'));
    const { env } = await seeded('exam');
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone) }));
    await screen.findByText(/network down/);
    expect(screen.queryByRole('button', { name: 'Post the list' })).toBeNull();
  });

  it('checks again right before sending', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    const tee = fakeTee({ registrations: registrationsOf(everyone) });
    renderBoard(env, tee);
    await waitFor(() => {
      expect(button('Post the list')).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: 'Post the list' })).toBeNull();
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
    expect(await screen.findByText(/Setters can start sending questions soon/)).toBeTruthy();
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
  it.each(['/new', '/blueprint', '/schedule', '/publish'])('/board%s starts a new exam when there is none', (path) => {
    renderBoard(environment().env, null, `/board${path}`);
    expect(screen.getByText('Create the exam')).toBeTruthy();
  });

  it.each(['/onboarding', '/list', '/outbox'])('/board%s shows what the last published exam needs now', async (path) => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee(), `/board${path}`);
    expect(await screen.findByText(/Setters can start sending questions soon/)).toBeTruthy();
  });

  it('opens the list at /board even when this browser has an exam, and /board/exam/<id> opens the exam', async () => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee(), '/board');
    expect(await screen.findByText('Your exams')).toBeTruthy();
    expect(screen.queryByText('Create the exam')).toBeNull();
    cleanup();
    renderBoard(env, fakeTee(), `/board/exam/${examId}`);
    expect(await screen.findByText(/Setters can start sending questions soon/)).toBeTruthy();
    expect(screen.queryByText('Create the exam')).toBeNull();
  });

  it('opens an exam named by ?exam= on the start page', async () => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee(), `/board?exam=${examId}`);
    expect(await screen.findByText(/Setters can start sending questions soon/)).toBeTruthy();
  });

  it('says so when the chain has never heard of the exam in the route, and offers the way back', async () => {
    renderBoard(environment().env, fakeTee(), `/board/exam/${examId}`);
    expect(await screen.findByText('We cannot find this exam')).toBeTruthy();
    expect(screen.getByText('All your exams and drafts')).toBeTruthy();
  });

  it('goes to the list for an exam id that is not one, or an old link with no exam', () => {
    renderBoard(environment().env, null, '/board/exam/nonsense');
    expect(screen.getByText('Your exams')).toBeTruthy();
    cleanup();
    renderBoard(environment().env, null, '/board/list');
    expect(screen.getByText('Your exams')).toBeTruthy();
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

  it('names each role in plain words', () => {
    home();
    for (const label of ['Exam board', 'Question setter', 'Exam centre', 'Key holder']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
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

describe('step 3, a name counts only by its record', () => {
  const asha = neutrals[0] as Person;
  const others = [...neutrals.slice(1), ...centres, setter];

  /** The chain, with `record` standing for what `asha.eth`'s paperseal.passkey says. */
  function ensLookup(record: string | null | (() => Promise<string | null>)): EnsLookup {
    const read = typeof record === 'function' ? record : () => Promise.resolve(record);
    const rest = directory();
    return { ...rest, text: (n, k) => (n === 'asha.eth' && k === ens.records.passkey ? read() : rest.text(n, k)) };
  }

  async function open(record: Parameters<typeof ensLookup>[0], registered: readonly Person[] = [asha, ...others]) {
    const { env } = await seeded('exam');
    stock([asha, ...others]);
    renderBoard({ ...env, ensLookup: ensLookup(record) }, fakeTee({ registrations: registrationsOf(registered) }));
  }

  it('confirms a name whose record is the hash of the registered key, and lists it', async () => {
    await open(passkeyRecordValue(asha.registration.passkeyPublicKey));
    expect(await screen.findAllByText('Name confirmed')).toHaveLength(10);
    expect(screen.getByText('3 of 3')).toBeTruthy();
    expect(screen.getByText(/Sepolia, a test network, where anyone can register a similar name/)).toBeTruthy();
    expect(screen.getByText(/Whoever runs paperseal-demo\.eth decides which key belongs to each name/)).toBeTruthy();
  });

  it('keeps a registration with another key off the list, with no way round it', async () => {
    await open(passkeyRecordValue(key(77)));
    await screen.findByText(/asha\.eth with a different security key, so they are not on the list/);
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Go ahead/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Post the list' })).toBeNull();
  });

  it('never lets a name without a record through', async () => {
    await open(null);
    await screen.findByText(/asha\.eth has no security key on it/);
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Go ahead/ })).toBeNull();
  });

  it('accepts only a zero tag: a tag from an invite is not a registration by name', async () => {
    const tagged = { ...asha, registration: { ...asha.registration, inviteTag: `0x${'77'.repeat(32)}` as Hex } };
    await open(passkeyRecordValue(asha.registration.passkeyPublicKey), [tagged, ...others]);
    await screen.findByText(/asha\.eth with a different security key/);
    expect(screen.getByText('2 of 3')).toBeTruthy();
  });

  it('offers try again for an unread name, reads it again, and never blocks the rest', async () => {
    let down = true;
    await open(() => (down ? Promise.reject(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 })) : Promise.resolve(passkeyRecordValue(asha.registration.passkeyPublicKey))));
    await screen.findByText("asha.eth can't be read right now.");
    expect(screen.getByText('2 of 3')).toBeTruthy();
    down = false;
    fireEvent.click(button('Try reading asha.eth again'));
    expect(await screen.findByText('3 of 3')).toBeTruthy();
  });

  it('lets the board take an unread name off, so nothing waits on it forever', async () => {
    await open(() => Promise.reject(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 })));
    fireEvent.click(await screen.findByLabelText('Include asha.eth'));
    await waitFor(() => {
      expect(screen.queryByText("asha.eth can't be read right now.")).toBeNull();
    });
  });

  it('says when the directory can not be read, and keeps the add field', async () => {
    const { env } = await seeded('exam');
    const rest = directory();
    const reading: EnsLookup = { ...rest, text: (n, k) => (k === ens.records.directory ? Promise.reject(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 })) : rest.text(n, k)) };
    renderBoard({ ...env, ensLookup: reading }, fakeTee());
    await screen.findByText(/paperseal-demo\.eth can't be read right now/);
    expect(button('Try again')).toBeTruthy();
    expect(screen.getByLabelText(/^Add a name that isn't listed/)).toBeTruthy();
  });
});
