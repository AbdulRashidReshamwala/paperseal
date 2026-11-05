// @vitest-environment jsdom
import { roles, type Paper } from '@paperseal/protocol';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HolderProgress } from '../../release/progress';
import { actions, chain, credential, facts, passkey, progress, status, tee } from '../../release/testkit';
import { CentreView } from './CentreArea';
import type { Downloaded } from './download';
import { centreStage, sealFor, type CentreInputs } from './stage';
import { isUnavailable, type Files } from './useDownload';
import { refusalFor, useOpenPaper, type OpenPaper } from './useOpenPaper';
import { PaperHashMismatchError, unlockPaper, UnlockError } from './unlock';
import { StorageVerificationError } from '../../shared/storage';

vi.mock('../../shared/registry', () => ({
  registry: { getBuild: vi.fn(() => Promise.resolve({ saltedPaperHash: '0x00' })), getCriteria: vi.fn(() => Promise.resolve(null)) },
  envExamId: `0x${'11'.repeat(32)}`,
  notConnectedToChain: '',
}));
vi.mock('../../shared/config', () => ({ storageUrl: 'https://storage.example', teeStorageBucket: '' }));
vi.mock('../../shared/holder', () => ({
  listEntryFor: vi.fn(() => Promise.resolve({ role: 3, derivedPublicKey: new Uint8Array(65).fill(1) })),
  useHolderCredential: vi.fn(),
}));
vi.mock('./unlock', async (original) => ({ ...(await original<typeof import('./unlock')>()), unlockPaper: vi.fn() }));

afterEach(cleanup);

const paper: Paper = {
  examId: `0x${'11'.repeat(32)}`,
  questions: [
    { topic: 'Mechanics', text: 'State Newton’s second law.' },
    { topic: 'Optics', text: 'Define refraction.' },
    { topic: 'Mechanics', text: 'Define momentum.' },
  ],
};
const ready: Files = { state: 'ready', downloaded: {} as Downloaded };
const idleOpen: OpenPaper = { phase: { name: 'idle' }, paper: null, start: vi.fn() };
const inputs = (overrides: Partial<CentreInputs> = {}): CentreInputs => ({
  filesReady: true,
  filesRefused: false,
  paper: null,
  openFailed: false,
  justReleased: false,
  ...overrides,
});
const asShareholder = chain(facts(roles.centreKeyHolder));
const asCentre = chain(facts(roles.centre));

describe('centreStage', () => {
  const cases: [string, Partial<HolderProgress>, Partial<CentreInputs>, string][] = [
    ['no key is registered here', { credential: null }, {}, 'register'],
    ['this key is a neutral party', { chain: chain(facts(roles.neutral)) }, {}, 'not-on-list'],
    ['no paper is sealed', { chain: chain(facts(roles.centre, { buildPosted: false })) }, {}, 'awaiting-build'],
    ['before unlock', { chain: asCentre }, {}, 'waiting'],
    ['still downloading before unlock', { chain: asCentre }, { filesReady: false }, 'waiting'],
    ['a file failed its check', { chain: asCentre }, { filesReady: false, filesRefused: true }, 'files-refused'],
    ['unlock, holding a share', { chain: asShareholder, reached: true, status: tee(status('unlock')) }, {}, 'release'],
    ['unlock, share released', { chain: asShareholder, reached: true, status: tee(status('unlock', [passkey])) }, {}, 'holders'],
    ['unlock, just released', { chain: asShareholder, reached: true, status: tee(status('unlock')) }, { justReleased: true }, 'holders'],
    ['unlock, no share', { chain: asCentre, reached: true, status: tee(status('unlock')) }, {}, 'holders'],
    ['the key has arrived', { chain: asCentre, reached: true, status: tee(status('released')) }, {}, 'open'],
    ['it arrived for a centre that never released', { chain: asShareholder, reached: true, status: tee(status('released')) }, {}, 'open'],
    ['it arrived before the files', { chain: asCentre, reached: true, status: tee(status('released')) }, { filesReady: false }, 'files-pending'],
    ['the machine has failed', { chain: asCentre, status: tee(status('failed')) }, {}, 'machine-failed'],
    ['the machine is down at unlock', { chain: asCentre, reached: true, status: { value: null, error: 'down', settled: true } }, {}, 'machine-unreachable'],
    ['opening was refused', { chain: asCentre, status: tee(status('released')) }, { openFailed: true }, 'open-failed'],
    ['the paper passed', { chain: asCentre, status: tee(status('released')) }, { paper }, 'paper-open'],
  ];

  it.each(cases)('%s', (_name, overrides, given, expected) => {
    expect(centreStage(progress(overrides), inputs(given))).toBe(expected);
  });

  it('waits for the release, not the clock, before offering to open the paper', () => {
    expect(centreStage(progress({ chain: asCentre, reached: true, status: tee(status('unlock')) }), inputs())).toBe('holders');
  });

  it('breaks the seal only for a paper that passed', () => {
    const shown = ['waiting', 'release', 'holders', 'open', 'open-failed', 'files-pending', 'machine-failed'] as const;
    for (const stage of shown) expect(sealFor(stage)).not.toBe('open');
    expect(sealFor('paper-open')).toBe('open');
    for (const stage of ['files-refused', 'open-failed', 'machine-failed'] as const) expect(sealFor(stage)).toBeNull();
  });
});

