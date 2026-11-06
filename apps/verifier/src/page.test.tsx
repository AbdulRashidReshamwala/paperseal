// @vitest-environment jsdom
import type { ExamNameCheck, ExamNameResult, ResolvedExamName } from '@paperseal/chain';
import { decodeApprovedList, fromHex, toHex } from '@paperseal/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { teeStorageBucket } from './attest';
import { VerifierPage } from './page';
import { buildWorld, examId, offlineQuicknet, registryAddress, type World } from './fixtures';
import { SettingsProvider, type Settings } from './settings';

let chainData: unknown;
/** Every registry and exam the page set out to read, in order. */
let chainReads: { registry: string; examId: unknown }[] = [];

// The chain is the one thing these tests stub whole: everything read from it is built with real encodings.
vi.mock('./checks', async (original) => ({
  ...(await original<typeof import('./checks')>()),
  loadChain: (registry: { address: string } | null, id: unknown) => {
    if (!registry || !id) return null;
    chainReads.push({ registry: registry.address, examId: id });
    return () => Promise.resolve(chainData);
  },
}));

/** What reading an exam name comes to. Null runs the real checks, which need no RPC for a name they refuse. */
let nameAnswer: ((name: string) => ExamNameResult) | null = null;
let nameReads: { name: string; rpcUrl: string | undefined }[] = [];
vi.mock('@paperseal/chain', async (original) => {
  const real = await original<typeof import('@paperseal/chain')>();
  return {
    ...real,
    resolveExamName: (name: string, options: { rpcUrl?: string }) => {
      nameReads.push({ name, rpcUrl: options.rpcUrl });
      return nameAnswer ? Promise.resolve(nameAnswer(name)) : real.resolveExamName(name, options);
    },
  };
});

/** The bucket each record and fresh token was checked against. */
let buckets: (string | undefined)[] = [];

/** Whether `release-token.jwt` counts as verified. The test PKI does not lead to Google's root, so by default it does not. */
let tokenVerified = false;
/** What a fresh attestation from the live TEE comes to. */
let freshTrusted = false;
vi.mock('./attest', async (original) => {
  const real = await original<typeof import('./attest')>();
  return {
    ...real,
    checkFreshToken: (args: { bucket?: string }) => {
      buckets.push(args.bucket);
      return Promise.resolve({
        trusted: freshTrusted,
        signature: { ok: freshTrusted, ...(freshTrusted ? {} : { error: new Error('not Google') }) },
        instanceKey: { ok: true },
        claims: [],
        instancePublicKey: `0x04${'dd'.repeat(64)}`,
      });
    },
    checkRecordToken: (args: Parameters<typeof real.checkRecordToken>[0]) => {
      buckets.push(args.bucket);
      return tokenVerified ? Promise.resolve({ verified: true, signature: { ok: true }, claims: [] }) : real.checkRecordToken(args);
    },
  };
});

const settings: Settings = {
  rpcUrl: 'https://rpc.example',
  teeUrl: '',
  storageUrl: 'https://files.example/bucket',
  registryAddress,
  examId,
};

function arrange(world: World, files: Record<string, Uint8Array> = {}) {
  chainData = {
    exam: world.exam,
    list: { listHash: world.build.approvedListHash },
    build: world.build,
    criteria: world.criteriaHex,
    entries: world.entriesHex,
  };
  const served = new Map([...world.files, ...Object.entries(files)]);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const name = String(input).replace(`https://files.example/bucket/${examId}/`, '');
      const bytes = served.get(name);
      return Promise.resolve(bytes ? new Response(new Uint8Array(bytes)) : new Response('no', { status: 404 }));
    }),
  );
}

function open(latestRound: number, over: Partial<Settings> = {}, path = '/') {
  return render(
    <SettingsProvider initial={{ ...settings, ...over }} drand={offlineQuicknet(latestRound)}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </SettingsProvider>,
  );
}

/** One row of the chain of custody, found by its label. */
const stepNamed = (name: RegExp) => {
  const label = screen.getByText(name);
  const step = label.closest('li');
  if (!step) throw new Error('no step');
  return step;
};
const findStep = async (name: RegExp) => {
  const label = await screen.findByText(name, {}, { timeout: 5000 });
  return label.closest('li') as HTMLElement;
};
const stateOf = (step: HTMLElement) => step.getAttribute('data-state');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  tokenVerified = false;
  freshTrusted = false;
  chainReads = [];
  nameAnswer = null;
  nameReads = [];
  buckets = [];
});

