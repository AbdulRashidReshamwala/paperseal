import type { EnsLookup, ExamRegistry } from '@paperseal/chain';
import type { Keys } from '@paperseal/keys';
import { plantedKey } from '@paperseal/keys/demo';
import { matchInvites, roles, toHex, type ApprovedListEntry, type Criteria, type Hex, type Question } from '@paperseal/protocol';
import type { RegistrationEntry, StatusResponse, TeeClient } from '@paperseal/tee-client';

import type { BoardInvite } from '../areas/board/invites';
import type { ConfirmOutcome } from '../areas/setter/confirm';
import { loadReceipts, saveReceipt } from '../areas/setter/receipts';
import { loadTopics, saveTopic } from '../areas/setter/state';
import { sealAndSubmit, type PendingSubmission } from '../areas/setter/submit';
import { releaseSteps, releaseStepLabels, runRelease, type ReleaseContext } from '../release/flow';
import { loadEnrolments, savePartyName } from '../shared/enrolment';
import { describeError, registerWithTee, saveCredential, type StoredCredential } from '../shared/Register';
import { registerName } from '../shared/RegisterByName';
import { personas, type Persona } from './personas';

/*
 * What the board's panel does for everyone else, one person at a time. Each job runs the code the
 * person's own page runs, with that person's planted key, and keeps what it gets in that person's
 * storage. Nothing here checks, signs or decides anything itself: the sealed machine does its usual
 * checks on every request.
 */

export type PersonState =
  | { kind: 'waiting'; note?: string }
  | { kind: 'working'; note: string }
  | { kind: 'done'; note: string }
  | { kind: 'not-needed' }
  | { kind: 'failed'; reason: string };

export interface Job {
  persona: Persona;
  /** Already done, by hand or by an earlier run. It is left alone. */
  done: boolean;
  /** What will be done, shown before it starts. */
  note?: string;
  run: (say: (note: string) => void) => Promise<void>;
}

/** Between two people, so a public RPC is read politely. */
export const PAUSE_BETWEEN_PEOPLE_MS = 100;
const PAUSE_BETWEEN_QUESTIONS_MS = 20;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RunOptions {
  onState: (id: string, state: PersonState) => void;
  /** Asked before each person. Once true, nobody else is needed. */
  enough?: () => Promise<boolean>;
  pauseMs?: number;
  /** Everyone at once, for steps that don't depend on each other. `enough` is not asked. */
  together?: boolean;
}

/** One person at a time. A failure stays that person's, and the next person still gets their turn. */
export async function runEach(jobs: readonly Job[], options: RunOptions): Promise<void> {
  const { onState, enough, pauseMs = PAUSE_BETWEEN_PEOPLE_MS } = options;
  const todo = jobs.filter((job) => !job.done);
  if (options.together) {
    await Promise.all(
      todo.map(async (job) => {
        const id = job.persona.id;
        onState(id, { kind: 'working', note: 'Working' });
        try {
          await job.run((note) => {
            onState(id, { kind: 'working', note });
          });
          onState(id, { kind: 'done', note: 'Done' });
        } catch (error) {
          onState(id, { kind: 'failed', reason: describeError(error) });
        }
      }),
    );
    return;
  }
  for (const [index, job] of todo.entries()) {
    const id = job.persona.id;
    const stop = await (enough?.() ?? Promise.resolve(false)).catch(() => false);
    if (stop) {
      for (const rest of todo.slice(index)) onState(rest.persona.id, { kind: 'not-needed' });
      return;
    }
    onState(id, { kind: 'working', note: 'Working' });
    try {
      await job.run((note) => {
        onState(id, { kind: 'working', note });
      });
      onState(id, { kind: 'done', note: 'Done' });
    } catch (error) {
      onState(id, { kind: 'failed', reason: describeError(error) });
    }
    if (index < todo.length - 1) await wait(pauseMs);
  }
}

/** What the jobs act through. The panel wires the real ones. */
export interface World {
  examId: Hex;
  tee: Pick<TeeClient, 'registerChallenge' | 'register' | 'registrations' | 'status' | 'attestation' | 'questionChallenge' | 'question'>;
  lookup: EnsLookup;
  registry: Pick<ExamRegistry, 'getApprovedListEntries'>;
  keysFor: (persona: Persona) => Keys;
  storageOf: <T>(persona: Persona, act: () => T) => T;
  confirm: () => Promise<ConfirmOutcome>;
  /** `releaseContext`, with the person's own keys. */
  releaseContext: (credential: StoredCredential, derivedPublicKey: Hex, keys: Keys) => ReleaseContext | null;
}

const passkeyOf = async (persona: Persona) => toHex((await plantedKey(persona.id)).publicKey);
const setterPersonas = personas.filter(({ path }) => path === '/setter');
const partyPersonas = personas.filter(({ owner }) => owner !== undefined);