describe('CentreView', () => {
  const view = (overrides: Partial<HolderProgress>, files: Files = ready, open: OpenPaper = idleOpen) =>
    render(
      <CentreView
        progress={progress({ chain: asCentre, ...overrides })}
        actions={actions()}
        context={null}
        files={files}
        retryFiles={vi.fn()}
        open={open}
        justReleased={false}
        onReleased={vi.fn()}
        log={<p>The log</p>}
      />,
    );
  const atRelease = { reached: true, status: tee(status('released')) };

  it('checks the files by itself: one line, one check, and no download button', () => {
    view({});
    expect(screen.getByText('Sealed paper downloaded and checked')).toBeTruthy();
    expect(document.querySelectorAll('.ps-check')).toHaveLength(1);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sealed' })).toBeTruthy();
  });

  it('shows a download in progress as pending, not as passed', () => {
    view({}, { state: 'running' });
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.queryByText('Pass')).toBeNull();
  });

  it('refuses files that fail, and says who to contact and why', () => {
    view({}, { state: 'refused', detail: 'paper.bin does not match the paper hash in the Build.' });
    expect(screen.getByRole('heading', { name: 'The sealed paper failed its check' })).toBeTruthy();
    expect(screen.getByText(/does not match the public record.*Contact your exam board now/)).toBeTruthy();
  });

  it('offers the release in place for a centre with a share', () => {
    view({ chain: asShareholder, reached: true, status: tee(status('unlock')) });
    expect(screen.getByRole('heading', { name: /can't be released/ })).toBeTruthy();
    view({ chain: asCentre, reached: true, status: tee(status('unlock')) });
    expect(screen.getByRole('heading', { name: 'Waiting for key holders' })).toBeTruthy();
  });

  it('has one action at unlock, and no paper', () => {
    view(atRelease);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Open the paper']);
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByRole('img', { name: 'Opening' })).toBeTruthy();
  });

  it('shows the paper, numbered through, with the seal open and a print button', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    view(atRelease, ready, { ...idleOpen, paper });
    expect(screen.getByRole('article', { name: 'The examination paper' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Open' })).toBeTruthy();
    expect([...document.querySelectorAll('.paper-sheet ol')].map((list) => list.getAttribute('start'))).toEqual(['1', '3']);
    expect([...document.querySelectorAll('.paper-sheet li')].map((item) => item.textContent)).toEqual([
      'State Newton’s second law.',
      'Define momentum.',
      'Define refraction.',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Print the paper' }));
    expect(print).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('refuses a failed paper with no paper on screen, no retry, and who to contact and why', () => {
    const refusal = refusalFor('check', new PaperHashMismatchError());
    view(atRelease, ready, { ...idleOpen, phase: { name: 'failed', refusal } });
    expect(screen.getByRole('heading', { name: 'This paper failed its check and is not shown' })).toBeTruthy();
    expect(screen.getByText(/does not match the fingerprint/)).toBeTruthy();
    expect(screen.getByText(/Contact your exam board now/)).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Open' })).toBeNull();
  });

  it('keeps the unlock log folded away', () => {
    view(atRelease);
    expect(screen.getByText('The log')).toBeTruthy();
  });

  it('keeps the same seal mounted as it breaks', () => {
    const first = view(atRelease);
    const seal = document.querySelector('.ps-seal');
    first.rerender(
      <CentreView
        progress={progress({ chain: asCentre, ...atRelease })}
        actions={actions()}
        context={null}
        files={ready}
        retryFiles={vi.fn()}
        open={{ ...idleOpen, paper }}
        justReleased={false}
        onReleased={vi.fn()}
        log={null}
      />,
    );
    expect(document.querySelector('.ps-seal')).toBe(seal);
    expect(seal?.getAttribute('data-state')).toBe('open');
  });
});

describe('refusalFor', () => {
  it('does not offer a retry for a paper that failed its check', () => {
    expect(refusalFor('check', new PaperHashMismatchError()).canRetry).toBe(false);
    expect(refusalFor('check', new UnlockError('check', 'The paper is for a different exam.')).canRetry).toBe(false);
    expect(refusalFor('decrypt', new UnlockError('decrypt', 'bad')).canRetry).toBe(false);
  });

  it('offers a retry for what time or a network can fix', () => {
    expect(refusalFor('timelock', new UnlockError('timelock', 'no')).canRetry).toBe(true);
    expect(refusalFor('keyPriv', new UnlockError('keyPriv', 'no')).canRetry).toBe(true);
    expect(refusalFor(null, new Error('no')).canRetry).toBe(true);
  });

  it('always names the exam board', () => {
    for (const error of [new PaperHashMismatchError(), new UnlockError('timelock', 'x'), new Error('x')]) {
      expect(refusalFor(null, error).contact).toContain('exam board');
    }
  });
});

describe('useOpenPaper', () => {
  const mocked = vi.mocked(unlockPaper);
  const files = { paper: new Uint8Array(), keyPubTlock: 'x' } as Downloaded;
  const opener = () => renderHook(() => useOpenPaper(files, credential));

  beforeEach(() => {
    mocked.mockReset();
  });

  it('holds a paper only once every check has returned it', async () => {
    let resolve = (_paper: Paper) => {};
    mocked.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = opener();
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(mocked).toHaveBeenCalled();
    });
    expect(result.current.paper).toBeNull();
    act(() => {
      resolve(paper);
    });
    await waitFor(() => {
      expect(result.current.paper).toEqual(paper);
    });
  });

  it('holds no paper when the hash check fails', async () => {
    mocked.mockImplementation((context) => {
      context.onStep?.('check');
      return Promise.reject(new PaperHashMismatchError());
    });
    const { result } = opener();
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.phase.name).toBe('failed');
    });
    expect(result.current.paper).toBeNull();
  });

  it('treats a failed touch as a key problem', async () => {
    mocked.mockImplementation((context) => {
      context.onStep?.('touch');
      return Promise.reject(new DOMException('no', 'NotAllowedError'));
    });
    const { result } = opener();
    act(() => {
      result.current.start();
    });
    await waitFor(() => {
      expect(result.current.phase.name).toBe('key-failed');
    });
  });
});

describe('isUnavailable', () => {
  it('retries what could not be reached, but not what failed a check', () => {
    expect(isUnavailable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUnavailable(new StorageVerificationError('Storage returned 404 for paper.bin.'))).toBe(true);
    expect(isUnavailable(new StorageVerificationError('paper.bin does not match the paper hash in the Build.'))).toBe(false);
  });
});

describe('print styles', () => {
  const css = readFileSync(join(import.meta.dirname, 'paper.css'), 'utf8');

  it('prints only the paper, in black on white', () => {
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/\.ps-role,\s+\.centre-noprint\s*{\s*display: none/);
    expect(print).toContain('color: black');
    expect(print).toContain('background: white');
  });
});
