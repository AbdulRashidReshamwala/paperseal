import type { Hex } from '@paperseal/protocol';
import type { AttestationResponse } from '@paperseal/tee-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUCKET, chainExam, examIdOf, REGISTRY, testMachine } from './machineTestkit';
import { judgeMachine, machineState, machineWords, readMachine, type MachineRead, type MachineState } from './machineVerdict';

const thisExam = examIdOf(0x11);
const otherExam = examIdOf(0x22);
const exam = chainExam(thisExam);

let machine: Awaited<ReturnType<typeof testMachine>>;
beforeAll(async () => {
  machine = await testMachine();
});
afterAll(() => {
  machine.stop();
});
beforeEach(() => {
  vi.stubEnv('MODE', 'mock');
  vi.stubEnv('VITE_MOCK_TRUST_ROOT', machine.rootBase64);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const answered = (attestation: AttestationResponse): MachineRead => ({ state: 'answered', attestation, misses: 0 });
const judge = (attestation: AttestationResponse, storageBucket = BUCKET) => judgeMachine(answered(attestation), { examId: thisExam, exam, registry: REGISTRY, storageBucket });
const words = (state: MachineState, listPosted = false) => machineWords(state, { otherExam: (id) => (id === otherExam ? 'Biology 2026' : `exam ${id.slice(2, 10)}`), listPosted });

describe('judgeMachine', () => {
  it('is ready only when the real check trusts the token', async () => {
    const verdict = await judge(await machine.started(exam));
    expect(verdict).toEqual({ state: 'ready' });
    expect(words(verdict).lede).toBe('The machine is running this exam, with the published code and settings.');
  });

  it('says which exam the machine is running instead', async () => {
    const verdict = await judge(await machine.started(chainExam(otherExam)));
    expect(verdict).toEqual({ state: 'other', examId: otherExam });
    expect(words(verdict).lede).toBe('The machine is running Biology 2026, so this exam cannot take registrations right now.');
    expect(words(verdict, true).lede).toContain('cannot continue');
    expect(words(verdict).next).toContain('Ask whoever runs Paper Seal');
  });

  it('names the code when the image differs', async () => {
    const verdict = await judge(await machine.started(exam, { digest: `0x${'cd'.repeat(32)}` }));
    expect(verdict).toMatchObject({ state: 'mismatch', differs: ['code'] });
    expect(words(verdict).lede).toBe('The machine names this exam, but these differ from what was published: code.');
  });

  it.each([
    ['exam start time', { examStart: 1 }],
    ['release time', { delta: 1 }],
    ['time questions close', { lockRound: '1' }],
    ['time the paper unlocks', { unlockRound: '1' }],
    ['time the paper opens to everyone', { endRound: '1' }],
    ['topics', { criteriaHash: `0x${'09'.repeat(32)}` as Hex }],
    ['public record connection', { rpcHost: 'other.example.org' }],
    ['public record address', { registry: `0x${'dd'.repeat(20)}` as Hex }],
    ['network', { chainId: 1 }],
  ])('names the %s when it differs', async (word, settings) => {
    expect(await judge(await machine.started(exam, { settings }))).toMatchObject({ state: 'mismatch', differs: [word] });
  });

  it('names everything that differs, each once, the code first', async () => {
    const verdict = await judge(await machine.started(exam, { digest: `0x${'cd'.repeat(32)}`, settings: { delta: 1, rpcHost: 'x.example.org' } }));
    expect(verdict).toMatchObject({ state: 'mismatch', differs: ['code', 'release time', 'public record connection'] });
    expect(words(verdict).lede).toContain('code, release time and public record connection.');
    expect(words(verdict).details).toContain('image_digest');
  });

  it('never passes a machine started for debugging, on this exam or another', async () => {
    const debug = { claims: { dbgstat: 'enabled' } };
    expect(await judge(await machine.started(exam, debug))).toMatchObject({ state: 'mismatch', differs: ['machine protection'] });
    expect(await judge(await machine.started(chainExam(otherExam), debug))).toMatchObject({ state: 'not-attested' });
  });

  it('does not pass a machine whose keys are not bound to the exam', async () => {
    expect(await judge(await machine.started(exam, { wrongInstanceKey: true }))).toMatchObject({ state: 'mismatch', differs: ['machine identity'] });
  });

  it('shows a machine with no token as not attested', async () => {
    const verdict = await judge({ ...(await machine.started(exam)), token: '', attested: false });
    expect(verdict).toMatchObject({ state: 'not-attested' });
    expect(words(verdict).details).toContain('Not attested');
    expect(words(verdict).lede).not.toContain('published code and settings');
  });

  it('ignores the attested flag: only the token counts', async () => {
    expect(await judge({ ...(await machine.started(exam)), token: 'not-a-token', attested: true })).toMatchObject({ state: 'not-attested' });
  });

  it('believes nothing in a token that does not verify, not even the exam it names', async () => {
    const real = await machine.started(exam);
    const [header, body, signature] = real.token.split('.') as [string, string, string];
    expect(await judge({ ...real, token: `${header}.${body}.${signature.slice(4)}AAAA` })).toMatchObject({ state: 'not-attested' });
    vi.stubEnv('VITE_MOCK_TRUST_ROOT', '');
    expect(await judge(real)).toMatchObject({ state: 'not-attested' });
    expect(await judge(await machine.started(chainExam(otherExam)))).toMatchObject({ state: 'not-attested' });
  });

  it('cannot check an out-of-date token yet', async () => {
    const read = answered(await machine.started(exam));
    const later = () => Math.floor(Date.now() / 1000) + 7200;
    expect(await judgeMachine(read, { examId: thisExam, exam, registry: REGISTRY, storageBucket: BUCKET, now: later })).toMatchObject({ state: 'cant-check' });
  });

  it('does not blame the machine when this page has no bucket set', async () => {
    expect(await judge(await machine.started(exam), '')).toMatchObject({ state: 'cant-check' });
  });

  it('has nothing to compare without an answer', async () => {
    const input = { examId: thisExam, exam, registry: REGISTRY };
    expect(await judgeMachine({ state: 'unreachable', detail: 'down' }, input)).toEqual({ state: 'unreachable', detail: 'down' });
    expect(await judgeMachine({ state: 'unconnected' }, input)).toMatchObject({ state: 'cant-check' });
  });
});

describe('readMachine', () => {
  const failing = { attestation: () => Promise.reject(new Error('down')) };

  it('is out of reach when the machine fails or hangs, and never hangs itself', async () => {
    expect(await readMachine(failing)).toEqual({ state: 'unreachable', detail: 'down' });
    const hung = { attestation: () => new Promise<never>(() => undefined) };
    expect(await readMachine(hung, null, 5)).toMatchObject({ state: 'unreachable' });
  });

  it('keeps a good answer through one failed read, not two', async () => {
    const good = answered(await machine.started(exam));
    const once = await readMachine(failing, good);
    expect(once).toEqual({ ...good, misses: 1 });
    expect(await readMachine(failing, once)).toMatchObject({ state: 'unreachable' });
  });

  it('has nothing to read without a machine', async () => {
    expect(await readMachine(null)).toEqual({ state: 'unconnected' });
  });
});

describe('machineState', () => {
  it('shows a finished exam as finished, whatever the machine says', () => {
    const after = Date.now() + 2 * 86_400_000;
    for (const verdict of [{ state: 'other', examId: otherExam }, { state: 'unreachable', detail: 'down' }, { state: 'ready' }, null] as const) {
      expect(machineState(verdict, exam, after)).toEqual({ state: 'finished' });
    }
    expect(words({ state: 'finished' }).title).toBe('Exam finished, the machine is no longer needed');
  });

  it('shows the verdict before then, and checking until there is one', () => {
    expect(machineState({ state: 'ready' }, exam, Date.now())).toEqual({ state: 'ready' });
    expect(machineState(null, exam, Date.now())).toEqual({ state: 'checking' });
  });

  it('offers Try again wherever the answer can change, and nowhere it cannot', () => {
    for (const state of ['other', 'mismatch', 'not-attested', 'unreachable', 'cant-check'] as const) {
      expect(words({ state, examId: otherExam, differs: ['code'], detail: 'x' } as MachineState).retry).toBe(true);
    }
    for (const state of ['ready', 'finished', 'checking'] as const) expect(words({ state }).retry).toBe(false);
  });
});