describe('one page', () => {
  it('has one chain of custody with seven steps, and no tabs or sign-in', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    await findStep(/^1\. Exam published$/);
    expect(screen.getByRole('list', { name: 'Chain of custody' }).children).toHaveLength(7);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(document.body.textContent).not.toMatch(/sign in/i);
  });

  it('shows no Pass and says what is missing with nothing connected', () => {
    open(1000, { rpcUrl: '', storageUrl: '', registryAddress: '', examId: '' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Choose an exam to check.');
    expect(screen.queryByText('Pass')).toBeNull();
    expect(screen.queryByText('Fail')).toBeNull();
  });

  it('with an exam but no connection, says it is not connected', () => {
    open(1000, { rpcUrl: '', registryAddress: '' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Not connected to the public record.');
    expect(screen.queryByText('Pass')).toBeNull();
  });

  it('keeps the connection settings at the foot, saying anyone can host their own', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const heading = await screen.findByRole('heading', { name: 'Check against your own RPC' });
    const section = heading.closest('section') as HTMLElement;
    expect(section.textContent).toMatch(/host your own copy/);
    expect(within(section).getByText('TEE URL (optional)')).toBeTruthy();
    const steps = screen.getByRole('list', { name: 'Chain of custody' });
    expect(steps.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('choosing an exam', () => {
  const other = `0x${'22'.repeat(32)}`;

  it('reads the exam from a hash route, in place of the saved one', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000, {}, `/exam/${other}`);
    const step = await findStep(/^1\. Exam published$/);
    fireEvent.click(within(step).getByText('Show the evidence'));
    expect(within(step).getByLabelText(`Copy Exam ID: ${other}`)).toBeTruthy();
  });

  it('reads ?exam= from the page address', async () => {
    window.history.pushState({}, '', `/?exam=${other}`);
    try {
      const world = await buildWorld();
      arrange(world);
      open(1000);
      const step = await findStep(/^1\. Exam published$/);
      expect(within(step).getByLabelText(`Copy Exam ID: ${other}`)).toBeTruthy();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('never falls back to the default exam on a bad link', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000, {}, '/exam/not-an-exam');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This link does not name an exam.');
    expect(screen.queryByText('Pass')).toBeNull();
    expect(screen.getByText('The link did not hold a valid exam ID.')).toBeTruthy();
  });

  it('opens an exam someone types in, and refuses anything else', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000, { examId: '' });
    fireEvent.change(screen.getByLabelText(/Exam ID/), { target: { value: 'nonsense' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open this exam' }));
    expect(screen.getByText('Enter a 32-byte ID starting with 0x.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Exam ID/), { target: { value: other } });
    fireEvent.click(screen.getByRole('button', { name: 'Open this exam' }));
    await findStep(/^1\. Exam published$/);
    expect(screen.getByLabelText(`Copy Exam ID: ${other}`)).toBeTruthy();
  });
});

describe('step evidence', () => {
  it('step 2 checks the published token against the chain, claim by claim', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^2\. Sealed machine/);
    await within(step).findByText("Token signature, up to Google's root");
    // The test PKI does not lead to Google's pinned root, so the signature must fail, and so must the whole token.
    await waitFor(() => {
      expect(stateOf(step)).toBe('failed');
    });
    expect(within(step).getByText('eat_nonce')).toBeTruthy();
    expect(within(step).getByText('image_digest')).toBeTruthy();
    expect(within(step).getByText('requireHardwareAttestation')).toBeTruthy();
    expect(within(step).getByText('false')).toBeTruthy();
    expect(within(step).getByText(/Demo mode/)).toBeTruthy();
  });

  it('step 2 and the top of the page say the exam is a demonstration, with nothing connected', () => {
    open(1000, { rpcUrl: '', storageUrl: '', registryAddress: '', examId: '' });
    expect(screen.getByText('This is a demonstration. The security keys are simulated.')).toBeTruthy();
    expect(screen.getByText(/Demo mode/)).toBeTruthy();
  });

  it('step 3 shows a setter as "Setter" with its hash, and no name', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^3\. People approved$/);
    const setter = decodeApprovedList(fromHex(world.entriesHex)).find((entry) => entry.role === 1);
    expect((await within(step).findByText('Setter')).closest('li')?.innerHTML).toContain(setter?.owner);
    expect(screen.queryByText(/Setter names/)).toBeNull();
    expect(screen.queryByText(/Setter \(sealed\)/)).toBeNull();
  });

  it('step 5 lists the manifest files and checks the manifest against the Build', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^5\. Paper built and sealed$/);
    await within(step).findByText('paper.bin');
    expect(within(step).getByText(/Manifest hash matches/)).toBeTruthy();
    const paper = world.manifest.files.find((f) => f.name === 'paper.bin');
    expect(within(step).getByText('paper.bin').closest('li')?.innerHTML).toContain(paper?.sha256);
  });

  it('step 5 is neutral, not failing, when the manifest is not published', async () => {
    const world = await buildWorld();
    arrange(world);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))));
    open(1000);
    const step = await findStep(/^5\. Paper built and sealed$/);
    await within(step).findByText(/manifest.json is not in storage yet/);
    expect(stateOf(step)).not.toBe('failed');
    expect(stateOf(step)).not.toBe('done');
  });

  it('says an on-chain list could not be read, which is not the same as no list', async () => {
    const world = await buildWorld();
    arrange(world);
    (chainData as Record<string, unknown>).entries = null;
    (chainData as Record<string, unknown>).problems = {
      list: { kind: 'unreadable', message: 'The RPC returned no ApprovedListPosted event.' },
    };
    open(1000);
    const step = await findStep(/^3\. People approved$/);
    await within(step).findByText(/Could not be read: The RPC returned no ApprovedListPosted event/);
    expect(stateOf(step)).not.toBe('failed');
    expect(stateOf(step)).not.toBe('done');
  });
});

