// @vitest-environment jsdom
import type { Hex } from '@paperseal/protocol';
import type { AttestationResponse, TeeClient } from '@paperseal/tee-client';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import BoardArea from './BoardArea';
import { rememberExam } from './examsStore';
import type { Snapshot } from './examState';
import { useRowReads } from './homeReads';
import { chainExam, examIdOf, REGISTRY, testMachine } from './machineTestkit';
import type { ChainExam } from './machineVerdict';
import type { PublishEnvironment } from './publishFlow';

vi.mock('../../shared/config', async (original) => ({ ...(await original<object>()), teeStorageBucket: 'exam-bucket' }));

const runningId = examIdOf(0x11);
const waitingId = examIdOf(0x22);
const finishedId = examIdOf(0x33);
const running = chainExam(runningId);
const waiting = chainExam(waitingId);
const finished = chainExam(finishedId, -30 * 86_400);
const onChain = new Map<Hex, ChainExam>([
  [runningId, running],
  [waitingId, waiting],
  [finishedId, finished],
]);

const registry = {
  address: REGISTRY,
  getExam: (id: Hex) => Promise.resolve(onChain.get(id) ?? null),
  getCriteria: () => Promise.resolve(null),
  getApprovedList: () => Promise.resolve({ listHash: `0x${'11'.repeat(32)}`, postedAt: 1n, postedBlock: 1n }),
  getApprovedListEntries: () => Promise.resolve(null),
  getBuild: () => {
    const hash = `0x${'22'.repeat(32)}`;
    return Promise.resolve({ buildHash: hash, paperHash: hash, storageManifestHash: hash, instancePublicKey: hash });
  },
};
const environment = { createRegistry: () => registry } as unknown as PublishEnvironment;

function teeWith(attestation: () => Promise<AttestationResponse>) {
  return {
    attestation: vi.fn(attestation),
    status: () => Promise.resolve({ stage: 'onboard', questionCount: 0, release: { released: [], required: 8 } }),
    outbox: () => Promise.resolve({ messages: [] }),
  };
}

