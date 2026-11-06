// @vitest-environment jsdom
import { createExamRegistry, examRegistryAbi } from '@paperseal/chain';
import { criteriaHash, encodeCriteria, examIdFromName, firstRoundAtOrAfter, toHex } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createPublicClient, decodeFunctionData, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentExamId } from '../../shared/currentExam';
import { fakeChain, type FakeChainOptions } from '../../test/fakeChain';
import { parseLocalTime } from './form';
import BoardArea from './BoardArea';
import { explainError, publishExam, PublishBlockedError, type PublishEnvironment, type PublishRequest } from './publishFlow';

const board = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const stranger = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' as Address;
const name = 'physics-2027';
const examId = examIdFromName(name);
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const run = 'https://github.com/AbdulRashidReshamwala/paperseal/actions/runs/1';

const releaseItem = (tag: string, published: string, commitHex = commit) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: published,
  body: `\`\`\`json\n${JSON.stringify({ version: tag, commit: `0x${commitHex}`, imageDigest: `0x${digest}`, run })}\n\`\`\``,
});

interface GithubOptions {
  releases?: unknown;
  /** Status for the releases listing. */
  releasesStatus?: number;
  /** What `/commits/<tag>` answers with, per tag. Defaults to the release commit. */
  tagSha?: Record<string, string>;
  tagStatus?: number;
}

/** Stubs fetch for the GitHub API; the chain stub does not use fetch. */
function stubGithub(options: GithubOptions = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
      if (url.includes('/releases')) {
        return json(options.releases ?? [releaseItem('v1.0.0', '2027-01-01T00:00:00Z')], options.releasesStatus ?? 200);
      }
      const tag = decodeURIComponent(url.split('/commits/')[1] ?? '');
      return json({ sha: options.tagSha?.[tag] ?? commit }, options.tagStatus ?? 200);
    }),
  );
  return calls;
}

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
const picker = (text: string) => text.replace(' ', 'T');