describe('failures', () => {
  it('are loud and specific at the top, and at the step', async () => {
    const world = await buildWorld();
    arrange(world);
    (chainData as Record<string, unknown>).entries = null;
    (chainData as Record<string, unknown>).problems = {
      list: { kind: 'mismatch', message: 'The ApprovedListPosted bytes do not hash to the on-chain listHash.' },
    };
    open(1000);
    const alarm = await screen.findByRole('alert');
    expect(alarm.textContent).toMatch(/Step 3, People approved/);
    expect(alarm.textContent).toMatch(/do not hash to the on-chain listHash/);
    const step = stepNamed(/^3\. People approved$/);
    expect(stateOf(step)).toBe('failed');
    expect(step.querySelector('.ps-step-note')?.textContent).toMatch(/do not hash to the on-chain listHash/);
    // The top of the page comes before the headline.
    expect(alarm.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('do not appear for missing data', async () => {
    const world = await buildWorld();
    arrange(world);
    chainData = { exam: world.exam, list: null, build: null, criteria: world.criteriaHex, entries: null };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))));
    open(1);
    await findStep(/^3\. People approved$/);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Setting up. The approved list is not published yet.');
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Fail')).toBeNull();
  });
});

describe('step 6, unlock', () => {
  it('shows progress with neutral badges and a warning above the rows until the token passes', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^6\. Unlock$/);
    expect(await within(step).findByText('8 of 8 needed (not verified)')).toBeTruthy();
    const released = within(step).getAllByText('Released');
    expect(released).toHaveLength(8);
    for (const badge of released) expect(badge.getAttribute('data-tone')).toBe('neutral');
    const warning = within(step).getByText(/nothing says which TEE signed this/);
    const rows = within(step).getByText('Holders released').closest('ul');
    expect(warning.compareDocumentPosition(rows ?? warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows progress as evidence once release-token.jwt verifies', async () => {
    tokenVerified = true;
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^6\. Unlock$/);
    expect(await within(step).findByText('8 of 8 needed')).toBeTruthy();
    const released = within(step).getAllByText('Released');
    for (const badge of released) expect(badge.getAttribute('data-tone')).toBe('ok');
    expect(within(step).getAllByText('Not released')).toHaveLength(2);
    expect(within(step).queryByText(/nothing says which TEE signed this/)).toBeNull();
    expect(stateOf(step)).toBe('done');
  });

  it('has a countdown with the round in its evidence', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^6\. Unlock$/);
    expect(await within(step).findByRole('timer')).toBeTruthy();
    expect(within(step).getByText('Public clock round 200')).toBeTruthy();
  });

  it('is neutral when no log is published yet', async () => {
    const world = await buildWorld();
    arrange(world);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))));
    open(1000);
    const step = await findStep(/^6\. Unlock$/);
    await within(step).findByText(/release-log.json is not in storage yet/);
    expect(within(step).queryByText('Fail')).toBeNull();
  });

  describe('with the live TEE', () => {
    async function openLive(trusted: boolean) {
      freshTrusted = trusted;
      const world = await buildWorld();
      arrange(world);
      const holders = decodeApprovedList(fromHex(world.entriesHex)).filter((e) => e.role === 2 || e.role === 3);
      const released = holders.slice(0, 8).map((e) => toHex(e.passkeyPublicKey));
      const storageFetch = vi.mocked(fetch).getMockImplementation();
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request) => {
          const url = String(input);
          if (url.startsWith('https://tee.example/v1/status')) {
            return Promise.resolve(new Response(JSON.stringify({ stage: 'unlock', questionCount: 3, release: { released, required: 8 } })));
          }
          if (url.startsWith('https://tee.example/')) return Promise.resolve(new Response('no', { status: 404 }));
          return (storageFetch as (i: string | URL | Request) => Promise<Response>)(input);
        }),
      );
      open(1000, { teeUrl: 'https://tee.example' });
      const step = await findStep(/^6\. Unlock$/);
      await within(step).findByText('Live from the sealed machine, optional');
      return step;
    }

    it('is neutral, with the warning above the rows, when the fresh attestation is not trusted', async () => {
      const step = await openLive(false);
      const warning = await within(step).findByText(/has not passed attestation/);
      expect(within(step).getByText('unlock (not verified)')).toBeTruthy();
      const rows = within(step).getByText('unlock (not verified)').closest('ul');
      expect(warning.compareDocumentPosition(rows ?? warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows progress as evidence when the fresh attestation is trusted', async () => {
      const step = await openLive(true);
      await within(step).findByText('TEE attestation passes, so its answers can be trusted');
      expect(within(step).getByText('unlock')).toBeTruthy();
      expect(within(step).queryByText(/has not passed attestation/)).toBeNull();
    });
  });
});

