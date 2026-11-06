// @vitest-environment jsdom
import { plantedKey, plantedRecords } from '@paperseal/keys/demo';
import { encodeMessage, fromHex, hashMessage, inviteTag, questionHash, roles, setterOwner, toHex, utf8ToBytes, type ApprovedListEntry, type Criteria, type Hex } from '@paperseal/protocol';
import type { RegistrationEntry } from '@paperseal/tee-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensRecords } from '../../../../e2e/demo/cards';
import type { BoardInvite } from '../areas/board/invites';
import { confirmTee } from '../areas/setter/confirm';
import { loadReceipts, verifyReceipt } from '../areas/setter/receipts';
import { loadTopics } from '../areas/setter/state';
import { criteria as kitCriteria, examId, makeWorld, registryAddress } from '../areas/setter/testkit';
import type { ReleaseContext } from '../release/flow';
import { loadCredential } from '../shared/Register';
import { keysFor } from './credentials';
import { planQuestions, questionJobs, registerJobs, releaseEnough, releaseJobs, runEach, sampleQuestion, type Job, type PersonState, type World } from './everyone';
import { activePersona, changePersona, personas, scopeStorage, withStorageOf, type Persona } from './personas';
import { setTouchEnabled } from './touch';

const person = (id: string) => personas.find((persona) => persona.id === id) as Persona;
const planted = async (id: string) => {
  const key = await plantedKey(id);
  return { key, passkey: toHex(key.publicKey) };
};
const invite = (fill: string, id: string): BoardInvite => ({ id, role: 'setter', label: id, inviteSecret: `0x${fill.repeat(32)}` as Hex });

function stubWorld(overrides: Partial<World> = {}): World {
  return {
    examId,
    tee: {} as never,
    lookup: { text: () => Promise.resolve(null) } as never,
    registry: { getApprovedListEntries: () => Promise.resolve(null) } as never,
    keysFor,
    storageOf: withStorageOf,
    confirm: () => Promise.reject(new Error('not used')),
    releaseContext: () => null,
    ...overrides,
  };
}

const job = (id: string, done: boolean, run: Job['run'] = () => Promise.resolve()): Job => ({ persona: person(id), done, run: vi.fn(run) });

