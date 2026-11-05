// @vitest-environment jsdom
import { createExamRegistry, examRegistryAbi } from '@paperseal/chain';
import { criteriaHash, encodeCriteria, examIdFromName, firstRoundAtOrAfter, toHex } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createPublicClient, decodeFunctionData, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCurrentExamId } from '../../shared/currentExam';
import { fakeChain, type FakeChainOptions } from '../../test/fakeChain';
import { parseLocalTime } from './form';
import BoardArea from './BoardArea';
import { explainError, publishExam, PublishBlockedError, type PublishEnvironment, type PublishRequest } from './publishFlow';

const board = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const stranger = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' as Address;
const name = 'Physics 2027';
const examId = examIdFromName(name);
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);

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

/** Local `YYYY-MM-DD HH:mm`, `days` from now. */
function local(days: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:${pad(minute)}`;
}

const times = { examStart: local(30, 9, 30), delta: '30', lock: local(29, 12), end: local(30, 12, 30) };

function request(): PublishRequest {
  const criteria = { maxSetterPercent: 20, minBankMultiple: 4, topics: [{ name: 'Mechanics', questions: 5 }] };
  const encoded = encodeCriteria(criteria);
  const start = parseLocalTime(times.examStart) ?? 0;
  return {
    examId,
    fields: { commitHash: `0x${commit}`, imageDigest: `0x${digest}`, rpcHost: 'rpc.example.org' },
    schedule: {
      examStart: start,
      delta: 1800,
      lockRound: String(firstRoundAtOrAfter(parseLocalTime(times.lock) ?? 0)),
      unlockRound: String(firstRoundAtOrAfter(start - 1800)),
      endRound: String(firstRoundAtOrAfter(parseLocalTime(times.end) ?? 0)),
    },
    criteria: { encoded: toHex(encoded), hash: toHex(criteriaHash(encoded)) },
  };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe('publishExam with a stub wallet', () => {
  it('sends createExam from the board, then reads back a matching exam', async () => {
    const { node, env } = environment();
    const req = request();
    const stages: string[] = [];
    const outcome = await publishExam(env, req, (stage) => stages.push(stage), { wait: () => Promise.resolve() });

    expect(stages).toEqual(['checking', 'simulating', 'wallet', 'mining', 'reading']);
    expect(node.sent).toHaveLength(1);
    const tx = node.sent[0]?.params as [{ from: string; to: string; data: Hex }];
    expect(tx[0].from.toLowerCase()).toBe(board);
    expect(tx[0].to.toLowerCase()).toBe(node.registry);
    const call = decodeFunctionData({ abi: examRegistryAbi, data: tx[0].data });
    expect(call.functionName).toBe('createExam');
    const [commitHash, imageDigest, settings, criteria] = call.args as unknown as [Hex, Hex, Record<string, unknown>, Hex];
    expect(commitHash).toBe(`0x${commit}`);
    expect(imageDigest).toBe(`0x${digest}`);
    expect(settings).toMatchObject({
      examId,
      examStart: BigInt(req.schedule.examStart),
      delta: 1800n,
      unlockRound: BigInt(req.schedule.unlockRound),
      criteriaHash: req.criteria.hash,
      rpcHost: 'rpc.example.org',
    });
    expect(criteria).toBe(req.criteria.encoded);

    expect(outcome.matches).toBe(true);
    expect(outcome.rows.every((row) => row.match)).toBe(true);
    expect(outcome.criteria?.topics).toEqual([{ name: 'Mechanics', questions: 5 }]);
  });

  it('reports a read-back that differs from what was entered', async () => {
    const { env } = environment({ tamper: () => ({ rpcHost: 'evil.example.org' }) });
    const outcome = await publishExam(env, request(), undefined, { wait: () => Promise.resolve() });
    expect(outcome.matches).toBe(false);
    expect(outcome.rows.find((row) => row.label === 'RPC operator host')).toMatchObject({
      match: false,
      actual: 'evil.example.org',
    });
  });

  it('sends nothing from an account that is not the board', async () => {
    const { node, env } = environment({ account: stranger });
    await expect(publishExam(env, request())).rejects.toThrow(/not the board address/);
    expect(node.sent).toHaveLength(0);
  });

  it('sends nothing on the wrong chain', async () => {
    const { node, env } = environment({ chainId: 1 });
    await expect(publishExam(env, request())).rejects.toThrow(/Switch it to Sepolia/);
    expect(node.sent).toHaveLength(0);
  });

  it('sends nothing when no account is connected, or no wallet exists', async () => {
    const { node, env } = environment({ account: null });
    await expect(publishExam(env, request())).rejects.toThrow(/Connect your wallet/);
    await expect(publishExam({ ...env, getProvider: () => null }, request())).rejects.toThrow(/No browser wallet/);
    expect(node.sent).toHaveLength(0);
  });

  it('refuses an exam name that is already published', async () => {
    const { node, env } = environment();
    await publishExam(env, request(), undefined, { wait: () => Promise.resolve() });
    await expect(publishExam(env, request())).rejects.toThrow(/already published/);
    expect(node.sent).toHaveLength(1);
  });

  it('explains a revert in plain words before the wallet is asked', async () => {
    const { node, env } = environment({ revertWith: { errorName: 'UnlockRoundMismatch', args: [10n, 11n] } });
    const error = await publishExam(env, request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublishBlockedError);
    expect((error as Error).message).toBe(
      'The unlock round must be 10, the first round at or after T − Δ, but 11 was sent.',
    );
    expect(node.sent).toHaveLength(0);
  });

  it('says plainly when the wallet user rejects', async () => {
    const { env } = environment({ rejectSend: true });
    await expect(publishExam(env, request())).rejects.toThrow('You rejected the request in your wallet. Nothing was sent.');
  });

  it('explains plain errors without hiding them', () => {
    expect(explainError(new Error('boom'))).toBe('boom');
  });
});

function renderBoard(env: PublishEnvironment, path = '/board/blueprint') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/board/*" element={<BoardArea environment={env} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A field's label also holds its hint and error, so match the start. */
const field = (label: string) =>
  screen.getByLabelText(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
const type = (label: string, value: string) => {
  fireEvent.change(field(label), { target: { value } });
};
const go = (label: string) => {
  fireEvent.click(within(screen.getByRole('navigation')).getByText(label));
};

describe('board screens', () => {
  it('shows selectedCount and criteriaHash live and flags rule breaks', () => {
    const { env } = environment();
    renderBoard(env);
    type('Exam name', name);
    type('Topic 1 name', 'Mechanics');
    type('Topic 1 questions', '5');
    type('maxSetterPercent', '20');
    type('minBankMultiple', '4');
    const hash = toHex(
      criteriaHash(encodeCriteria({ maxSetterPercent: 20, minBankMultiple: 4, topics: [{ name: 'Mechanics', questions: 5 }] })),
    );
    expect(screen.getByText(hash)).toBeTruthy();
    expect(screen.getByText('Criteria accepted')).toBeTruthy();
    expect(screen.getByText(examId)).toBeTruthy();

    fireEvent.click(screen.getByText('Add topic'));
    type('Topic 2 name', 'Mechanics');
    type('Topic 2 questions', '3');
    expect(screen.getByText('Topic names must be unique.')).toBeTruthy();
    expect(screen.queryByText('Criteria accepted')).toBeNull();

    type('Topic 2 name', 'Optics');
    expect(screen.getByText('Criteria accepted')).toBeTruthy();
    expect(field('Topic 2 name')).toBeTruthy();
    type('maxSetterPercent', '101');
    expect(screen.getByText('Max setter percent must be from 1 to 100.')).toBeTruthy();
  });

  it('shows rounds next to clock times and says they are final', () => {
    const { env } = environment();
    renderBoard(env, '/board/schedule');
    type('Exam start, T', times.examStart);
    type('Δ, minutes before T that the paper unlocks', times.delta);
    type('Lock time', times.lock);
    type('End time', times.end);
    const unlock = firstRoundAtOrAfter((parseLocalTime(times.examStart) ?? 0) - 1800);
    expect(screen.getByText(`round ${String(unlock)}`)).toBeTruthy();
    expect(screen.getByText('Schedule accepted')).toBeTruthy();
    expect(screen.getByText(/cannot be changed afterwards/)).toBeTruthy();

    type('Lock time', times.end);
    expect(screen.getByText(/lock time must come before/)).toBeTruthy();
  });

  it('publishes from the summary, reads back, and points the overview at the new exam', async () => {
    const { node, env } = environment();
    renderBoard(env);
    type('Exam name', name);
    type('Topic 1 name', 'Mechanics');
    type('Topic 1 questions', '5');
    type('maxSetterPercent', '20');
    type('minBankMultiple', '4');
    go('Schedule');
    type('Exam start, T', times.examStart);
    type('Δ, minutes before T that the paper unlocks', times.delta);
    type('Lock time', times.lock);
    type('End time', times.end);
    go('Publish');

    // The form survived the move between screens.
    expect(screen.queryByText('Complete the blueprint')).toBeNull();
    const confirm = screen.getByText('Confirm and publish') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type('Commit hash', commit);
    type('Image digest', `sha256:${digest}`);
    type('RPC operator host', 'rpc.example.org');
    expect(screen.getByText('What will be written to ExamRegistry')).toBeTruthy();
    expect(screen.getByText(/cannot be changed afterwards, not even by the board/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByText(board).length).toBeGreaterThan(0);
    });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.getByText('Published and verified')).toBeTruthy();
    });
    expect(node.sent).toHaveLength(1);
    expect(getCurrentExamId()).toBe(examId);
    expect((screen.getByText('Confirm and publish') as HTMLButtonElement).disabled).toBe(true);

    // The overview now reads the new exam from the registry, with no rebuild.
    go('Overview');
    await waitFor(() => {
      expect(screen.getByText('Topic: Mechanics')).toBeTruthy();
      expect(screen.getByText(examId)).toBeTruthy();
    });
  });

  it('keeps the confirm button disabled and shows the wrong-chain problem', async () => {
    const { node, env } = environment({ chainId: 1 });
    renderBoard(env, '/board/publish');
    await waitFor(() => {
      expect(screen.getByText('Chain 1, not Sepolia')).toBeTruthy();
    });
    expect((screen.getByText('Confirm and publish') as HTMLButtonElement).disabled).toBe(true);
    expect(node.sent).toHaveLength(0);
  });
});