describe('step 7, proof', () => {
  it('opens the paper after the end round and shows each of the 7 checks as Pass', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    expect(await screen.findByText('Differentiate x squared.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Integrate 2x.')).toBeTruthy();
    // A multiple choice question shows its options as a lettered list, in the paper's order.
    const options = screen.getByRole('list', { name: 'Options' });
    expect(options.getAttribute('type')).toBe('A');
    expect([...options.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['First law', 'Second law', 'Third law']);
    expect(screen.getAllByRole('list', { name: 'Options' })).toHaveLength(1);
    const step = stepNamed(/^7\. Exam ends and paper opens$/);
    expect(within(step).getAllByText('Pass')).toHaveLength(7);
    expect(within(step).queryByText('Fail')).toBeNull();
    expect(stateOf(step)).toBe('done');
    expect(document.querySelector('.ps-seal')?.getAttribute('data-state')).toBe('open');
  });

  it('withholds a paper that does not match the Build and fails loudly', async () => {
    const world = await buildWorld({ wrongSaltedHash: true });
    arrange(world);
    open(1000);
    const step = await findStep(/^7\. Exam ends and paper opens$/);
    await within(step).findByText('Paper withheld', {}, { timeout: 5000 });
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
    expect(stateOf(step)).toBe('failed');
    expect(screen.getByRole('alert').textContent).toMatch(/not the paper the Build committed to/);
  });

  it('says no copy exists when the unlock never happened', async () => {
    const world = await buildWorld({ unlocked: false });
    arrange(world);
    open(1000);
    const step = await findStep(/^7\. Exam ends and paper opens$/);
    await within(step).findByText(/No copy exists/, { selector: '.ps-step-note' }, { timeout: 5000 });
    expect(stateOf(step)).toBe('not-applicable');
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
  });

  it('says when the paper opens before the end round, and shows no paper', async () => {
    const world = await buildWorld({ endRound: 99_999_999 });
    arrange(world);
    open(1000);
    const step = await findStep(/^7\. Exam ends and paper opens$/);
    expect(await within(step).findByText(/opens when the public clock publishes round 99999999/)).toBeTruthy();
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
  });
});

