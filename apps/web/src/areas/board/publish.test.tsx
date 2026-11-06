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
import { splitDetails } from './details';
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
    await expect(publishExam(env, request())).rejects.toThrow(/not the exam board’s account/);
    expect(node.sent).toHaveLength(0);
  });

  it('sends nothing on the wrong chain', async () => {
    const { node, env } = environment({ chainId: 1 });
    await expect(publishExam(env, request())).rejects.toThrow(/wrong network. Switch it to Sepolia/);
    expect(node.sent).toHaveLength(0);
  });

  it('asks the wallet to switch to Sepolia, then carries on', async () => {
    const { node, env } = environment({ chainId: 1, switchable: true });
    const outcome = await publishExam(env, request(), undefined, { wait: () => Promise.resolve() });
    expect(outcome.matches).toBe(true);
    expect(node.sent.length).toBeGreaterThan(0);
  });

  it('shows the plain instruction when the wallet declines to switch', async () => {
    const { node, env } = environment({ chainId: 1, switchable: 'decline' });
    await expect(publishExam(env, request())).rejects.toThrow(/wrong network. Switch it to Sepolia/);
    expect(node.sent).toHaveLength(0);
  });

  it('sends nothing when no account is connected, or no wallet exists', async () => {
    const { node, env } = environment({ account: null });
    await expect(publishExam(env, request())).rejects.toThrow(/Connect your wallet/);
    await expect(publishExam({ ...env, getProvider: () => null }, request())).rejects.toThrow(/wallet was not found/);
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
    expect((error as Error).message).toBe('The release time was not accepted. Go back, check the times, then try again.');
    expect(node.sent).toHaveLength(0);
  });

  it('says plainly when the wallet user rejects', async () => {
    const { env } = environment({ rejectSend: true });
    await expect(publishExam(env, request())).rejects.toThrow('You declined in your wallet, so nothing was published.');
  });

  it('explains plain errors without hiding them', () => {
    expect(splitDetails(explainError(new Error('boom')))).toEqual({
      say: expect.stringContaining('Try again'),
      detail: 'boom',
    });
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
  if (host !== null) type('Public record address', host);
}

/** Step 1 done and the review open, before the version has been checked. */
async function toVersion(env: PublishEnvironment) {
  renderBoard(env);
  fillCreate();
  fireEvent.click(button('Continue'));
  await screen.findByText('Review and publish');
}

/** The review, once the newest version has been checked. */
async function toReview(env: PublishEnvironment) {
  await toVersion(env);
  await screen.findByText(/It has been checked/);
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
    expect(screen.getByText('Each topic needs its own name.')).toBeTruthy();
    expect(button('Continue').disabled).toBe(true);

    type('Topic 2 name', 'Optics');
    expect(button('Continue').disabled).toBe(false);
    type('Most of a topic one setter can write', '101');
    expect(screen.getByText('Enter a number from 1 to 100.')).toBeTruthy();
    expect(button('Continue').disabled).toBe(true);
    expect(screen.getByText('Advanced').closest('details')?.open).toBe(true);
  });

  it('refuses a name that is not one ENS label, and says what it should be, without changing it', () => {
    const { env } = environment();
    renderBoard(env);
    fillCreate();
    expect(screen.getByText(/This is also the start of the exam's ENS name/)).toBeTruthy();
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
    type('Public record address', 'https://not-a-host/');
    expect(screen.getByText(/Enter the address only/)).toBeTruthy();
  });
});