/** Who is left to register. Setters take the invites nobody has used, in order. */
export async function registerJobs(
  world: World,
  input: { invites: readonly BoardInvite[]; parties: readonly { name: string }[]; registrations: readonly RegistrationEntry[] },
): Promise<Job[]> {
  const { examId, tee } = world;
  const { registrations } = input;
  const held = new Set(registrations.map((item) => item.passkeyPublicKey.toLowerCase()));
  const free = matchInvites(input.invites, registrations).rows.flatMap(({ invite, state }) => (state.kind === 'waiting' ? [invite] : []));

  const setterJobs: Job[] = [];
  for (const persona of setterPersonas) {
    if (held.has(await passkeyOf(persona))) {
      setterJobs.push({ persona, done: true, run: () => Promise.resolve() });
      continue;
    }
    const invite = free.shift();
    if (!invite) continue;
    setterJobs.push({
      persona,
      done: false,
      run: async () => {
        const registration = await registerWithTee({ keys: world.keysFor(persona), tee, invite: { examId, role: invite.role, inviteSecret: invite.inviteSecret } });
        const credential: StoredCredential = {
          owner: registration.owner,
          role: 'setter',
          credentialId: toHex(registration.credentialId),
          passkeyPublicKey: registration.request.passkeyPublicKey,
          inviteTag: registration.request.inviteTag,
        };
        world.storageOf(persona, () => {
          saveCredential(examId, credential);
        });
      },
    });
  }

  const chosen = new Set(input.parties.map(({ name }) => name));
  const parties = partyPersonas.filter(({ owner }) => owner !== undefined && chosen.has(owner));
  const partyJobs = await Promise.all(
    parties.map(async (persona): Promise<Job> => {
      const owner = persona.owner as string;
      const passkey = await passkeyOf(persona);
      return {
        persona,
        done: registrations.some((item) => item.owner === owner && item.passkeyPublicKey.toLowerCase() === passkey),
        run: async () => {
          const enrolments = world.storageOf(persona, loadEnrolments);
          const known = await registerName({ keys: world.keysFor(persona), tee, lookup: world.lookup, registry: world.registry, examId, owner, enrolments });
          world.storageOf(persona, () => {
            savePartyName(owner);
            saveCredential(examId, { ...known, role: 'centre' });
            saveCredential(examId, { ...known, role: 'keyholder' });
          });
        },
      };
    }),
  );
  return [...setterJobs, ...partyJobs];
}

export interface SetterBank {
  id: string;
  /** Sealed so far, by topic. */
  sealed: Readonly<Record<string, number>>;
}

export type QuestionPlan = { ok: true; add: Record<string, Record<string, number>> } | { ok: false; reason: string };

/** The smallest bank for a topic that these setters can fill while none of them goes over the limit. */
function bankSize(needed: number, sealed: readonly number[], percent: number): number {
  const start = Math.max(needed, sealed.reduce((sum, n) => sum + n, 0), Math.ceil((Math.max(...sealed) * 100) / percent));
  let size = start;
  while (sealed.length * Math.floor((size * percent) / 100) < size) size += 1;
  return size;
}

/**
 * How many more questions each setter seals, per topic, so every topic meets the bank size and nobody
 * holds more than the limit. The sealed machine refuses `count * 100 > percent * bank`, so this works
 * to the same rule. Setters with nothing in a topic fill it first. A setter who wrote some by hand is
 * only topped up when the limit leaves no other way, as it does when every setter must hold an equal share.
 */
export function planQuestions(criteria: Criteria, setters: readonly SetterBank[]): QuestionPlan {
  const percent = criteria.maxSetterPercent;
  if (setters.length * percent < 100) {
    return { ok: false, reason: `This exam needs at least ${String(Math.ceil(100 / percent))} setters on the list, and it has ${String(setters.length)} here.` };
  }
  const add = Object.fromEntries(setters.map(({ id }) => [id, {} as Record<string, number>]));
  for (const topic of criteria.topics) {
    const held = setters.map(({ sealed }) => sealed[topic.name] ?? 0);
    const size = bankSize(topic.questions * criteria.minBankMultiple, held, percent);
    const cap = Math.floor((size * percent) / 100);
    const levels = [...held];
    const untouched = (index: number) => held[index] === 0;
    const better = (a: number, b: number) => (untouched(a) === untouched(b) ? (levels[a] ?? 0) < (levels[b] ?? 0) : untouched(a));
    for (let left = size - levels.reduce((sum, n) => sum + n, 0); left > 0; left--) {
      const open = levels.flatMap((level, index) => (level < cap ? [index] : []));
      const next = open.reduce((best, index) => (better(index, best) ? index : best));
      levels[next] = (levels[next] ?? 0) + 1;
      const person = add[setters[next]?.id ?? ''] as Record<string, number>;
      person[topic.name] = (person[topic.name] ?? 0) + 1;
    }
  }
  return { ok: true, add };
}

