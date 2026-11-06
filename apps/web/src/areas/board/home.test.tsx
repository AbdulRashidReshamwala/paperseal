// @vitest-environment jsdom
import { examIdFromName, firstRoundAtOrAfter, type Hex } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentExamId } from '../../shared/currentExam';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import BoardArea from './BoardArea';
import { saveDraft, type DraftContent } from './draftStore';
import { rememberExam } from './examsStore';
import { HOME_LIST_DEADLINE_MS, HOME_READ_LIMIT, HOME_READ_TIMEOUT_MS, useListSettled, useRowReads, type RowRead } from './homeReads';
import { defaultPlan } from './plan';
import type { PublishEnvironment } from './publishFlow';

const DAY = 86_400;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const draft = (name: string): DraftContent => ({
  plan: { ...defaultPlan, name },
  publish: { version: '', rpcHost: 'rpc.example.org' },
  draftStep: 'create',
});

interface Chain {
  /** Seconds from now to the exam. Negative once it has been held. */
  start: number;
  list?: boolean;
  build?: boolean;
  /** Reading this exam fails. */
  broken?: boolean;
  /** Reading this exam never finishes. */
  hang?: boolean;
}

/** A registry that knows these exams. `reading` counts reads in flight, `peak` the most at once, and `listReads` every read of an approved list. */
function chainOf(exams: Record<string, Chain>) {
  const stats = { reading: 0, peak: 0, listReads: 0 };
  const registry = {
    getExam: async (id: Hex) => {
      const known = Object.entries(exams).find(([name]) => examIdFromName(name) === id)?.[1];
      stats.reading += 1;
      stats.peak = Math.max(stats.peak, stats.reading);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (known?.hang) await new Promise(() => undefined);
        if (known?.broken) throw new Error('rpc down');
        if (!known) return null;
        const start = nowSeconds() + known.start;
        const round = (seconds: number) => BigInt(firstRoundAtOrAfter(seconds));
        return {
          settings: {
            examId: id,
            examStart: BigInt(start),
            delta: 600n,
            lockRound: round(start - 7200),
            unlockRound: round(start - 600),
            endRound: round(start + 14_400),
            criteriaHash: `0x${'0'.repeat(64)}`,
            rpcHost: 'rpc.example.org',
          },
          commitHash: `0x${'aa'.repeat(20)}`,
          imageDigest: `0x${'bb'.repeat(32)}`,
          createdAt: 1n,
          createdBlock: 1n,
        };
      } finally {
        stats.reading -= 1;
      }
    },
    getCriteria: () => Promise.resolve(null),
    getApprovedList: (id: Hex) => {
      stats.listReads += 1;
      return Promise.resolve(Object.entries(exams).find(([name]) => examIdFromName(name) === id)?.[1].list ? { listHash: `0x${'11'.repeat(32)}`, postedAt: 1n, postedBlock: 1n } : null);
    },
    getApprovedListEntries: () => Promise.resolve(null),
    getBuild: (id: Hex) => Promise.resolve(Object.entries(exams).find(([name]) => examIdFromName(name) === id)?.[1].build ? { buildHash: `0x${'22'.repeat(32)}` } : null),
  };
  return { stats, environment: { createRegistry: () => registry } as unknown as PublishEnvironment };
}