describe('the version, in the review', () => {
  it('chooses the newest verified release by itself, so there is nothing to click', async () => {
    stubGithub({
      releases: [releaseItem('v1.0.0', '2027-01-01T00:00:00Z'), releaseItem('v1.1.0', '2027-02-01T00:00:00Z')],
    });
    const { env } = environment();
    const publish = await toReview(env);
    expect(screen.getByText(/v1\.1\.0, the newest version/)).toBeTruthy();
    expect(screen.queryByText('Choose the Paper Seal version')).toBeNull();
    expect(publish.disabled).toBe(false);
  });

  it('folds the choice of another version into the review', async () => {
    stubGithub({
      releases: [releaseItem('v1.0.0', '2027-01-01T00:00:00Z'), releaseItem('v1.1.0', '2027-02-01T00:00:00Z')],
    });
    const { env } = environment();
    await toReview(env);
    expect(screen.getByText('Use a different version').closest('details')?.open).toBe(false);
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v1.0.0' } });
    await screen.findByText(/v1\.0\.0, the version you chose/);
  });

  it('skips a newest release whose tag points elsewhere, and says so', async () => {
    stubGithub({
      releases: [releaseItem('v1.0.0', '2027-01-01T00:00:00Z'), releaseItem('v1.1.0', '2027-02-01T00:00:00Z')],
      tagSha: { 'v1.1.0': 'c'.repeat(40) },
    });
    const { env } = environment();
    await toReview(env);
    expect(screen.getByText(/v1\.0\.0, the newest version/)).toBeTruthy();
    expect(screen.getByText(/Version v1\.1\.0 did not pass its check/)).toBeTruthy();
  });

  it('blocks publishing when no release matches its tag', async () => {
    stubGithub({ tagSha: { 'v1.0.0': 'c'.repeat(40) } });
    const { node, env } = environment();
    await toVersion(env);
    await screen.findByText(/did not pass its check/);
    expect(screen.getByText(/No version passed its check/)).toBeTruthy();
    expect(button('Publish the exam').disabled).toBe(true);
    expect(node.sent).toHaveLength(0);
  });

  it('blocks a chosen version that does not check out', async () => {
    stubGithub({
      releases: [releaseItem('v1.0.0', '2027-01-01T00:00:00Z'), releaseItem('v1.1.0', '2027-02-01T00:00:00Z')],
      tagSha: { 'v1.0.0': 'c'.repeat(40) },
    });
    const { env } = environment();
    await toReview(env);
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v1.0.0' } });
    await screen.findByText(/Version v1\.0\.0 did not pass its check/);
    expect(button('Publish the exam').disabled).toBe(true);
  });

  it('blocks publishing when the tag cannot be checked', async () => {
    stubGithub({ tagStatus: 500 });
    const { env } = environment();
    await toVersion(env);
    await screen.findByText(/versions could not be loaded\. Check your internet/);
    expect(button('Publish the exam').disabled).toBe(true);
  });

  it('says plainly when GitHub is limiting, with retry and no manual entry', async () => {
    stubGithub({ releasesStatus: 403 });
    const { env } = environment();
    await toVersion(env);
    await screen.findByText(/service is busy/);
    expect(screen.queryByLabelText(/^Commit/)).toBeNull();
    expect(screen.queryByLabelText(/^Image digest/)).toBeNull();
    expect(button('Publish the exam').disabled).toBe(true);

    stubGithub();
    fireEvent.click(screen.getByText('Try again'));
    await screen.findByText(/It has been checked/);
    expect(button('Publish the exam').disabled).toBe(false);
  });

  it('shows a loading state, and explains that a version must be tagged when there are none', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const { env: pending } = environment();
    await toVersion(pending);
    expect(screen.getByText(/Loading the available versions/)).toBeTruthy();
    expect(button('Publish the exam').disabled).toBe(true);
    cleanup();
    localStorage.clear();

    stubGithub({ releases: [] });
    const { env } = environment();
    await toVersion(env);
    await screen.findByText(/no version to use yet/);
    expect(button('Publish the exam').disabled).toBe(true);
  });

  it('does not link a build run that is not an Actions run of the releases repository', async () => {
    const foreign = 'https://evil.example/AbdulRashidReshamwala/paperseal/actions/runs/1';
    const item = releaseItem('v1.0.0', '2027-01-01T00:00:00Z');
    stubGithub({ releases: [{ ...item, body: item.body.replace(run, foreign) }] });
    const { env } = environment();
    await toVersion(env);
    expect((await screen.findByText(foreign)).closest('a')).toBeNull();
    expect(screen.getByText(/This is not a run of/)).toBeTruthy();
  });
});