function request(): PublishRequest {
  const criteria = { maxSetterPercent: 20, minBankMultiple: 4, topics: [{ name: 'Mechanics', questions: 5 }] };
  const encoded = encodeCriteria(criteria);
  const start = parseLocalTime(times.examStart) ?? 0;
  return {
    examId,
    fields: { commitHash: `0x${commit}`, imageDigest: `0x${digest}`, rpcHost: 'rpc.example.org', version: 'v1.0.0', run },
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
  stubGithub();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

function renderBoard(env: PublishEnvironment, path = '/board') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/board/*" element={<BoardArea environment={env} tee={null} />} />
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
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });

/** The whole of Step 1, using the defaults for everything hidden under Advanced except the host. */
function fillCreate(host: string | null = 'rpc.example.org') {
  type('Exam name', name);
  type('Date and time of the exam', picker(times.examStart));
  type('Length, in minutes', '180');
  type('Minutes before the exam', times.delta);
  type('Topic 1 name', 'Mechanics');
  type('Topic 1 questions', '5');
  type('Questions close', picker(times.lock));
  if (host !== null) type('Public record provider', host);
}

async function toVersion(env: PublishEnvironment) {
  renderBoard(env);
  fillCreate();
  fireEvent.click(button('Continue'));
  await screen.findByText('Choose what the sealed machine runs');
}

async function toReview(env: PublishEnvironment) {
  await toVersion(env);
  fireEvent.click(await screen.findByRole('button', { name: /^Use v/ }));
  await screen.findByText('Review and publish');
  return button('Publish the exam');
}

describe('step 1, create the exam', () => {
  it('holds Continue until the page is complete, and needs no technical input', () => {
    const { env } = environment();
    renderBoard(env);
    expect(screen.getByText('Create the exam')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(button('Continue').disabled).toBe(true);
    expect(screen.getByText(/Still needed: the exam name, the date and time, the topics/)).toBeTruthy();
    fillCreate();
    expect(button('Continue').disabled).toBe(false);
  });

  it('keeps the rules of form.ts, and opens Advanced when something in it is wrong', () => {
    const { env } = environment();
    renderBoard(env);
    fillCreate();
    fireEvent.click(screen.getByText('Add topic'));
    type('Topic 2 name', 'Mechanics');
    type('Topic 2 questions', '3');
    expect(screen.getByText('Topic names must be unique.')).toBeTruthy();
    expect(button('Continue').disabled).toBe(true);

    type('Topic 2 name', 'Optics');
    expect(button('Continue').disabled).toBe(false);
    type('Most of a topic one setter can write', '101');
    expect(screen.getByText('Max setter percent must be from 1 to 100.')).toBeTruthy();
    expect(button('Continue').disabled).toBe(true);
    expect(screen.getByText('Advanced').closest('details')?.open).toBe(true);
  });

  it('refuses a name that is not one ENS label, and says what it should be, without changing it', () => {
    const { env } = environment();
    renderBoard(env);
    fillCreate();
    expect(screen.getByText(/It becomes the exam's ENS name/)).toBeTruthy();
    type('Exam name', 'JEE-Main-2026');
    expect(screen.getByText('The exam name must already be in normalised form. Did you mean jee-main-2026?')).toBeTruthy();
    expect((field('Exam name') as HTMLInputElement).value).toBe('JEE-Main-2026');
    expect(button('Continue').disabled).toBe(true);
    type('Exam name', 'jee-main-2026');
    expect(button('Continue').disabled).toBe(false);
  });

  it('refuses a lock after the release, in plain words', () => {
    const { env } = environment();
    renderBoard(env);
    fillCreate();
    type('Questions close', picker(times.end));
    expect(screen.getByText('Questions must close before the paper is released to centres.')).toBeTruthy();
    expect(button('Continue').disabled).toBe(true);
  });

  it('works out when questions close, and shows no rounds', () => {
    const { env } = environment();
    renderBoard(env);
    type('Exam name', name);
    type('Date and time of the exam', picker(times.examStart));
    type('Topic 1 name', 'Mechanics');
    type('Topic 1 questions', '5');
    expect(screen.getByText(/^Questions close /)).toBeTruthy();
    expect(screen.getByText(/at least 20 questions from at least 5 setters/)).toBeTruthy();
    expect(screen.queryByText(/round/i)).toBeNull();
  });

  it('asks for the host when none can be worked out', () => {
    const { env } = environment();
    renderBoard(env);
    fillCreate(null);
    expect(button('Continue').disabled).toBe(true);
    expect(screen.getByText('Advanced').closest('details')?.open).toBe(true);
    type('Public record provider', 'https://not-a-host/');
    expect(screen.getByText(/Enter the hostname only/)).toBeTruthy();
  });
});

describe('step 2, the version', () => {
  it('preselects the newest verified release, so it is one click', async () => {
    stubGithub({
      releases: [releaseItem('v1.0.0', '2027-01-01T00:00:00Z'), releaseItem('v1.1.0', '2027-02-01T00:00:00Z')],
    });
    const { env } = environment();
    await toVersion(env);
    expect(await screen.findByRole('button', { name: 'Use v1.1.0' })).toBeTruthy();
    expect(screen.getByText(/v1\.1\.0 is the newest published version/)).toBeTruthy();
    fireEvent.click(button('Use v1.1.0'));
    expect(await screen.findByText('Review and publish')).toBeTruthy();
  });

  it('skips a newest release whose tag points elsewhere, and says so', async () => {
    stubGithub({
      releases: [releaseItem('v1.0.0', '2027-01-01T00:00:00Z'), releaseItem('v1.1.0', '2027-02-01T00:00:00Z')],
      tagSha: { 'v1.1.0': 'c'.repeat(40) },
    });
    const { env } = environment();
    await toVersion(env);
    expect(await screen.findByRole('button', { name: 'Use v1.0.0' })).toBeTruthy();
    expect(screen.getByText(/Release mismatch: the tag v1\.1\.0 points at commit/)).toBeTruthy();
  });

  it('blocks when no release matches its tag', async () => {
    stubGithub({ tagSha: { 'v1.0.0': 'c'.repeat(40) } });
    const { node, env } = environment();
    await toVersion(env);
    await screen.findByText(/Release mismatch/);
    expect(screen.getByText(/Publishing is blocked/)).toBeTruthy();
    expect(button('Use this version').disabled).toBe(true);
    expect(node.sent).toHaveLength(0);
  });

  it('blocks a chosen version that does not check out', async () => {
    stubGithub({
      releases: [releaseItem('v1.0.0', '2027-01-01T00:00:00Z'), releaseItem('v1.1.0', '2027-02-01T00:00:00Z')],
      tagSha: { 'v1.0.0': 'c'.repeat(40) },
    });
    const { env } = environment();
    await toVersion(env);
    await screen.findByRole('button', { name: 'Use v1.1.0' });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v1.0.0' } });
    await screen.findByText(/Release mismatch: the tag v1\.0\.0/);
    expect(button('Use this version').disabled).toBe(true);
  });

  it('blocks when the tag cannot be checked', async () => {
    stubGithub({ tagStatus: 500 });
    const { env } = environment();
    await toVersion(env);
    await screen.findByText(/GitHub could not be reached/);
    expect(button('Use this version').disabled).toBe(true);
  });

  it('says plainly when GitHub is limiting, with retry and no manual entry', async () => {
    stubGithub({ releasesStatus: 403 });
    const { env } = environment();
    await toVersion(env);
    await screen.findByText(/GitHub is limiting requests/);
    expect(screen.queryByLabelText(/^Commit/)).toBeNull();
    expect(screen.queryByLabelText(/^Image digest/)).toBeNull();
    expect(button('Use this version').disabled).toBe(true);

    stubGithub();
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByRole('button', { name: 'Use v1.0.0' })).toBeTruthy();
  });

  it('shows a loading state, and explains that a version must be tagged when there are none', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const { env: pending } = environment();
    await toVersion(pending);
    expect(screen.getByText(/Loading the published versions/)).toBeTruthy();
    expect(button('Use this version').disabled).toBe(true);
    cleanup();

    stubGithub({ releases: [] });
    const { env } = environment();
    await toVersion(env);
    await screen.findByText(/A version must be tagged first/);
    expect(button('Use this version').disabled).toBe(true);
  });

  it('does not link a build run that is not an Actions run of the releases repository', async () => {
    const foreign = 'https://evil.example/AbdulRashidReshamwala/paperseal/actions/runs/1';
    const item = releaseItem('v1.0.0', '2027-01-01T00:00:00Z');
    stubGithub({ releases: [{ ...item, body: item.body.replace(run, foreign) }] });
    const { env } = environment();
    await toVersion(env);
    expect((await screen.findByText(foreign)).closest('a')).toBeNull();
    expect(screen.getByText(/Not a workflow run of/)).toBeTruthy();
  });
});

describe('step 3, review and publish', () => {
  it('publishes with one action, reads back, stamps it, and moves on to people', async () => {
    const { node, env } = environment();
    const publish = await toReview(env);
    expect(screen.getByText(/cannot be changed afterwards, not even by the board/)).toBeTruthy();
    expect(screen.getByText('Topic: Mechanics')).toBeTruthy();
    fireEvent.click(publish);

    expect(await screen.findByText('The exam is published')).toBeTruthy();
    expect(screen.getByText('Published')).toBeTruthy();
    expect(node.sent).toHaveLength(1);
    expect(getCurrentExamId()).toBe(examId);

    fireEvent.click(button('Bring people in'));
    expect(await screen.findByRole('heading', { name: 'Bring people in' })).toBeTruthy();
  });

  it('asks the wallet for an account as part of the same action', async () => {
    const { node, env } = environment();
    let shared = false;
    const provider = {
      request: ((args: { method: string }) => {
        if (args.method === 'eth_accounts' && !shared) return Promise.resolve([]);
        if (args.method === 'eth_requestAccounts') shared = true;
        return (node.provider.request as (input: unknown) => Promise<unknown>)(args);
      }) as typeof node.provider.request,
    } as typeof node.provider;
    const publish = await toReview({ ...env, getProvider: () => provider });
    fireEvent.click(publish);
    await screen.findByText('The exam is published');
    expect(shared).toBe(true);
  });

  it('leaves the exam pointer alone when the read-back differs, and shows no stamp', async () => {
    const { env } = environment({ tamper: () => ({ rpcHost: 'evil.example.org' }) });
    const publish = await toReview(env);
    expect(getCurrentExamId()).toBeNull();
    fireEvent.click(publish);
    expect(await screen.findByText('Published, but the read-back differs')).toBeTruthy();
    expect(screen.queryByText('Published')).toBeNull();
    expect(screen.getByText(/this exam was not selected/)).toBeTruthy();
    expect(getCurrentExamId()).toBeNull();
  });

  it('warns about the wrong chain, and the flow still refuses to send', async () => {
    const { node, env } = environment({ chainId: 1 });
    const publish = await toReview(env);
    await screen.findByText(/Your wallet is on chain 1\. Switch it to Sepolia/);
    fireEvent.click(publish);
    await screen.findByText(/Your wallet is on chain 1\. Switch it to Sepolia \(chain/);
    expect(node.sent).toHaveLength(0);
  });

  it('refuses an account that is not the board', async () => {
    const { node, env } = environment({ account: stranger });
    const publish = await toReview(env);
    await screen.findByText(/This wallet account is not the board address/);
    fireEvent.click(publish);
    await screen.findByText(/is not the board address\. the public record only accepts writes|is not the board address\. The public record/i);
    expect(node.sent).toHaveLength(0);
  });

  it('goes back to the details without losing them', async () => {
    const { env } = environment();
    await toReview(env);
    fireEvent.click(button('Change the details'));
    expect((field('Exam name') as HTMLInputElement).value).toBe(name);
  });

  it('shows rounds and hashes only in the exam record', async () => {
    const { env } = environment();
    await toReview(env);
    const record = screen.getByText('Exam record').closest('details');
    expect(record?.open).toBe(false);
    expect(record?.textContent).toContain('Lock round');
    expect(screen.getByRole('main').textContent?.replace(record?.textContent ?? '', '')).not.toMatch(/round|0x/i);
    await waitFor(() => {
      expect(record?.textContent).toContain(examId.slice(0, 8));
    });
  });
});
