// @vitest-environment jsdom
import { createExamRegistry } from '@paperseal/chain';
import { encodeMessage, examIdFromName, firstRoundAtOrAfter, encodeCriteria, criteriaHash, fromHex, inviteTag, roles, setterOwner, toHex, type Hex, type InviteRole } from '@paperseal/protocol';
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
const name = 'Physics 2027';
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

function renderBoard(env: PublishEnvironment | undefined, tee: TeeClient | null, path = '/board') {
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

describe('step 4, bring people in', () => {
  const addInvite = (role: string, text: string) => {
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: role } });
    fireEvent.change(screen.getByLabelText(/^(Name for the approved list|Your own note)/), { target: { value: text } });
    fireEvent.click(button('Add invite'));
  };

  it('makes an invite per person, keeps it in the browser and copies a link with the secret in the fragment', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Bring people in' });
    addInvite('keyholder', 'Asha');
    await screen.findByText('Waiting for them to register');
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    fireEvent.click(button('Copy the link for Asha (Neutral party)'));
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
    await screen.findByRole('heading', { name: 'Bring people in' });
    addInvite('keyholder', '  ');
    expect(await screen.findByText('Enter the name to put on the approved list.')).toBeTruthy();
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

  it('prints the link when it cannot be copied', async () => {
    const { env } = await seeded('exam');
    stock([setter]);
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Bring people in' });
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    fireEvent.click(button('Copy the link for Setter 1 (Setter)'));
    expect(await screen.findByText(/#\/join\?exam=/)).toBeTruthy();
  });

  it('keeps the invites when the board is opened again', async () => {
    const { env } = await seeded('exam');
    renderBoard(env, fakeTee());
    await screen.findByRole('heading', { name: 'Bring people in' });
    addInvite('keyholder', 'Asha');
    await screen.findByText('Waiting for them to register');
    cleanup();
    renderBoard(env, fakeTee());
    expect(await screen.findByText('Asha (Neutral party)')).toBeTruthy();
  });

  it('counts against what is needed, and holds the list until it is complete', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf([...neutrals, ...centres.slice(1), setter]) }));
    expect(await screen.findByText('3 of 3')).toBeTruthy();
    expect(screen.getByText('6 of 7')).toBeTruthy();
    expect(screen.getByText(/1, at least 5 needed/)).toBeTruthy();
    await screen.findByText(/needs exactly 3 neutral parties and 7 centres with keys/);
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
    expect(within(role).getByRole<HTMLOptionElement>('option', { name: 'Centre with a key' }).selected).toBe(true);
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
    await screen.findByText('Registered without one of your invites. Not on the list.');
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
      expect(screen.getAllByText('Registered without one of your invites. Not on the list.')).toHaveLength(2);
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
    await screen.findByText('Two security keys used this invite. Neither is on the list.');
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(button('Post the list').disabled).toBe(true);
    expect(node.sent).toHaveLength(sent);
    const before = (JSON.parse(localStorage.getItem(`paperseal.invites.${examId}`) ?? '[]') as BoardInvite[]).find((i) => i.id === 'invite-100');
    fireEvent.click(button('Reissue the invite for Asha (Neutral party)'));
    await waitFor(() => {
      expect(screen.queryByText('Two security keys used this invite. Neither is on the list.')).toBeNull();
    });
    const after = (JSON.parse(localStorage.getItem(`paperseal.invites.${examId}`) ?? '[]') as BoardInvite[]).find((i) => i.id === 'invite-100');
    expect(after?.inviteSecret).not.toBe(before?.inviteSecret);
    expect(screen.getAllByText('Waiting for them to register')).toHaveLength(1);
    // Both old keys now match nothing, so neither is listed, and a new link can be copied.
    expect(screen.getAllByText('Registered without one of your invites. Not on the list.')).toHaveLength(2);
    expect(button('Copy the link for Asha (Neutral party)')).toBeTruthy();
  });

  it('blocks posting while the sealed machine is not at this stage, and says why', async () => {
    const { node, env } = await seeded('exam');
    const sent = node.sent.length;
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone), status: { stage: 'submit' } }));
    await screen.findByText(/at the submit stage, not onboard/);
    expect(button('Post the list').disabled).toBe(true);
    expect(node.sent).toHaveLength(sent);
  });

  it('blocks posting for a machine that fails its proof', async () => {
    verifyTee.mockRejectedValue(new TypeError('network down'));
    const { env } = await seeded('exam');
    stock(everyone);
    renderBoard(env, fakeTee({ registrations: registrationsOf(everyone) }));
    await screen.findByText(/could not be checked: network down/);
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
    await screen.findByText(/could not be checked: gone/);
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
    expect(await screen.findByText(/reads it once it is final/)).toBeTruthy();
  });

  it('says the machine is building once questions close', async () => {
    const { env } = await seeded('list', {}, { lock: -60, start: 3600, end: 7200 });
    renderBoard(env, fakeTee({ status: { stage: 'build', questionCount: 20 } }));
    expect(await screen.findByText('The sealed machine is building the paper')).toBeTruthy();
  });

  it('reports a failed machine, and an unreachable one as not checked', async () => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee({ status: { stage: 'failed' } }));
    expect(await screen.findByText('The sealed machine stopped')).toBeTruthy();
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
    await screen.findByText('Record the sealed paper');
    await screen.findByText(/5 questions, chosen from a bank of 40/);
    fireEvent.click(button('Post to the public record'));
    await screen.findByRole('img', { name: 'Sealed' });
    expect(node.builds.get(examId)).toBeDefined();
  });

  it('blocks a message the attested key did not sign', async () => {
    verifyTee.mockResolvedValue({ instancePublicKey: key(1), encryptionPublicKey: '0x04', verdict: {} });
    const { env } = await seeded('list');
    renderBoard(env, fakeTee({ outbox: [await signedBuild()] }));
    await screen.findByText(/signed by a key other than the attested instance key/);
    expect(button('Post to the public record').disabled).toBe(true);
  });

  it('blocks everything when the machine fails its proof', async () => {
    const { env } = await seeded('list');
    const message = await signedBuild();
    verifyTee.mockRejectedValue(new Error('bad token'));
    renderBoard(env, fakeTee({ outbox: [message] }));
    await screen.findByText(/proof is not trusted, so nothing it signed can be posted\. bad token/);
    expect(button('Post to the public record').disabled).toBe(true);
  });
});