describe('step 2, review and publish', () => {
  it('publishes with one action, reads back, and goes straight to inviting people', async () => {
    const { node, env } = environment();
    const publish = await toReview(env);
    expect(screen.getByText(/nothing here can be changed, not even by the exam board/)).toBeTruthy();
    expect(screen.getByText('Topic: Mechanics')).toBeTruthy();
    fireEvent.click(publish);

    expect(await screen.findByRole('heading', { name: 'Invite people' })).toBeTruthy();
    expect(screen.queryByText('The exam is published')).toBeNull();
    expect(screen.getByText('Published')).toBeTruthy();
    expect(node.sent).toHaveLength(1);
    expect(getCurrentExamId()).toBe(examId);
    // The draft is gone once it has become an exam.
    expect(localStorage.getItem('paperseal.board.draft')).toBeNull();
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
    await screen.findByRole('heading', { name: 'Invite people' });
    expect(shared).toBe(true);
  });

  it('leaves the exam pointer alone when the read-back differs, and shows no stamp', async () => {
    const { env } = environment({ tamper: () => ({ rpcHost: 'evil.example.org' }) });
    const publish = await toReview(env);
    expect(getCurrentExamId()).toBeNull();
    fireEvent.click(publish);
    expect(await screen.findByText('The exam was published, but it does not match')).toBeTruthy();
    expect(screen.queryByText('Published')).toBeNull();
    expect(screen.getByText(/Do not use this exam/)).toBeTruthy();
    expect(getCurrentExamId()).toBeNull();
  });

  it('warns about the wrong chain, and the flow still refuses to send', async () => {
    const { node, env } = environment({ chainId: 1 });
    const publish = await toReview(env);
    await screen.findByText(/Your wallet is on the wrong network/);
    fireEvent.click(publish);
    await screen.findAllByText(/Your wallet is on the wrong network\. Switch it to Sepolia in your wallet, then try again/);
    expect(node.sent).toHaveLength(0);
  });

  it('refuses an account that is not the board', async () => {
    const { node, env } = environment({ account: stranger });
    const publish = await toReview(env);
    await screen.findByText(/not the exam board’s account/);
    fireEvent.click(publish);
    await screen.findAllByText(/Switch to the board’s account in your wallet/);
    expect(node.sent).toHaveLength(0);
  });

  it('keeps the form through a reload, and not after publishing', async () => {
    const { env } = environment();
    await toReview(env);
    expect(JSON.parse(localStorage.getItem('paperseal.board.draft') ?? 'null')).toMatchObject({ draftStep: 'review', plan: { name } });
    cleanup();
    renderBoard(env);
    expect(await screen.findByText('Review and publish')).toBeTruthy();
    fireEvent.click(button('Change the details'));
    expect((field('Exam name') as HTMLInputElement).value).toBe(name);
  });

  it('holds a restored draft to the exam name rule, keeping the name as typed', async () => {
    const { env } = environment();
    await toReview(env);
    const saved = JSON.parse(localStorage.getItem('paperseal.board.draft') ?? 'null') as { plan: { name: string } };
    saved.plan.name = 'Physics-2027';
    localStorage.setItem('paperseal.board.draft', JSON.stringify(saved));
    cleanup();
    renderBoard(env);
    expect(await screen.findByText('The exam name must already be in normalised form. Did you mean physics-2027?')).toBeTruthy();
    expect(screen.queryByText('Review and publish')).toBeNull();
    expect((field('Exam name') as HTMLInputElement).value).toBe('Physics-2027');
    expect(button('Continue').disabled).toBe(true);
  });

  it('starts empty when the saved form is damaged or storage is unavailable', () => {
    localStorage.setItem('paperseal.board.draft', '{"plan":{"name":3}}');
    const { env } = environment();
    renderBoard(env);
    expect((field('Exam name') as HTMLInputElement).value).toBe('');
    cleanup();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    renderBoard(env);
    type('Exam name', name);
    expect((field('Exam name') as HTMLInputElement).value).toBe(name);
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