beforeAll(() => {
  scopeStorage();
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setTouchEnabled(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('running each person', () => {
  const run = async (jobs: Job[], enough?: () => Promise<boolean>) => {
    const seen: Record<string, PersonState> = {};
    await runEach(jobs, { onState: (id, state) => (seen[id] = state), pauseMs: 0, ...(enough ? { enough } : {}) });
    return seen;
  };

  it('leaves alone anyone already done', async () => {
    const jobs = [job('setter-1', true), job('setter-2', false)];
    const seen = await run(jobs);
    expect(jobs[0]?.run).not.toHaveBeenCalled();
    expect(jobs[1]?.run).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ 'setter-2': { kind: 'done', note: 'Done' } });
  });

  it('carries on past someone who fails, and says who', async () => {
    const jobs = [job('centre-1', false, () => Promise.reject(new Error('the node said no'))), job('centre-2', false)];
    const seen = await run(jobs);
    expect(seen['centre-1']).toEqual({ kind: 'failed', reason: 'the node said no' });
    expect(seen['centre-2']).toEqual({ kind: 'done', note: 'Done' });
  });

  it('takes people one at a time', async () => {
    let inside = 0;
    let most = 0;
    const slow = async () => {
      most = Math.max(most, ++inside);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inside -= 1;
    };
    await run([job('centre-1', false, slow), job('centre-2', false, slow), job('centre-3', false, slow)]);
    expect(most).toBe(1);
  });

  it('stops once nobody else is needed', async () => {
    let released = 7;
    const first = job('centre-1', false, () => {
      released += 1;
      return Promise.resolve();
    });
    const second = job('centre-2', false);
    const seen = await run([first, second], () => Promise.resolve(released >= 8));
    expect(second.run).not.toHaveBeenCalled();
    expect(seen['centre-2']).toEqual({ kind: 'not-needed' });
  });

  it('keeps going when the count cannot be read, and leaves the machine to refuse', async () => {
    const only = job('centre-1', false);
    await run([only], () => Promise.reject(new Error('no answer')));
    expect(only.run).toHaveBeenCalledTimes(1);
  });
});

describe('the questions each setter adds', () => {
  const criteria = (percent: number, multiple = 2, questions = 3): Criteria => ({
    maxSetterPercent: percent,
    minBankMultiple: multiple,
    topics: [
      { name: 'Maths', questions },
      { name: 'Physics', questions },
    ],
  });
  const setters = (n: number, first: Record<string, number> = {}) => Array.from({ length: n }, (_, i) => ({ id: `s${String(i)}`, sealed: i === 0 ? first : {} }));

  /** The rule the sealed machine applies at Lock (tee/internal/lock). */
  function meets(rules: Criteria, banks: ReturnType<typeof setters>): void {
    const plan = planQuestions(rules, banks);
    if (!plan.ok) throw new Error(plan.reason);
    for (const topic of rules.topics) {
      const counts = banks.map(({ id, sealed }) => (sealed[topic.name] ?? 0) + (plan.add[id]?.[topic.name] ?? 0));
      const bank = counts.reduce((sum, n) => sum + n, 0);
      expect(bank).toBeGreaterThanOrEqual(topic.questions * rules.minBankMultiple);
      for (const count of counts) expect(count * 100).toBeLessThanOrEqual(rules.maxSetterPercent * bank);
    }
  }

  it.each([
    [50, 2],
    [50, 5],
    [34, 3],
    [34, 5],
    [25, 4],
    [20, 5],
    [100, 2],
  ])('meets the bank and a limit of %i percent with %i setters', (percent, count) => {
    meets(criteria(percent), setters(count));
    meets(criteria(percent), setters(count, { Maths: 1 }));
    meets(criteria(percent), setters(count, { Maths: 3, Physics: 2 }));
    meets(criteria(percent, 3, 7), setters(count, { Physics: 9 }));
  });

  it('leaves a setter alone when the others can make up the rest', () => {
    const plan = planQuestions(criteria(50), setters(3, { Maths: 1, Physics: 1 }));
    expect(plan).toMatchObject({ ok: true });
    if (plan.ok) expect(plan.add.s0).toEqual({});
  });

  it('tops up a setter when the limit means everyone holds the same share', () => {
    const plan = planQuestions(criteria(20), setters(5, { Maths: 1, Physics: 2 }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.add.s0).toEqual({ Maths: 1 });
  });

  it('adds nothing once the bank is met', () => {
    const plan = planQuestions(criteria(50), [
      { id: 'a', sealed: { Maths: 3, Physics: 3 } },
      { id: 'b', sealed: { Maths: 3, Physics: 3 } },
    ]);
    expect(plan).toEqual({ ok: true, add: { a: {}, b: {} } });
  });

  it('says so when there are too few setters for the limit', () => {
    expect(planQuestions(criteria(20), setters(3))).toMatchObject({ ok: false, reason: expect.stringContaining('at least 5 setters') as string });
  });

  it('writes questions that say nothing about who wrote them, and differ', () => {
    const [a, b] = [sampleQuestion('Maths'), sampleQuestion('Maths')];
    expect(a.text).not.toBe(b.text);
    expect(a.text).not.toMatch(/setter/i);
    expect(a.topic).toBe('Maths');
  });
});

describe('registering everyone else', () => {
  const challenge = `0x${'c1'.repeat(40)}` as Hex;
  const parties = [{ name: 'neutral-1.paperseal-demo.eth', role: roles.neutral }];

  async function nameWorld(register = vi.fn((_body: Record<string, Hex>) => Promise.resolve({}))) {
    const records = ensRecords(plantedRecords(await plantedKey('neutral-1')));
    return {
      register,
      world: stubWorld({
        lookup: { text: (_name: string, key: string) => Promise.resolve(records[key] ?? null) } as never,
        tee: {
          registerChallenge: () => Promise.resolve({ challenge }),
          register,
          registrations: () => Promise.resolve({ registrations: [] }),
        } as never,
      }),
    };
  }

  it('skips the setter and centre done by hand, whichever invite the setter used', async () => {
    const hand = await planted('setter-3');
    const invites = [invite('0a', 'one'), invite('0b', 'two')];
    const registrations: RegistrationEntry[] = [
      {
        owner: setterOwner(hand.key.publicKey),
        passkeyPublicKey: hand.passkey,
        derivedPublicKey: '0x',
        inviteTag: toHex(inviteTag(fromHex(invites[0]?.inviteSecret as Hex), hand.key.publicKey)),
      },
      { owner: 'neutral-1.paperseal-demo.eth', passkeyPublicKey: (await planted('neutral-1')).passkey, derivedPublicKey: '0x01', inviteTag: `0x${'00'.repeat(32)}` },
    ];
    const jobs = await registerJobs(stubWorld(), { invites, parties, registrations });
    expect(jobs.map(({ persona, done }) => [persona.id, done])).toEqual([
      ['setter-1', false],
      ['setter-3', true],
      ['neutral-1', true],
    ]);
  });

  it('registers a setter with the board’s invite and their own key, and keeps it where they will find it', async () => {
    const { world, register } = await nameWorld();
    const secret = invite('0a', 'one');
    const [setter] = await registerJobs(world, { invites: [secret], parties: [], registrations: [] });
    await setter?.run(() => undefined);

    const { key, passkey } = await planted('setter-1');
    const body = register.mock.calls[0]?.[0] as Record<string, Hex>;
    const tag = inviteTag(fromHex(secret.inviteSecret), key.publicKey);
    expect(body.passkeyPublicKey).toBe(passkey);
    expect(body.inviteTag).toBe(toHex(tag));
    expect(JSON.stringify(body)).not.toContain(secret.inviteSecret.slice(2));
    const signed = JSON.parse(new TextDecoder().decode(fromHex(body.clientDataJSON as Hex))) as { challenge: string };
    const message = hashMessage('registration', { derivedPublicKey: new Uint8Array(), holderId: utf8ToBytes(setterOwner(key.publicKey)), challenge: fromHex(challenge), inviteTag: tag });
    expect(Buffer.from(signed.challenge, 'base64url')).toEqual(Buffer.from(message));

    expect(activePersona().id).toBe('board');
    expect(loadCredential(examId, 'setter')).toBeNull();
    expect(withStorageOf(person('setter-1'), () => loadCredential(examId, 'setter'))?.credentialId).toBe(toHex(key.credentialId));
  });

  it('registers a party by name with their own key, for both of their pages', async () => {
    const { world, register } = await nameWorld();
    const [party] = await registerJobs(world, { invites: [], parties, registrations: [] });
    await party?.run(() => undefined);
    const { passkey } = await planted('neutral-1');
    expect((register.mock.calls[0]?.[0] as Record<string, Hex>).passkeyPublicKey).toBe(passkey);
    const stored = withStorageOf(person('neutral-1'), () => [loadCredential(examId, 'keyholder'), loadCredential(examId, 'centre')]);
    expect(stored.map((item) => item?.passkeyPublicKey)).toEqual([passkey, passkey]);
    expect(withStorageOf(person('neutral-1'), () => localStorage.getItem('paperseal.party-name'))).toBe('neutral-1.paperseal-demo.eth');
  });

  it('only offers the people the board chose, and setters with no invite wait for one', async () => {
    const jobs = await registerJobs(stubWorld(), { invites: [], parties: [], registrations: [] });
    expect(jobs).toEqual([]);
  });

  it('lets the sealed machine’s refusal stand as that person’s failure', async () => {
    const { world } = await nameWorld(vi.fn(() => Promise.reject(new Error('refused'))));
    const jobs = await registerJobs(world, { invites: [invite('0a', 'one')], parties, registrations: [] });
    const seen: Record<string, PersonState> = {};
    await runEach(jobs, { onState: (id, state) => (seen[id] = state), pauseMs: 0 });
    expect(seen['setter-1']).toEqual({ kind: 'failed', reason: 'refused' });
    expect(seen['neutral-1']).toEqual({ kind: 'failed', reason: 'refused' });
    expect(withStorageOf(person('setter-1'), () => loadCredential(examId, 'setter'))).toBeNull();
  });
});

describe('adding questions for everyone else', () => {
  const entry = async (id: string): Promise<ApprovedListEntry> => ({ owner: id, role: roles.setter, passkeyPublicKey: (await plantedKey(id)).publicKey, derivedPublicKey: new Uint8Array() });

  /** The setter test kit's sealed machine, signing each receipt for the setter who sent it. */
  async function sealingWorld() {
    const kit = await makeWorld();
    const posted = vi.fn(async (body: { ciphertext: Hex; passkeyPublicKey: Hex; signature: Hex }) => {
      const hash = questionHash(fromHex(body.ciphertext));
      return {
        questionHash: toHex(hash),
        teeSignature: await kit.signer.sign(encodeMessage('questionReceipt', { examId: fromHex(examId), passkeyPublicKey: fromHex(body.passkeyPublicKey), questionHash: hash })),
      };
    });
    const world = stubWorld({
      tee: { ...kit.tee, question: posted } as never,
      confirm: () => confirmTee({ examId, registryAddress, tee: kit.tee, chain: kit.chain, policy: kit.env.policy, verifyToken: kit.verifyToken as never }),
    });
    return { kit, world, posted };
  }

  it('seals to each setter’s own key, and keeps the receipts where that setter finds them', async () => {
    const { world, posted, kit } = await sealingWorld();
    const entries = [await entry('setter-1'), await entry('setter-2')];
    const { jobs, problem } = await questionJobs(world, { criteria: kitCriteria, entries, pending: new Map() });
    expect(problem).toBeNull();
    await runEach(jobs, { onState: () => undefined, pauseMs: 0 });

    const senders = posted.mock.calls.map(([body]) => body.passkeyPublicKey);
    expect(new Set(senders)).toEqual(new Set([(await planted('setter-1')).passkey, (await planted('setter-2')).passkey]));
    expect(loadReceipts(examId)).toEqual([]);
    for (const id of ['setter-1', 'setter-2']) {
      const { receipts, topics } = withStorageOf(person(id), () => ({ receipts: loadReceipts(examId), topics: loadTopics(examId) }));
      expect(receipts).toHaveLength(3);
      expect(Object.values(topics).sort()).toEqual(['Mechanics', 'Mechanics', 'Optics']);
      for (const receipt of receipts) await expect(verifyReceipt(examId, (await planted(id)).passkey, receipt)).resolves.toBe(true);
      expect(receipts[0]?.instancePublicKey).toBe(kit.signer.publicKey);
    }

    // Everyone has met the limits, so a second press has nobody left.
    const again = await questionJobs(world, { criteria: kitCriteria, entries, pending: new Map() });
    expect(again.jobs.every(({ done }) => done)).toBe(true);
  });

  it('does nothing when the checks before sealing fail', async () => {
    const { world, posted } = await sealingWorld();
    world.confirm = () => Promise.resolve({ ok: false, step: 'attestation', reasons: ['not the real machine'] });
    const { jobs } = await questionJobs(world, { criteria: kitCriteria, entries: [await entry('setter-1'), await entry('setter-2')], pending: new Map() });
    const seen: Record<string, PersonState> = {};
    await runEach(jobs, { onState: (id, state) => (seen[id] = state), pauseMs: 0 });
    expect(seen['setter-1']).toEqual({ kind: 'failed', reason: 'not the real machine' });
    expect(posted).not.toHaveBeenCalled();
  });

  it('does not count a person on the list only for another role', async () => {
    const { world } = await sealingWorld();
    const centre = { ...(await entry('setter-2')), role: roles.centre };
    const { jobs, problem } = await questionJobs(world, { criteria: kitCriteria, entries: [await entry('setter-1'), centre], pending: new Map() });
    expect(jobs).toEqual([]);
    expect(problem).toContain('at least 2 setters');
  });
});

describe('releasing the rest', () => {
  const entry = async (id: string, role: number): Promise<ApprovedListEntry> => ({ owner: `${id}.paperseal-demo.eth`, role, passkeyPublicKey: (await plantedKey(id)).publicKey, derivedPublicKey: new Uint8Array(65).fill(7) });

  it('skips anyone already released and anyone holding no share', async () => {
    const entries = [await entry('neutral-1', roles.neutral), await entry('centre-1', roles.centreKeyHolder), await entry('centre-8', roles.centre), await entry('setter-1', roles.setter)];
    const jobs = await releaseJobs(stubWorld(), { entries, released: [(await planted('centre-1')).passkey] });
    expect(jobs.map(({ persona, done }) => [persona.id, done])).toEqual([
      ['neutral-1', false],
      ['centre-1', true],
    ]);
  });

  it('asks for the person’s own context, and a page that cannot make one fails for that person only', async () => {
    const asked = vi.fn((_credential: unknown, _derived: Hex, _keys: unknown): ReleaseContext | null => null);
    const [job_] = await releaseJobs(stubWorld({ releaseContext: asked }), { entries: [await entry('neutral-2', roles.neutral)], released: [] });
    await expect(job_?.run(() => undefined)).rejects.toThrow(/missing something/);
    const { key, passkey } = await planted('neutral-2');
    expect(asked.mock.calls[0]?.[0]).toMatchObject({ credentialId: toHex(key.credentialId), passkeyPublicKey: passkey });
    expect(asked.mock.calls[0]?.[1]).toBe(toHex(new Uint8Array(65).fill(7)));
  });

  it('counts as enough at the threshold, and once the machine has released', () => {
    const release = (n: number) => ({ released: Array.from({ length: n }, () => '0x01' as Hex), required: 8 });
    expect(releaseEnough({ stage: 'unlock', release: release(7) })).toBe(false);
    expect(releaseEnough({ stage: 'unlock', release: release(8) })).toBe(true);
    expect(releaseEnough({ stage: 'released', release: release(3) })).toBe(true);
  });
});

describe('another person’s storage', () => {
  it('is reached without changing who this tab is, and only for the call', () => {
    changePersona(person('board'));
    localStorage.setItem('paperseal.mine', 'board');
    withStorageOf(person('centre-2'), () => {
      localStorage.setItem('paperseal.mine', 'centre');
    });
    expect(localStorage.getItem('paperseal.mine')).toBe('board');
    expect(activePersona().id).toBe('board');
    expect(withStorageOf(person('centre-2'), () => localStorage.getItem('paperseal.mine'))).toBe('centre');
  });

  it('is let go of when the call throws', () => {
    localStorage.setItem('paperseal.mine', 'board');
    expect(() =>
      withStorageOf(person('centre-2'), () => {
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(localStorage.getItem('paperseal.mine')).toBe('board');
  });
});

describe('a named person’s keys', () => {
  it('sign as that person, whoever the tab is', async () => {
    changePersona(person('board'));
    const { key } = await planted('setter-4');
    await expect(keysFor(person('setter-4')).sign(key.credentialId, new Uint8Array(32))).resolves.toBeDefined();
    await expect(keysFor(person('setter-5')).sign(key.credentialId, new Uint8Array(32))).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('do not exist for the exam board', async () => {
    const { key } = await planted('setter-4');
    await expect(keysFor(person('board')).sign(key.credentialId, new Uint8Array(32))).rejects.toMatchObject({ name: 'NotAllowedError' });
  });
});