describe('step 7, exam status', () => {
  it('shows the seal, the countdown and the holders released', async () => {
    const { env } = await seeded('build');
    renderBoard(env, fakeTee({ status: { stage: 'distribute', release: { released: [key(1), key(2)], required: 8 } } }));
    await screen.findByRole('img', { name: 'Sealed' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Sealed\. Nothing to do until/);
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(screen.getByText('2 of the 8 needed')).toBeTruthy();
  });

  it('links the public verifier when its address is set, and says so when not', async () => {
    const { env } = await seeded('build');
    renderBoard(env, fakeTee());
    await screen.findByText(/Set VITE_VERIFIER_URL to link it/);
    cleanup();
    vi.stubEnv('VITE_VERIFIER_URL', 'https://verify.example.org/');
    renderBoard(env, fakeTee());
    expect((await screen.findByText('Open the public verifier')).closest('a')?.getAttribute('href')).toBe('https://verify.example.org/');
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
    expect(screen.getByText(/Another exam is under way/)).toBeTruthy();
  });
});

describe('deep links', () => {
  it.each(['', '/blueprint', '/schedule', '/publish', '/onboarding', '/list', '/outbox'])('/board%s starts a new exam when there is none', (path) => {
    renderBoard(environment().env, null, `/board${path}`);
    expect(screen.getByText('Create the exam')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it.each(['', '/onboarding', '/list', '/outbox'])('/board%s shows what the exam needs now', async (path) => {
    const { env } = await seeded('list');
    renderBoard(env, fakeTee(), `/board${path}`);
    expect(await screen.findByText(/reads it once it is final/)).toBeTruthy();
  });

  it('treats an exam pointer the chain has never heard of as no exam', async () => {
    setCurrentExamId(examId);
    renderBoard(environment().env, fakeTee());
    expect(await screen.findByText('Create the exam')).toBeTruthy();
  });
});

describe('when the public record cannot be read', () => {
  it('says the page is not connected rather than guessing a step', () => {
    setCurrentExamId(examId);
    renderBoard({ ...environment().env, createRegistry: null }, null);
    expect(screen.getByText('This page cannot read the public record')).toBeTruthy();
  });

  it('says so when the read fails', async () => {
    setCurrentExamId(examId);
    const { env } = environment();
    const failing = { ...env, createRegistry: () => ({ getExam: () => Promise.reject(new Error('rpc down')) }) as never };
    renderBoard(failing, null);
    expect(await screen.findByText('The public record cannot be read right now')).toBeTruthy();
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