const tee = (stage: string, outbox: unknown[] = []) =>
  ({
    status: () => Promise.resolve({ stage, questionCount: 0, release: { released: [], required: 8 } }),
    outbox: () => Promise.resolve({ messages: outbox }),
  }) as unknown as TeeClient;

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
}
function renderBoard(path: string, environment: PublishEnvironment, teeClient: TeeClient | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/board/*" element={<BoardArea environment={environment} tee={teeClient} />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId('where').textContent;
const row = (title: string) => screen.getByText(title).closest('li') as HTMLElement;
const list = () => screen.getByRole('list', { name: 'Your exams and drafts' });
const titles = () => within(list()).getAllByRole('listitem').map((item) => item.querySelector('strong')?.textContent);

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

describe('/board, the home page', () => {
  it('has one primary action, no create form, and one line when the list is empty', () => {
    renderBoard('/board', chainOf({}).environment);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your exams');
    expect(screen.getByText('You have no exams yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create an exam' })).toBeTruthy();
    expect(screen.queryByLabelText(/^Exam name/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Your exams and drafts' })).toBeNull();
    expect(document.querySelectorAll('.board-home-action button')).toHaveLength(1);
  });

  it('goes to /board/new from Create an exam, which is step 1 of 6 on an empty form, and a reload stays there', () => {
    const { environment } = chainOf({});
    renderBoard('/board', environment);
    fireEvent.click(screen.getByRole('button', { name: 'Create an exam' }));
    expect(where()).toBe('/board/new');
    expect(screen.getByText('Create the exam')).toBeTruthy();
    expect((screen.getByLabelText(/^Exam name/) as HTMLInputElement).value).toBe('');
    cleanup();
    renderBoard('/board/new', environment);
    expect(screen.getByText('Create the exam')).toBeTruthy();
    expect(screen.queryByText('Your exams')).toBeNull();
  });

  it('lists drafts and published exams together, newest first, with ones of unknown age last', async () => {
    rememberExam({ id: examIdFromName('old-exam'), name: 'old-exam' }, 1_000);
    rememberExam({ id: examIdFromName('new-exam'), name: 'new-exam' }, 4_000);
    saveDraft('a', draft('middle-draft'), 3_000);
    saveDraft('b', draft('oldest-draft'), 500);
    localStorage.setItem(`paperseal.invites.${examIdFromName('legacy')}`, '[]');
    renderBoard('/board', chainOf({}).environment);
    expect(await screen.findByText('new-exam')).toBeTruthy();
    expect(titles()).toEqual(['new-exam', 'middle-draft', 'old-exam', 'oldest-draft', 'An exam without a saved name']);
    expect(screen.getByText('Reference ' + examIdFromName('legacy').slice(2, 10))).toBeTruthy();
  });

  it('says what a draft is, when it was edited, and offers Continue and Delete', () => {
    saveDraft('a', { ...draft(''), plan: { ...defaultPlan, topics: [{ name: 'Mechanics', questions: '5' }] } }, Date.now() - 12 * 60_000);
    renderBoard('/board', chainOf({}).environment);
    const item = row('Untitled exam');
    expect(within(item).getByText('Draft')).toBeTruthy();
    expect(within(item).getByText(/Edited 12 minutes ago/)).toBeTruthy();
    expect(within(item).getByRole('button', { name: 'Continue Untitled exam' })).toBeTruthy();
  });

  it('continues a draft with its form, and a reload on its route stays there', () => {
    saveDraft('abc', draft('maths-2027'));
    renderBoard('/board', chainOf({}).environment);
    fireEvent.click(screen.getByRole('button', { name: 'Continue maths-2027' }));
    expect(where()).toBe('/board/draft/abc');
    expect((screen.getByLabelText(/^Exam name/) as HTMLInputElement).value).toBe('maths-2027');
  });

  it('deletes a draft after one confirm, and keeping it changes nothing', () => {
    saveDraft('a', draft('maths-2027'));
    saveDraft('b', draft('physics-2027'));
    renderBoard('/board', chainOf({}).environment);
    fireEvent.click(screen.getByRole('button', { name: 'Delete maths-2027' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(titles()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Delete maths-2027' }));
    expect(titles()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete maths-2027' }));
    expect(titles()).toEqual(['physics-2027']);
    expect(JSON.parse(localStorage.getItem('paperseal.board.drafts') ?? '[]')).toHaveLength(1);
  });

  it('says drafts stay in this browser, and that exams from another browser are not listed', () => {
    renderBoard('/board', chainOf({}).environment);
    expect(screen.getByText(/saved only in this browser. Exams published from another browser are not listed here/)).toBeTruthy();
  });

  it('opens an exam by its ID, and refuses text that is not one', () => {
    const id = examIdFromName('elsewhere-2027');
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    renderBoard('/board', chainOf({}).environment);
    expect(screen.queryByLabelText('Exam ID')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open an exam by its ID' }));
    const field = screen.getByLabelText('Exam ID');
    fireEvent.change(field, { target: { value: '0x12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByText(/That is not an exam ID/)).toBeTruthy();
    expect(where()).toBe('/board');
    fireEvent.change(field, { target: { value: ` ${id.toUpperCase().replace('0X', '0x')} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(where()).toBe(`/board/exam/${id}`);
  });
});

const remember = (all: string[]) => {
  all.forEach((name, index) => {
    rememberExam({ id: examIdFromName(name), name }, 1_000 + index);
  });
};
const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const skeleton = () => document.querySelector('.board-skeleton');

describe('the status on each published exam', () => {
  const names = {
    nobody: { start: 30 * DAY },
    waiting: { start: 30 * DAY, list: true },
    posted: { start: 30 * DAY, list: true, build: true },
    finished: { start: -30 * DAY, list: true, build: true },
    unposted: { start: -30 * DAY, list: true },
  } satisfies Record<string, Chain>;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the words of each stage, and shows Checking… on a row still unread at the deadline', async () => {
    vi.useFakeTimers();
    remember(['nobody', 'waiting', 'posted', 'finished', 'unposted', 'slow']);
    renderBoard('/board', chainOf({ ...names, slow: { start: DAY, hang: true } }).environment);
    expect(screen.getAllByText('Checking…')).toHaveLength(1);
    await pass(HOME_LIST_DEADLINE_MS - 1);
    expect(screen.queryByText('nobody')).toBeNull();
    await pass(1);
    expect(within(row('nobody')).getByText('Inviting')).toBeTruthy();
    expect(within(row('waiting')).getByText('Collecting')).toBeTruthy();
    expect(within(row('posted')).getByText('Posted')).toBeTruthy();
    expect(within(row('finished')).getByText('Finished')).toBeTruthy();
    // Started with no Build: abandoned, so it is not listed.
    expect(screen.queryByText('unposted')).toBeNull();
    expect(within(row('slow')).getByText('Checking…')).toBeTruthy();
    expect(row('slow').querySelector('.board-skeleton-bar')?.getAttribute('aria-hidden')).toBe('true');
    expect(within(row('slow')).getByRole('status').textContent).toBe('Checking…');
    expect(within(row('slow')).getByText('Checking…').className).toBe('ps-sr');
    expect(row('waiting').querySelector('.board-skeleton-bar')).toBeNull();
    expect(document.querySelector('.board-skeleton')).toBeNull();
    // The exam date is shown as a real date and time.
    expect(within(row('waiting')).getByText(/^Exam on .*\d{4}/)).toBeTruthy();
  });

  it('hides an exam that started with no Build, once its read says so, and keeps a finished one', async () => {
    remember(['finished', 'unposted', 'noList', 'nobody']);
    renderBoard('/board', chainOf({ ...names, noList: { start: -DAY } }).environment);
    await waitFor(() => {
      expect(within(row('finished')).getByText('Finished')).toBeTruthy();
    });
    expect(screen.queryByText('unposted')).toBeNull();
    expect(screen.queryByText('noList')).toBeNull();
    expect(within(row('nobody')).getByText('Inviting')).toBeTruthy();
    expect(titles()).toHaveLength(2);
  });

  it('does not hide a row while its read is unknown or failed', async () => {
    vi.useFakeTimers();
    remember(['slow', 'broken', 'gone']);
    renderBoard('/board', chainOf({ slow: { start: -DAY, hang: true }, broken: { start: -DAY, broken: true } }).environment);
    await pass(HOME_LIST_DEADLINE_MS);
    expect(within(row('slow')).getByText('Checking…')).toBeTruthy();
    expect(within(row('broken')).getByText('Unavailable')).toBeTruthy();
    await pass(HOME_READ_TIMEOUT_MS);
    expect(within(row('slow')).getByText('Unavailable')).toBeTruthy();
    // Not on the registry at all: not known to be abandoned either.
    expect(within(row('gone')).getByText('Unpublished')).toBeTruthy();
  });

  it('removes an exam from this browser only, after one confirm, and keeping it changes nothing', async () => {
    remember(['waiting', 'posted']);
    renderBoard('/board', chainOf(names).environment);
    await screen.findByText('waiting');
    fireEvent.click(screen.getByRole('button', { name: 'Remove waiting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(titles()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove waiting' }));
    expect(screen.getByText(/Remove from this browser's list\? It stays on the public record\./)).toBeTruthy();
    expect(titles()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove waiting' }));
    expect(titles()).toEqual(['posted']);
    cleanup();
    renderBoard('/board', chainOf(names).environment);
    await screen.findByText('posted');
    expect(screen.queryByText('waiting')).toBeNull();
  });

  it('shows the row that needs the board more strongly than the others', async () => {
    remember(['nobody', 'waiting']);
    renderBoard('/board', chainOf(names).environment);
    await waitFor(() => {
      expect(within(row('nobody')).getByText('Inviting')).toBeTruthy();
      expect(within(row('waiting')).getByText('Collecting')).toBeTruthy();
    });
    expect(row('nobody').classList.contains('board-row-act')).toBe(true);
    expect(row('waiting').classList.contains('board-row-act')).toBe(false);
  });

  it('asks Paper Seal only about the current exam: ready to post, or failed', async () => {
    remember(['waiting', 'posted']);
    setCurrentExamId(examIdFromName('waiting'));
    renderBoard('/board', chainOf(names).environment, tee('submit', [{ kind: 'build' }]));
    await waitFor(() => {
      expect(within(row('waiting')).getByText('Ready')).toBeTruthy();
    });
    expect(row('waiting').classList.contains('board-row-act')).toBe(true);
    expect(within(row('posted')).getByText('Posted')).toBeTruthy();
    cleanup();
    renderBoard('/board', chainOf(names).environment, tee('failed'));
    await waitFor(() => {
      expect(within(row('waiting')).getByText('Failed')).toBeTruthy();
    });
  });

  it('says Unavailable for a read that failed, and the other rows still show', async () => {
    remember(['waiting', 'broken']);
    renderBoard('/board', chainOf({ ...names, broken: { start: DAY, broken: true } }).environment);
    await waitFor(() => {
      expect(within(row('broken')).getByText('Unavailable')).toBeTruthy();
      expect(within(row('waiting')).getByText('Collecting')).toBeTruthy();
    });
    expect(within(row('broken')).getByRole('button', { name: 'Open broken' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the same when the page has no registry to read', () => {
    remember(['waiting']);
    renderBoard('/board', { createRegistry: null } as unknown as PublishEnvironment);
    expect(skeleton()).toBeNull();
    expect(within(row('waiting')).getByText('Unavailable')).toBeTruthy();
  });

  it('opens a published exam from its row', async () => {
    remember(['waiting']);
    renderBoard('/board', chainOf(names).environment);
    fireEvent.click(await screen.findByRole('button', { name: 'Open waiting' }));
    expect(where()).toBe(`/board/exam/${examIdFromName('waiting')}`);
  });

  it('reads at most a few exams at once', async () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`exam-${String(n)}`, { start: 30 * DAY, list: true }]));
    remember(Object.keys(many));
    const { environment, stats } = chainOf(many);
    renderBoard('/board', environment);
    await waitFor(() => {
      expect(screen.getAllByText('Collecting')).toHaveLength(9);
    });
    expect(stats.peak).toBeLessThanOrEqual(HOME_READ_LIMIT);
    expect(stats.peak).toBeGreaterThan(1);
  });
});

describe('the list on first load', () => {
  const waiting = { start: 30 * DAY, list: true } satisfies Chain;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows one placeholder for each row and no real row or draft, while the rest of the page is there', async () => {
    remember(['waiting', 'other']);
    saveDraft('a', draft('my-draft'), 2_000);
    renderBoard('/board', chainOf({ waiting, other: waiting }).environment);
    expect(skeleton()?.querySelectorAll('li.board-row')).toHaveLength(3);
    expect(screen.queryByRole('list', { name: 'Your exams and drafts' })).toBeNull();
    expect(screen.queryByText('waiting')).toBeNull();
    expect(screen.queryByText('my-draft')).toBeNull();
    expect(screen.queryByText('Draft')).toBeNull();
    expect(within(skeleton() as HTMLElement).getAllByRole('status')).toHaveLength(1);
    expect(within(skeleton() as HTMLElement).getByRole('status').textContent).toBe('Checking…');
    expect(screen.getAllByText('Checking…')).toHaveLength(1);
    expect(screen.getByText('Checking…').className).toBe('ps-sr');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your exams');
    expect(screen.getByRole('button', { name: 'Create an exam' })).toBeTruthy();
    expect(screen.getByText('Open an exam by its ID')).toBeTruthy();
    expect(await screen.findByText('my-draft')).toBeTruthy();
    expect(skeleton()).toBeNull();
    expect(titles()).toEqual(['my-draft', 'other', 'waiting']);
  });

  it('holds every row back until the last read is in, with no mix of the two', async () => {
    vi.useFakeTimers();
    const slowExam: Chain = { start: 30 * DAY, hang: true };
    remember(['waiting', 'slow']);
    renderBoard('/board', chainOf({ waiting, slow: slowExam }).environment);
    await pass(1_000);
    expect(skeleton()).not.toBeNull();
    expect(screen.queryByText('Collecting')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Your exams and drafts' })).toBeNull();
  });

  it('counts a failed read as read, so the list shows without waiting for the deadline', async () => {
    vi.useFakeTimers();
    remember(['broken']);
    renderBoard('/board', chainOf({ broken: { start: DAY, broken: true } }).environment);
    expect(skeleton()).not.toBeNull();
    await pass(1_000);
    expect(skeleton()).toBeNull();
    expect(within(row('broken')).getByText('Unavailable')).toBeTruthy();
  });

  it('never comes back once settled, on later polls or when they fail', async () => {
    vi.useFakeTimers();
    const chain: Chain = { ...waiting };
    remember(['waiting']);
    const { environment, stats } = chainOf({ waiting: chain });
    renderBoard('/board', environment);
    await pass(1_000);
    expect(skeleton()).toBeNull();
    let returned = false;
    const watcher = new MutationObserver(() => {
      returned ||= skeleton() !== null;
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    const before = stats.listReads;
    await pass(TEE_STATUS_POLL_MS * 2);
    chain.broken = true;
    await pass(TEE_STATUS_POLL_MS * 2);
    watcher.disconnect();
    expect(stats.listReads).toBeGreaterThan(before);
    expect(returned).toBe(false);
    expect(within(row('waiting')).getByText('Collecting')).toBeTruthy();
  });

  it('skips the skeleton when only drafts are listed', () => {
    saveDraft('a', draft('my-draft'));
    renderBoard('/board', chainOf({}).environment);
    expect(skeleton()).toBeNull();
    expect(row('my-draft')).toBeTruthy();
  });

  it('stays settled if a source to read from turns up later', () => {
    const ids = [examIdFromName('a')];
    const empty: ReadonlyMap<Hex, RowRead> = new Map();
    const { result, rerender } = renderHook(({ reading }) => useListSettled(ids, empty, reading), { initialProps: { reading: false } });
    expect(result.current).toBe(true);
    rerender({ reading: true });
    expect(result.current).toBe(true);
  });
});

describe('reading the list again', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the full interval after a pass, and keeps the last good value when a read fails', async () => {
    vi.useFakeTimers();
    const ids = [examIdFromName('a'), examIdFromName('b')];
    const snapshot = { found: null } as never;
    let fail = false;
    const load = vi.fn(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve(snapshot)));
    const { result } = renderHook(() => useRowReads(ids, load, 5000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(load).toHaveBeenCalledTimes(2);
    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.current.get(ids[0] as Hex)?.state).toBe('ready');
  });
});

describe('old routes', () => {
  it('/board/blueprint and /board/schedule go to /board/new', () => {
    for (const path of ['/board/blueprint', '/board/schedule']) {
      renderBoard(path, chainOf({}).environment);
      expect(where()).toBe('/board/new');
      expect(screen.getByText('Create the exam')).toBeTruthy();
      cleanup();
    }
  });

  it('/board?exam=<id> and /board/exam/<id> still open the exam, with a link back to the list', async () => {
    const id = examIdFromName('waiting');
    const { environment } = chainOf({ waiting: { start: 30 * DAY, list: true } });
    for (const path of [`/board?exam=${id}`, `/board/exam/${id}`]) {
      renderBoard(path, environment, tee('onboard'));
      expect(await screen.findByText(/Nothing to do until/)).toBeTruthy();
      expect(screen.queryByText('Your exams')).toBeNull();
      cleanup();
    }
    renderBoard(`/board/exam/${id}`, environment, tee('onboard'));
    fireEvent.click(await screen.findByText('All your exams and drafts'));
    expect(where()).toBe('/board');
    expect(screen.getByText('Your exams')).toBeTruthy();
  });

  it('goes to the list for a draft that is not here', () => {
    renderBoard('/board/draft/gone', chainOf({}).environment);
    expect(where()).toBe('/board');
    expect(screen.getByText('Your exams')).toBeTruthy();
  });
});