const show = (path: string, tee: unknown) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/board/*" element={<BoardArea environment={environment} tee={tee as TeeClient} />} />
      </Routes>
    </MemoryRouter>,
  );

let machine: Awaited<ReturnType<typeof testMachine>>;
beforeAll(async () => {
  machine = await testMachine();
});
afterAll(() => {
  machine.stop();
});
beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('MODE', 'mock');
  vi.stubEnv('VITE_MOCK_TRUST_ROOT', machine.rootBase64);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const panel = () => screen.findByRole('region', { name: 'The machine for this exam' });
const page = (id: Hex) => `/board/exam/${id}`;

describe('the exam page', () => {
  it('reads Ready for the exam the machine runs', async () => {
    const answer = await machine.started(running);
    show(page(runningId), teeWith(() => Promise.resolve(answer)));
    const found = within(await panel());
    expect(await found.findByText('Ready')).toBeTruthy();
    expect(found.getByText('The machine is running this exam, with the published code and settings.')).toBeTruthy();
    expect(found.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says which exam the machine is running instead, by the name this browser knows', async () => {
    rememberExam({ id: runningId, name: 'Biology 2026' });
    const answer = await machine.started(running);
    show(page(waitingId), teeWith(() => Promise.resolve(answer)));
    const found = within(await panel());
    expect(await found.findByText('Running another exam')).toBeTruthy();
    expect(found.getByText(/The machine is running Biology 2026/)).toBeTruthy();
  });

  it('falls back to a short ID for an exam this browser does not know', async () => {
    const answer = await machine.started(running);
    show(page(waitingId), teeWith(() => Promise.resolve(answer)));
    expect(await within(await panel()).findByText(/The machine is running exam 11111111/)).toBeTruthy();
  });

  it('says which setting differs, and folds the evidence', async () => {
    const answer = await machine.started(running, { settings: { rpcHost: 'other.example.org' } });
    show(page(runningId), teeWith(() => Promise.resolve(answer)));
    const found = within(await panel());
    expect(await found.findByText("Settings don't match")).toBeTruthy();
    expect(found.getByText(/differ from what was published: public record connection/)).toBeTruthy();
    expect(found.getByText('Details')).toBeTruthy();
  });

  it('shows a machine that cannot prove itself as not confirmed, never ready', async () => {
    const answer = { ...(await machine.started(running)), token: '', attested: false };
    show(page(runningId), teeWith(() => Promise.resolve(answer)));
    const found = within(await panel());
    expect(await found.findByText('Machine not confirmed')).toBeTruthy();
    expect(found.queryByText('Ready')).toBeNull();
  });

  it('says it cannot reach the machine, and Try again asks at once', async () => {
    const answer = await machine.started(running);
    let up = false;
    const tee = teeWith(() => (up ? Promise.resolve(answer) : Promise.reject(new Error('down'))));
    show(page(runningId), tee);
    const found = within(await panel());
    expect(await found.findByText("Can't reach the machine")).toBeTruthy();
    up = true;
    fireEvent.click(found.getByRole('button', { name: 'Try again' }));
    expect(await found.findByText('Ready')).toBeTruthy();
    expect(tee.attestation).toHaveBeenCalledTimes(2);
  });

  it('never holds the page up: a hung machine leaves the exam showing and says it is checking', async () => {
    show(page(runningId), teeWith(() => new Promise<never>(() => undefined)));
    expect(await within(await panel()).findByText('Checking the machine')).toBeTruthy();
    expect(screen.getAllByText(/Nothing to do until/).length).toBeGreaterThan(0);
  });

  it('shows a finished exam as finished without asking the machine', async () => {
    const tee = teeWith(() => Promise.reject(new Error('moved on')));
    show(page(finishedId), tee);
    expect(await within(await panel()).findByText('Exam finished, the machine is no longer needed')).toBeTruthy();
    expect(tee.attestation).not.toHaveBeenCalled();
  });
});

describe('the board home', () => {
  const rowOf = async (name: string) => {
    const open = await screen.findByRole('button', { name: `Open ${name}` });
    const row = open.closest('li');
    if (!row) throw new Error('no row');
    return within(row);
  };

  it('shows the short state on each row from one shared read', async () => {
    rememberExam({ id: runningId, name: 'Running' });
    rememberExam({ id: waitingId, name: 'Waiting' });
    rememberExam({ id: finishedId, name: 'Finished' });
    const answer = await machine.started(running);
    const tee = teeWith(() => Promise.resolve(answer));
    show('/board', tee);
    expect(await (await rowOf('Running')).findByText('Machine ready')).toBeTruthy();
    expect(await (await rowOf('Waiting')).findByText('Running another exam')).toBeTruthy();
    expect(await (await rowOf('Finished')).findByText('Machine not needed')).toBeTruthy();
    expect(tee.attestation).toHaveBeenCalledTimes(1);
  });

  it('marks the rows when the machine is down, and leaves a finished exam alone', async () => {
    rememberExam({ id: runningId, name: 'Running' });
    rememberExam({ id: finishedId, name: 'Finished' });
    show('/board', teeWith(() => Promise.reject(new Error('down'))));
    expect(await (await rowOf('Running')).findByText("Can't reach machine")).toBeTruthy();
    expect(await (await rowOf('Finished')).findByText('Machine not needed')).toBeTruthy();
  });

  it('does not ask the machine when every exam has finished', async () => {
    rememberExam({ id: finishedId, name: 'Finished' });
    const tee = teeWith(() => Promise.reject(new Error('moved on')));
    show('/board', tee);
    expect(await (await rowOf('Finished')).findByText('Machine not needed')).toBeTruthy();
    expect(tee.attestation).not.toHaveBeenCalled();
  });
});

describe('useRowReads', () => {
  it('keeps polling past a read that hangs, and the hung row counts as failed', async () => {
    const hung = examIdOf(0x44);
    const fine = examIdOf(0x55);
    const snapshot = { found: null } as unknown as Snapshot;
    let fineReads = 0;
    const load = (id: Hex) => {
      if (id === hung) return new Promise<Snapshot>(() => undefined);
      fineReads += 1;
      return Promise.resolve(snapshot);
    };
    const { result } = renderHook(() => useRowReads([hung, fine], load, 1, 1, 20));
    await waitFor(() => {
      expect(result.current.get(hung)).toEqual({ state: 'failed' });
    });
    await waitFor(() => {
      expect(fineReads).toBeGreaterThan(1);
    });
    await act(() => Promise.resolve());
  });
});