describe('updating', () => {
  const fast = { records: 20, live: 20, proofRetry: 20 };
  const openPolling = (latestRound: number) =>
    render(
      <SettingsProvider initial={settings} drand={offlineQuicknet(latestRound)}>
        <MemoryRouter>
          <PollingApp />
        </MemoryRouter>
      </SettingsProvider>,
    );
  const PollingApp = () => <VerifierPage pollMs={fast} />;

  it('moves on by itself when the Build appears, with no reload', async () => {
    const world = await buildWorld({ endRound: 99_999_999 });
    arrange(world);
    const posted = chainData;
    chainData = { ...(chainData as object), build: null };
    openPolling(150);
    const step = await findStep(/^5\. Paper built and sealed$/);
    await within(step).findAllByText('No Build yet', {}, { timeout: 2000 });
    expect(stateOf(step)).not.toBe('failed');
    act(() => {
      chainData = posted;
    });
    await within(step).findByText('paper.bin', {}, { timeout: 2000 });
    await waitFor(() => {
      expect(within(step).queryByText('No Build yet')).toBeNull();
    });
  });

  it('keeps an opened fold open across reads', async () => {
    const world = await buildWorld({ endRound: 99_999_999 });
    arrange(world);
    openPolling(150);
    const step = await findStep(/^1\. Exam published$/);
    const fold = step.querySelector('details') as HTMLDetailsElement;
    fold.open = true;
    const reads = vi.mocked(fetch).mock.calls.length;
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(reads);
    });
    expect((step.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });

});