/** A plain question. It says nothing about who wrote it, and no two read the same. */
export function sampleQuestion(topic: string): Question {
  const code = toHex(globalThis.crypto.getRandomValues(new Uint8Array(3))).slice(2);
  return { topic, text: `${topic} sample question ${code}: explain a result and show the working.` };
}

/** The people here who are on the list in one of these roles, with their entries. */
async function listed(entries: readonly ApprovedListEntry[], among: readonly Persona[], allowed: readonly number[]) {
  const found = await Promise.all(
    among.map(async (persona) => {
      const passkey = await passkeyOf(persona);
      const entry = entries.find((item) => allowed.includes(item.role) && toHex(item.passkeyPublicKey) === passkey);
      return entry ? [{ persona, passkey, entry }] : [];
    }),
  );
  return found.flat();
}

/** Who still has questions to add. `pending` outlives a run, so Try again resends an unanswered question. */
export async function questionJobs(
  world: World,
  input: { criteria: Criteria; entries: readonly ApprovedListEntry[]; pending: Map<string, { current: PendingSubmission | null }> },
): Promise<{ jobs: Job[]; problem: string | null }> {
  const { examId, tee } = world;
  const setters = await listed(input.entries, setterPersonas, [roles.setter]);
  const banks = setters.map(({ persona }) => {
    const { receipts, topics } = world.storageOf(persona, () => ({ receipts: loadReceipts(examId), topics: loadTopics(examId) }));
    const sealed: Record<string, number> = {};
    for (const { questionHash } of receipts) {
      const topic = topics[questionHash];
      if (topic) sealed[topic] = (sealed[topic] ?? 0) + 1;
    }
    return { id: persona.id, sealed };
  });
  const plan = planQuestions(input.criteria, banks);
  if (!plan.ok) return { jobs: [], problem: plan.reason };

  const jobs = setters.map(({ persona, passkey }): Job => {
    const add = Object.entries(plan.add[persona.id] ?? {});
    const total = add.reduce((sum, [, count]) => sum + count, 0);
    const pending = input.pending.get(persona.id) ?? { current: null };
    input.pending.set(persona.id, pending);
    return {
      persona,
      done: total === 0,
      note: `${String(total)} to add`,
      run: async (say) => {
        const checked = await world.confirm();
        if (!checked.ok) throw new Error(checked.reasons.join(' '));
        const key = await plantedKey(persona.id);
        let sealed = 0;
        for (const [topic, count] of add) {
          for (let n = 0; n < count; n++) {
            say(`${String(sealed)} of ${String(total)} sealed`);
            const receipt = await sealAndSubmit(
              {
                keys: world.keysFor(persona),
                tee,
                credentialId: toHex(key.credentialId),
                passkeyPublicKey: passkey,
                pending,
                keep: (exam, stored) => {
                  world.storageOf(persona, () => {
                    saveReceipt(exam, stored);
                  });
                },
              },
              checked.confirmed,
              sampleQuestion(topic),
            );
            world.storageOf(persona, () => {
              saveTopic(examId, receipt.questionHash, topic);
            });
            sealed += 1;
            await wait(PAUSE_BETWEEN_QUESTIONS_MS);
          }
        }
      },
    };
  });
  return { jobs, problem: null };
}

/** True once the sealed machine has all the shares it takes. */
export const releaseEnough = (status: Pick<StatusResponse, 'stage' | 'release'>): boolean =>
  status.stage === 'released' || status.release.released.length >= status.release.required;

/** Everyone here on the list who holds a share, and whether it is already released. */
export async function releaseJobs(world: World, input: { entries: readonly ApprovedListEntry[]; released: readonly Hex[] }): Promise<Job[]> {
  const released = new Set(input.released.map((key) => key.toLowerCase()));
  const holders = await listed(input.entries, partyPersonas, [roles.neutral, roles.centreKeyHolder]);
  return holders.map(({ persona, passkey, entry }): Job => ({
    persona,
    done: released.has(passkey),
    run: async (say) => {
      const key = await plantedKey(persona.id);
      const credential: StoredCredential = { owner: entry.owner, role: 'keyholder', credentialId: toHex(key.credentialId), passkeyPublicKey: passkey };
      const context = world.releaseContext(credential, toHex(entry.derivedPublicKey), world.keysFor(persona));
      if (!context) throw new Error('This page is missing something the release needs. Reload it.');
      await runRelease({
        ...context,
        onStep: (step) => {
          say(`Step ${String(releaseSteps.indexOf(step) + 1)} of ${String(releaseSteps.length)}: ${releaseStepLabels[step]}`);
        },
      });
    },
  }));
}