describe('verify by name', () => {
  const name = 'jee-main-2026.board.eth';
  const board = `0x${'bb'.repeat(20)}` as const;
  // The saved exam and registry are not the name's, so a read of the saved ones would show.
  const saved = { registryAddress: `0x${'99'.repeat(20)}`, examId: `0x${'33'.repeat(32)}` };
  const passed = (over: Partial<ResolvedExamName> = {}): ExamNameResult => ({
    ok: true,
    value: { name, label: 'jee-main-2026', parent: 'board.eth', examId, registry: registryAddress, board, teeUrl: null, storageUrl: null, bucket: null, ...over },
  });
  const failed = (check: ExamNameCheck): ExamNameResult => ({ ok: false, failed: check, reason: 'The record says otherwise.', partial: { name } });
  const noteOf = (step: HTMLElement) => step.querySelector('.ps-step-note')?.textContent ?? '';

  it('passes the Name step first, then reads the chain with the name\'s registry and exam', async () => {
    const world = await buildWorld();
    arrange(world);
    nameAnswer = () => passed();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    open(1000, saved, `/name/${name}`);
    const step = await findStep(/^1\. Name$/);
    await waitFor(() => {
      expect(stateOf(step)).toBe('done');
    });
    expect(nameReads[0]).toEqual({ name, rpcUrl: settings.rpcUrl });
    expect(screen.getByRole('list', { name: 'Chain of custody' }).children).toHaveLength(8);
    await findStep(/^2\. Exam published$/);
    expect(chainReads.length).toBeGreaterThan(0);
    expect(chainReads.every((read) => read.registry === registryAddress && read.examId === examId)).toBe(true);
    expect(noteOf(step)).toMatch(/verified both ways/);
    expect(within(step).getByText(/a Sepolia name|On Sepolia/)).toBeTruthy();
    expect(within(step).getByText('board.eth')).toBeTruthy();
    expect(within(step).getAllByText('From Connection')).toHaveLength(2);
    expect(within(step).getByText('Built into this page')).toBeTruthy();
    expect(await screen.findByText(`${name}, on`, { exact: false })).toBeTruthy();
    // The name's values are for this view only.
    expect(setItem).not.toHaveBeenCalled();
  });

  it("reads the name's TEE, storage and bucket in place of the viewer's own", async () => {
    const world = await buildWorld();
    arrange(world);
    const storageFetch = vi.mocked(fetch).getMockImplementation() as (i: string | URL | Request) => Promise<Response>;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.startsWith('https://tee.name.example/')) return Promise.resolve(new Response('no', { status: 404 }));
        return storageFetch(url.replace('https://names.example/bucket/', 'https://files.example/bucket/'));
      }),
    );
    nameAnswer = () => passed({ teeUrl: 'https://tee.name.example', storageUrl: 'https://names.example/bucket', bucket: 'name-bucket' });
    open(1000, { ...saved, teeUrl: 'https://tee.example' }, `/name/${name}`);
    const step = await findStep(/^1\. Name$/);
    await waitFor(() => {
      expect(stateOf(step)).toBe('done');
    });
    expect(within(step).getAllByText('From the name')).toHaveLength(3);
    await waitFor(() => {
      expect(urls.some((url) => url.startsWith(`https://names.example/bucket/${examId}/`))).toBe(true);
      expect(urls.some((url) => url.startsWith('https://tee.name.example/'))).toBe(true);
      expect(buckets.length).toBeGreaterThan(0);
    });
    expect(urls.some((url) => url.startsWith('https://files.example/') || url.startsWith('https://tee.example/'))).toBe(false);
    expect(new Set(buckets)).toEqual(new Set(['name-bucket']));
  });

  it("falls back to the viewer's own TEE and storage, and the built-in bucket, where the name sets none", async () => {
    const world = await buildWorld();
    arrange(world);
    nameAnswer = () => passed();
    open(1000, saved, `/name/${name}`);
    await findStep(/^1\. Name$/);
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith(`https://files.example/bucket/${examId}/`))).toBe(true);
      expect(buckets.length).toBeGreaterThan(0);
    });
    expect(new Set(buckets)).toEqual(new Set([teeStorageBucket]));
  });

  it.each([
    ['name', 'Not a valid name'],
    ['registry', 'No registry'],
    ['primaryName', 'Primary name differs'],
    ['forward', 'Not verified both ways'],
  ] as [ExamNameCheck, string][])('a failed %s check fails the Name step, stops the rest and shows no seal', async (check, title) => {
    const world = await buildWorld();
    arrange(world);
    nameAnswer = () => failed(check);
    open(1000, saved, `/name/${name}`);
    const step = await findStep(/^1\. Name$/);
    await waitFor(() => {
      expect(stateOf(step)).toBe('failed');
    });
    expect(noteOf(step)).toContain(`${title}. The record says otherwise.`);
    expect((await screen.findByRole('alert')).textContent).toMatch(new RegExp(`Step 1, Name\\. ${title}`));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This name does not lead to a verified exam.');
    expect(stateOf(stepNamed(/^2\. Exam published$/))).toBe('waiting');
    expect(document.querySelector('.ps-seal')).toBeNull();
    expect(chainReads).toEqual([]);
    expect(screen.queryByText(name, { exact: false, selector: '.ps-role-exam' })).toBeNull();
  });

  it('refuses a name that is not normalised, as typed, with the real check', async () => {
    open(1000, saved, '/name/JEE-Main-2026.board.eth');
    const step = await findStep(/^1\. Name$/);
    await waitFor(() => {
      expect(stateOf(step)).toBe('failed');
    });
    expect(noteOf(step)).toMatch(/Not a valid name\. .*normalised/);
    expect(chainReads).toEqual([]);
  });

  it("can't read ENS: neutral, no seal and no chain read, and it tries again", async () => {
    const world = await buildWorld();
    arrange(world);
    nameAnswer = () => failed('unreadable');
    render(
      <SettingsProvider initial={{ ...settings, ...saved }} drand={offlineQuicknet(1000)}>
        <MemoryRouter initialEntries={[`/name/${name}`]}>
          <VerifierPage pollMs={{ records: 20, live: 20, proofRetry: 20 }} />
        </MemoryRouter>
      </SettingsProvider>,
    );
    const step = await findStep(/^1\. Name$/);
    await waitFor(() => {
      expect(noteOf(step)).toMatch(/^Can't read ENS\./);
    });
    expect(stateOf(step)).toBe('current');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The exam name could not be read.');
    expect(document.querySelector('.ps-seal')).toBeNull();
    expect(chainReads).toEqual([]);
    const reads = nameReads.length;
    act(() => {
      nameAnswer = () => passed();
    });
    await waitFor(() => {
      expect(stateOf(step)).toBe('done');
    });
    expect(nameReads.length).toBeGreaterThan(reads);
    await waitFor(() => {
      expect(chainReads.length).toBeGreaterThan(0);
    });
  });

  it('reads nothing without an RPC URL, and asks for one', () => {
    nameAnswer = () => passed();
    open(1000, { ...saved, rpcUrl: '' }, `/name/${name}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Not connected to the public record.');
    expect(nameReads).toEqual([]);
    expect(chainReads).toEqual([]);
  });

  it('opens a name someone types, as typed', async () => {
    const world = await buildWorld();
    arrange(world);
    nameAnswer = () => passed();
    open(1000, { examId: '' });
    expect(screen.getByText(/a name such as jee-main-2026\.board\.eth/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Exam ID or name/), { target: { value: ` ${name} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Open this exam' }));
    await findStep(/^1\. Name$/);
    expect(nameReads[0]?.name).toBe(name);
    fireEvent.change(screen.getByLabelText(/^Exam ID or name/), { target: { value: 'Maths-2026.Board.eth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open this exam' }));
    await waitFor(() => {
      expect(nameReads.at(-1)?.name).toBe('Maths-2026.Board.eth');
    });
  });
});
