// @vitest-environment jsdom
import type { ExamNameCheck, ExamNameResult, PasskeyNameResult, PasskeyNameState, ResolvedExamName } from '@paperseal/chain';
import { decodeApprovedList, fromHex, passkeyRecordValue, toHex, type Hex } from '@paperseal/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { teeStorageBucket } from './env';
import { VerifierPage } from './page';
import { buildWorld, examId, offlineQuicknet, registryAddress, registryMatches, signedReleaseLog, type World } from '@paperseal/verify/fixtures';
import type { ArkivSource } from './load';
import { SettingsProvider, type Settings } from './settings';

let chainData: unknown;
/** Every registry and exam the page set out to read, in order. */
let chainReads: { registry: string; examId: unknown }[] = [];

// The chain is the one thing these tests stub whole: everything read from it is built with real encodings.
// The checks live in @paperseal/verify. Mocking its source files reaches the package's own imports too.
vi.mock('../../../packages/verify/src/checks', async (original) => ({
  ...(await original<typeof import('../../../packages/verify/src/checks')>()),
  loadChain: (registry: { address: string } | null, id: unknown) => {
    if (!registry || !id) return null;
    chainReads.push({ registry: registry.address, examId: id });
    return () => Promise.resolve(chainData);
  },
}));

/** What reading a party name against its key comes to. Null runs the real read, which needs an RPC. */
let passkeyAnswer: ((name: string, key: Hex) => PasskeyNameState) | null = null;
let passkeyReads: { name: string; key: Hex; rpcUrl: string | undefined }[] = [];

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
    checkPasskeyName: (name: string, key: Hex, options: { rpcUrl?: string }): Promise<PasskeyNameResult> => {
      passkeyReads.push({ name, key, rpcUrl: options.rpcUrl });
      if (!passkeyAnswer) return real.checkPasskeyName(name, key, options);
      const state = passkeyAnswer(name, key);
      return Promise.resolve({ state, name, expected: passkeyRecordValue(key), reason: state });
    },
  };
});

/** The Arkiv reader the page gets, and the options it asked for one with. */
let arkivReader: ArkivSource | null = null;
let arkivReaders: { rpcUrl?: string }[] = [];
vi.mock('@paperseal/arkiv', async (original) => {
  const real = await original<typeof import('@paperseal/arkiv')>();
  return {
    ...real,
    createArkivReader: (options: { rpcUrl?: string }) => {
      arkivReaders.push(options);
      if (!arkivReader) throw new Error('no Arkiv reader in this test');
      return arkivReader;
    },
  };
});

/** The bucket each record and fresh token was checked against. */
let buckets: (string | undefined)[] = [];

/** Whether `release-token.jwt` counts as verified. The test PKI does not lead to Google's root, so by default it does not. */
let tokenVerified = false;
/** What a fresh attestation from the live TEE comes to. */
let freshTrusted = false;
vi.mock('../../../packages/verify/src/attest', async (original) => {
  const real = await original<typeof import('../../../packages/verify/src/attest')>();
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
  arkivRpcUrl: 'https://arkiv.example',
  arkivWriters: '',
  swarmApiUrl: 'http://bee.example:1633',
};

function arrange(world: World, files: Record<string, Uint8Array> = {}) {
  chainData = {
    registryCode: registryMatches,
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
  passkeyAnswer = null;
  passkeyReads = [];
  buckets = [];
  arkivReader = null;
  arkivReaders = [];
});

describe('one page', () => {
  it('has one chain of custody with seven steps, and no tabs or sign-in', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    await findStep(/^1\. Exam published$/);
    expect(screen.getByRole('list', { name: 'Steps for this exam' }).children).toHaveLength(7);
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
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This page cannot read the public record yet.');
    expect(screen.queryByText('Pass')).toBeNull();
  });

  it('keeps the connection settings at the foot, saying anyone can host their own', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const heading = await screen.findByRole('heading', { name: 'Check it yourself' });
    const section = heading.closest('section') as HTMLElement;
    expect(section.textContent).toMatch(/host your own copy/);
    expect(within(section).getByText('Live machine address (optional)')).toBeTruthy();
    const steps = screen.getByRole('list', { name: 'Steps for this exam' });
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
    expect(screen.getByText('This link does not hold a valid exam ID. Ask your exam board for the right one.')).toBeTruthy();
  });

  it('opens an exam someone types in, and refuses anything else', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000, { examId: '' });
    fireEvent.change(screen.getByLabelText(/Exam ID/), { target: { value: 'nonsense' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open this exam' }));
    expect(screen.getByText('Enter an exam ID: 0x followed by 64 letters or digits.')).toBeTruthy();
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
    const step = await findStep(/^2\. Paper Seal runs the published code$/);
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
    expect(alarm.textContent).toMatch(/does not match its fingerprint/);
    expect(alarm.textContent).not.toMatch(/listHash/);
    const step = stepNamed(/^3\. People approved$/);
    expect(stateOf(step)).toBe('failed');
    expect(step.querySelector('.ps-step-note')?.textContent).toMatch(/does not match its fingerprint/);
    expect(step.textContent).toMatch(/do not hash to the on-chain listHash/);
    // The top of the page comes before the headline.
    expect(alarm.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('do not appear for missing data', async () => {
    const world = await buildWorld();
    arrange(world);
    chainData = { registryCode: registryMatches, exam: world.exam, list: null, build: null, criteria: world.criteriaHex, entries: null };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))));
    open(1);
    await findStep(/^3\. People approved$/);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Setting up. The list of approved people is not published yet.');
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
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    expect(await within(step).findByText('8 of 8 needed (not verified)')).toBeTruthy();
    const released = within(step).getAllByText('Released');
    expect(released).toHaveLength(8);
    for (const badge of released) expect(badge.getAttribute('data-tone')).toBe('neutral');
    const warning = within(step).getByText(/nothing says who signed this/);
    const rows = within(step).getByText('Key holders released').closest('ul');
    expect(warning.compareDocumentPosition(rows ?? warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows progress as evidence once release-token.jwt verifies', async () => {
    tokenVerified = true;
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    expect(await within(step).findByText('8 of 8 needed')).toBeTruthy();
    const released = within(step).getAllByText('Released');
    for (const badge of released) expect(badge.getAttribute('data-tone')).toBe('ok');
    expect(within(step).getAllByText('Not released yet')).toHaveLength(2);
    expect(within(step).queryByText(/nothing says who signed this/)).toBeNull();
    expect(stateOf(step)).toBe('done');
  });

  it('has a countdown with the round in its evidence', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    expect(await within(step).findByRole('timer')).toBeTruthy();
    expect(within(step).getByText('Paper unlocks for centres, round 200')).toBeTruthy();
  });

  it('is neutral when no log is published yet', async () => {
    const world = await buildWorld();
    arrange(world);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))));
    open(1000);
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    await within(step).findByText(/release-log.json is not in storage yet/);
    expect(within(step).queryByText('Fail')).toBeNull();
  });

  it('shows each key file from a verified log as a check', async () => {
    tokenVerified = true;
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    await within(step).findByText('Lists the key file and one copy for each centre on the approved list', {}, { timeout: 5000 });
    expect(within(step).getByText('key-priv.tlock')).toBeTruthy();
    expect(within(step).getByText('recipient approved-centre.paperseal-demo.eth')).toBeTruthy();
  });

  it('raises the alarm when a verified log lists a centre copy that was swapped', async () => {
    tokenVerified = true;
    const world = await buildWorld();
    const name = world.releaseLog.files.find((file) => file.name.startsWith('key-priv/'))?.name ?? '';
    arrange(world, { [name]: new Uint8Array(120) });
    open(1000);
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/The copy of the key for .* was changed after it was recorded/);
    expect(stateOf(step)).toBe('failed');
  });

  it('checks no key file until the log has passed', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    await within(step).findByText('Not checked until the log and its proof pass', {}, { timeout: 5000 });
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
      const step = await findStep(/^6\. Paper unlocks for centres$/);
      await within(step).findByText('Live from the machine, optional');
      return step;
    }

    it('is neutral, with the warning above the rows, when the fresh attestation is not trusted', async () => {
      const step = await openLive(false);
      const warning = await within(step).findByText(/has not passed its check/);
      expect(within(step).getByText('unlock (not verified)')).toBeTruthy();
      const rows = within(step).getByText('unlock (not verified)').closest('ul');
      expect(warning.compareDocumentPosition(rows ?? warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows progress as evidence when the fresh attestation is trusted', async () => {
      const step = await openLive(true);
      await within(step).findByText('The machine passed its check, so its answers can be trusted');
      expect(within(step).getByText('unlock')).toBeTruthy();
      expect(within(step).queryByText(/has not passed its check/)).toBeNull();
    });
  });
});

describe('step 6, the copy on Arkiv', () => {
  const writer = '0x1111111111111111111111111111111111111111';
  const latest = () => ({ number: 10_000n, time: Math.floor(Date.now() / 1000) });

  /** A world with no release log in storage and a live machine that does not answer. */
  async function silentBoard() {
    const world = await buildWorld({ endRound: 99_999_999 });
    const token = world.files.get('release-token.jwt');
    if (!token) throw new Error('no release token');
    world.files.delete('release-log.json');
    world.files.delete('release-token.jwt');
    arrange(world);
    const storageFetch = vi.mocked(fetch).getMockImplementation() as (i: string | URL | Request) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) =>
        String(input).startsWith('https://tee.example/') ? Promise.reject(new TypeError('fetch failed')) : storageFetch(input),
      ),
    );
    return { world, token };
  }

  const row = (n: number, body: Uint8Array) => ({
    entityKey: `0x${n.toString(16).padStart(64, '0')}` as const,
    creator: writer as `0x${string}`,
    createdAtBlock: 9_995n,
    examId,
    registry: registryAddress,
    body,
  });

  it('is off with no writers, and reads nothing from Arkiv', async () => {
    const releaseRows = vi.fn();
    arkivReader = { releaseRows, latestBlock: vi.fn() } as never;
    const world = await buildWorld({ endRound: 99_999_999 });
    arrange(world);
    open(1000);
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    await within(step).findByText(/^Add who may write the copy on Arkiv/);
    expect(arkivReaders).toEqual([]);
    expect(releaseRows).not.toHaveBeenCalled();
  });

  it('keeps showing progress from Arkiv when the live machine goes silent', async () => {
    tokenVerified = true;
    const { world, token } = await silentBoard();
    const log = await signedReleaseLog(world, 5);
    const releaseRows = vi.fn(() =>
      Promise.resolve({
        tokens: [{ ...row(1, token), instanceKeyHash: '0x' }],
        logs: [{ ...row(2, new TextEncoder().encode(JSON.stringify(log))), entriesHash: log.entriesHash }],
        heartbeats: [],
      }),
    );
    arkivReader = { releaseRows, latestBlock: () => Promise.resolve(latest()) };
    open(1000, { teeUrl: 'https://tee.example', arkivWriters: writer, arkivRpcUrl: 'https://arkiv.example/rpc' });
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    await within(step).findByText('Unlocked. 5 of the 8 needed key holders have released.', { exact: false }, { timeout: 5000 });
    expect(within(step).getByText(/^Read from the copy on Arkiv/)).toBeTruthy();
    expect(within(step).getByText('The copy on Arkiv')).toBeTruthy();
    expect(within(step).getByText('Open this row in the Arkiv explorer')).toBeTruthy();
    expect(stateOf(step)).toBe('current');
    // token.jwt never traces back to Google's root in these tests, so only step 6 is looked at.
    expect(screen.queryByRole('alert')?.textContent ?? '').not.toMatch(/Step 6/);
    expect(arkivReaders).toEqual([{ rpcUrl: 'https://arkiv.example/rpc' }]);
    expect(releaseRows).toHaveBeenCalledWith(examId, [writer], { registry: registryAddress });
  });

  it('is neutral when Arkiv cannot be read', async () => {
    await silentBoard();
    arkivReader = { releaseRows: () => Promise.reject(new Error('rate limited')), latestBlock: () => Promise.resolve(latest()) };
    open(1000, { arkivWriters: writer });
    const step = await findStep(/^6\. Paper unlocks for centres$/);
    await within(step).findByText(/Could not be read: rate limited/, {}, { timeout: 5000 });
    expect(stateOf(step)).not.toBe('failed');
    // token.jwt never traces back to Google's root in these tests, so only step 6 is looked at.
    expect(screen.queryByRole('alert')?.textContent ?? '').not.toMatch(/Step 6/);
  });

  it('refuses a writer that is not an address in "Check it yourself"', async () => {
    const world = await buildWorld({ endRound: 99_999_999 });
    arrange(world);
    open(1000);
    fireEvent.change(await screen.findByLabelText(/^Who may write the copy on Arkiv/), { target: { value: '0x1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Enter each address as 0x followed by 40 letters or digits/)).toBeTruthy();
    expect(arkivReaders).toEqual([]);
  });
});

describe('the backup on Swarm', () => {
  const writer = '0x1111111111111111111111111111111111111111';
  const swarmRef = 'ab'.repeat(32);
  const entityKey = `0x${'0e'.repeat(32)}` as const;
  const bee = 'http://bee.example:1633';

  /** The bucket, empty or as built, a Swarm node with the world's files or none, and one backup row on Arkiv. */
  function arrangeBackup(world: World, options: { bucket: 'empty' | 'full'; swarm: 'up' | 'down'; backupFiles?: Record<string, Uint8Array> }) {
    arrange(world);
    const storageFetch = vi.mocked(fetch).getMockImplementation() as (i: string | URL | Request) => Promise<Response>;
    const swarmReads: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith(`${bee}/`)) {
          swarmReads.push(url);
          if (options.swarm === 'down') return Promise.reject(new TypeError('fetch failed'));
          const name = decodeURIComponent(url.replace(`${bee}/bzz/${swarmRef}/`, ''));
          const bytes = options.backupFiles?.[name] ?? world.files.get(name);
          return Promise.resolve(bytes ? new Response(new Uint8Array(bytes)) : new Response('no', { status: 404 }));
        }
        return options.bucket === 'empty' ? Promise.resolve(new Response('no', { status: 404 })) : storageFetch(input);
      }),
    );
    const backupRows = vi.fn(() =>
      Promise.resolve([
        {
          entityKey,
          creator: writer,
          createdAtBlock: 9_000n,
          examId,
          registry: registryAddress,
          phase: 'unlock',
          swarmRef,
          swarmNetwork: 'sepolia',
          manifestHash: world.build.storageManifestHash,
          files: world.files.size,
          batchId: 'cd'.repeat(32),
        },
      ]),
    );
    arkivReader = {
      releaseRows: () => Promise.resolve({ logs: [], tokens: [], heartbeats: [] }),
      latestBlock: () => Promise.resolve({ number: 10_000n, time: Math.floor(Date.now() / 1000) }),
      backupRows,
    } as never;
    return { swarmReads, backupRows };
  }

  it('opens the paper from the backup when the bucket is empty, and says which files came from it', async () => {
    const world = await buildWorld();
    const { backupRows } = arrangeBackup(world, { bucket: 'empty', swarm: 'up' });
    open(1000, { arkivWriters: writer });
    expect(await screen.findByText('Differentiate x squared.', {}, { timeout: 5000 })).toBeTruthy();
    const step = stepNamed(/^7\. Paper opens to everyone$/);
    expect(stateOf(step)).toBe('done');
    expect(within(step).getByText('Backup on Swarm')).toBeTruthy();
    for (const name of ['paper.bin', 'key-pub.tlock']) {
      const row = within(step).getByText(name).closest('li') as HTMLElement;
      expect(row.textContent).toMatch(/From the Swarm backup, checked against the exam's on-chain record\. The public files do not have it\./);
      expect(within(step).getByText(`Open ${name} on Swarm`).getAttribute('href')).toBe(`${bee}/bzz/${swarmRef}/${name}`);
    }
    expect((within(step).getByText('key-priv.tlock').closest('li') as HTMLElement).textContent).toMatch(/From the Swarm backup\./);
    expect(within(step).getByLabelText(`Copy Swarm reference: ${swarmRef}`)).toBeTruthy();
    expect(within(step).getByLabelText(`Copy Arkiv entity key of the backup row: ${entityKey}`)).toBeTruthy();
    expect(within(step).getByText('Open the backup row in the Arkiv explorer').getAttribute('href')).toMatch(new RegExp(`/entity/${entityKey}$`));
    expect(within(step).queryByText('Fail')).toBeNull();

    const sealed = stepNamed(/^5\. Paper built and sealed$/);
    await within(sealed).findByText('Backup on Swarm');
    expect((within(sealed).getAllByText('manifest.json')[0]?.closest('li') as HTMLElement).textContent).toMatch(/From the Swarm backup/);
    expect((within(sealed).getByText(/^Manifest hash matches/).closest('li') as HTMLElement).textContent).toMatch(/Pass/);
    // The test token does not lead to Google's root, so no token attests the backup's release log,
    // and it is not used. It is only "not read", never a failure.
    const unlock = stepNamed(/^6\. Paper unlocks for centres$/);
    expect(within(unlock).queryByText('Open release-log.json on Swarm')).toBeNull();
    expect(within(unlock).getByText(/^Not read from the Swarm backup\. 1 copy in the backup did not pass the checks in this step/)).toBeTruthy();
    expect(stateOf(unlock)).not.toBe('failed');
    expect(backupRows).toHaveBeenCalledWith(examId, [writer], { registry: registryAddress });
  });

  it('uses the backup release log once its token attests the key that signed it', async () => {
    tokenVerified = true;
    const world = await buildWorld();
    arrangeBackup(world, { bucket: 'empty', swarm: 'up' });
    open(1000, { arkivWriters: writer });
    const unlock = await findStep(/^6\. Paper unlocks for centres$/);
    expect(await within(unlock).findByText('Open release-log.json on Swarm', {}, { timeout: 5000 })).toBeTruthy();
    expect(within(unlock).getByText('Open release-token.jwt on Swarm')).toBeTruthy();
    expect(within(unlock).queryByText(/did not pass the checks in this step/)).toBeNull();
  });

  it('is neutral, and says the backup was not read, when Swarm does not answer', async () => {
    const world = await buildWorld();
    arrangeBackup(world, { bucket: 'empty', swarm: 'down' });
    open(1000, { arkivWriters: writer });
    const step = await findStep(/^5\. Paper built and sealed$/);
    await within(step).findByText(/^Not read from the Swarm backup\. The backup could not be read/, {}, { timeout: 5000 });
    expect(stateOf(step)).not.toBe('failed');
    const open7 = stepNamed(/^7\. Paper opens to everyone$/);
    await within(open7).findAllByText(/^Not read from the Swarm backup/);
    expect(stateOf(open7)).not.toBe('failed');
    expect(screen.queryByRole('alert')?.textContent ?? '').not.toMatch(/Step [567]/);
  });

  it('ignores a backup key-priv.tlock that does not open the paper, without failing or warning', async () => {
    const world = await buildWorld();
    arrangeBackup(world, { bucket: 'empty', swarm: 'up', backupFiles: { 'key-priv.tlock': new TextEncoder().encode('junk') } });
    open(1000, { arkivWriters: writer });
    const step = await findStep(/^7\. Paper opens to everyone$/);
    await within(step).findByText(/^Not read from the Swarm backup\. 1 copy in the backup did not pass the checks in this step/, {}, { timeout: 5000 });
    expect(within(step).getByText(new RegExp(`^A copy in the Swarm backup ${swarmRef} did not pass the checks in this step, so it was not used\\.`))).toBeTruthy();
    expect(stateOf(step)).not.toBe('failed');
    expect(within(step).queryByText('Fail')).toBeNull();
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
    expect(screen.queryByRole('alert')?.textContent ?? '').not.toMatch(/Step 7/);
  });

  it('reads no backup without writers, or with no Swarm API', async () => {
    const world = await buildWorld();
    const first = arrangeBackup(world, { bucket: 'empty', swarm: 'up' });
    const view = open(1000);
    await within(await findStep(/^5\. Paper built and sealed$/)).findByText(/manifest.json is not in storage yet/);
    view.unmount();
    expect(first.backupRows).not.toHaveBeenCalled();
    expect(first.swarmReads).toEqual([]);

    const second = arrangeBackup(world, { bucket: 'empty', swarm: 'up' });
    open(1000, { arkivWriters: writer, swarmApiUrl: '' });
    await within(await findStep(/^5\. Paper built and sealed$/)).findByText(/manifest.json is not in storage yet/);
    expect(second.backupRows).not.toHaveBeenCalled();
    expect(second.swarmReads).toEqual([]);
  });

  it('reads nothing from Swarm while the bucket works', async () => {
    const world = await buildWorld();
    const { swarmReads, backupRows } = arrangeBackup(world, { bucket: 'full', swarm: 'up' });
    open(1000, { arkivWriters: writer });
    expect(await screen.findByText('Differentiate x squared.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Backup on Swarm')).toBeNull();
    expect(backupRows).not.toHaveBeenCalled();
    expect(swarmReads).toEqual([]);
  });

  it('can be pointed at another Swarm API, or turned off, under "Check it yourself"', async () => {
    const world = await buildWorld();
    arrange(world);
    open(1000);
    const field = await screen.findByLabelText(/^Where to read the backup on Swarm/);
    expect((field as HTMLInputElement).value).toBe(bee);
    fireEvent.change(field, { target: { value: 'bzz://nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findAllByText('Enter a web address that starts with http:// or https://.')).toHaveLength(1);
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
    const step = stepNamed(/^7\. Paper opens to everyone$/);
    expect(within(step).getAllByText('Pass')).toHaveLength(7);
    expect(within(step).queryByText('Fail')).toBeNull();
    expect(stateOf(step)).toBe('done');
    expect(document.querySelector('.ps-seal')?.getAttribute('data-state')).toBe('open');
  });

  it('withholds a paper that does not match the Build and fails loudly', async () => {
    const world = await buildWorld({ wrongSaltedHash: true });
    arrange(world);
    open(1000);
    const step = await findStep(/^7\. Paper opens to everyone$/);
    await within(step).findByText('Paper withheld', {}, { timeout: 5000 });
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
    expect(stateOf(step)).toBe('failed');
    expect(screen.getByRole('alert').textContent).toMatch(/not the paper recorded for this exam/);
  });

  it('says no copy exists when the unlock never happened', async () => {
    const world = await buildWorld({ unlocked: false });
    arrange(world);
    open(1000);
    const step = await findStep(/^7\. Paper opens to everyone$/);
    await within(step).findByText(/The paper cannot be opened/, { selector: '.ps-step-note' }, { timeout: 5000 });
    expect(stateOf(step)).toBe('not-applicable');
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
  });

  it('fails, and does not say sealed, when a verified log lists a deleted key-priv.tlock', async () => {
    tokenVerified = true;
    const world = await buildWorld();
    world.files.delete('key-priv.tlock');
    arrange(world);
    open(1000);
    const step = await findStep(/^7\. Paper opens to everyone$/);
    await waitFor(() => {
      expect(stateOf(step)).toBe('failed');
    }, { timeout: 5000 });
    expect(screen.getByRole('alert').textContent).toMatch(/was removed from the public files after the unlock recorded it/);
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
    expect(document.body.textContent).not.toMatch(/never unlocked/);
  });

  it('fails, and shows no paper, when a verified log lists a different key-priv.tlock', async () => {
    tokenVerified = true;
    const world = await buildWorld();
    arrange(world, { 'key-priv.tlock': new TextEncoder().encode(await world.seal(world.kPriv)) });
    open(1000);
    const step = await findStep(/^7\. Paper opens to everyone$/);
    await waitFor(() => {
      expect(stateOf(step)).toBe('failed');
    }, { timeout: 5000 });
    expect(screen.getByRole('alert').textContent).toMatch(/was changed after the unlock recorded it/);
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
  });

  it('stays sealed when the log naming key-priv.tlock has not passed its checks', async () => {
    const world = await buildWorld();
    world.files.delete('key-priv.tlock');
    arrange(world);
    open(1000);
    const step = await findStep(/^7\. Paper opens to everyone$/);
    await within(step).findByText(/The paper cannot be opened/, { selector: '.ps-step-note' }, { timeout: 5000 });
    expect(stateOf(step)).toBe('not-applicable');
  });

  it('says when the paper opens before the end round, and shows no paper', async () => {
    const world = await buildWorld({ endRound: 99_999_999 });
    arrange(world);
    open(1000);
    const step = await findStep(/^7\. Paper opens to everyone$/);
    expect(await within(step).findByText(/opens when the public clock reaches round 99999999/)).toBeTruthy();
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
    value: { name, label: 'jee-main-2026', parent: 'board.eth', examId, registry: registryAddress, board, teeUrl: null, storageUrl: null, bucket: null, arkivWriters: null, arkivWritersIgnored: [], ...over },
  });
  const failed = (check: ExamNameCheck): ExamNameResult => ({ ok: false, failed: check, reason: 'The record says otherwise.', partial: { name } });
  const noteOf = (step: HTMLElement) => step.querySelector('.ps-step-note')?.textContent ?? '';

  it('warns on the main view when the name leads to another registry than the one set up', async () => {
    arrange(await buildWorld());
    nameAnswer = () => passed();
    open(1000, saved, `/name/${name}`);
    await waitFor(() => {
      expect(document.querySelector('.vf-warnings')?.textContent).toMatch(/This name leads to a different exam record/);
    });
    expect(noteOf(await findStep(/^1\. Name$/))).toMatch(/On Sepolia, a test network/);
  });

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
    expect(screen.getByRole('list', { name: 'Steps for this exam' }).children).toHaveLength(8);
    await findStep(/^2\. Exam published$/);
    expect(chainReads.length).toBeGreaterThan(0);
    expect(chainReads.every((read) => read.registry === registryAddress && read.examId === examId)).toBe(true);
    expect(noteOf(step)).toMatch(/belongs to the exam board/);
    expect(within(step).getByText(/a Sepolia name|On Sepolia/)).toBeTruthy();
    expect(within(step).getByText('board.eth')).toBeTruthy();
    expect(within(step).getAllByText('From your settings')).toHaveLength(2);
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

  describe('Arkiv writers', () => {
    const fromName = getAddress(`0x${'a1'.repeat(20)}`);
    const both = getAddress(`0x${'b2'.repeat(20)}`);
    const own = getAddress(`0x${'c3'.repeat(20)}`);
    const quiet = () => {
      const releaseRows = vi.fn(() => Promise.resolve({ logs: [], tokens: [], heartbeats: [] }));
      arkivReader = { releaseRows, latestBlock: () => Promise.resolve({ number: 10_000n, time: 1_900_000_000 }) };
      return releaseRows;
    };

    it("reads the name's writers with the viewer's own, once each, and says where each came from", async () => {
      const world = await buildWorld({ endRound: 99_999_999 });
      arrange(world);
      const releaseRows = quiet();
      nameAnswer = () => passed({ arkivWriters: [fromName, both], arkivWritersIgnored: ['not-a-writer'] });
      open(1000, { ...saved, arkivWriters: `${both.toLowerCase()}, ${own.toLowerCase()}` }, `/name/${name}`);
      const step = await findStep(/^7\. Paper unlocks for centres$/);
      await waitFor(() => {
        expect(releaseRows).toHaveBeenCalledWith(examId, [fromName, both, own], { registry: registryAddress });
      });
      await within(step).findByText(fromName, { exact: false }, { timeout: 5000 });
      expect(within(step).getByText('From the name')).toBeTruthy();
      expect(within(step).getByText('From the name and your own choice')).toBeTruthy();
      expect(within(step).getByText('Your own choice')).toBeTruthy();
      expect(within(step).getByText(/^The exam's name also lists not-a-writer\. It is not an address/)).toBeTruthy();
      // release-token.jwt never traces back to Google's root here, so only Arkiv is looked at.
      expect(screen.queryByRole('alert')?.textContent ?? '').not.toMatch(/Arkiv|relay|writer/i);
    });

    it("reads the name's writers on the viewer's own Arkiv node when the viewer has none", async () => {
      const world = await buildWorld({ endRound: 99_999_999 });
      arrange(world);
      const releaseRows = quiet();
      nameAnswer = () => passed({ arkivWriters: [fromName] });
      open(1000, saved, `/name/${name}`);
      await waitFor(() => {
        expect(releaseRows).toHaveBeenCalledWith(examId, [fromName], { registry: registryAddress });
      });
      expect(arkivReaders).toEqual([{ rpcUrl: settings.arkivRpcUrl }]);
    });
  });

  it.each([
    ['name', 'Not a valid name'],
    ['registry', 'No exam record'],
    ['primaryName', 'Not the board’s name'],
    ['forward', 'Not confirmed by the board'],
  ] as [ExamNameCheck, string][])('a failed %s check fails the Name step, stops the rest and shows no seal', async (check, title) => {
    const world = await buildWorld();
    arrange(world);
    nameAnswer = () => failed(check);
    open(1000, saved, `/name/${name}`);
    const step = await findStep(/^1\. Name$/);
    await waitFor(() => {
      expect(stateOf(step)).toBe('failed');
    });
    expect(noteOf(step)).toContain(`${title}. `);
    expect(noteOf(step)).not.toContain('The record says otherwise');
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
    expect(noteOf(step)).toMatch(/Not a valid name\. Check how the name is spelled/);
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
      expect(noteOf(step)).toMatch(/^Can't read the name\./);
    });
    expect(stateOf(step)).toBe('current');
    // token.jwt never traces back to Google's root in these tests, so only step 6 is looked at.
    expect(screen.queryByRole('alert')?.textContent ?? '').not.toMatch(/Step 6/);
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
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This page cannot read the public record yet.');
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

describe('party names', () => {
  const ownerOf = (name: string) =>
    name === 'Neutral 1' ? 'asha.eth' : name === 'Neutral 2' ? 'ben.eth' : name === 'Centre 1' ? 'north.centres.maths-board.eth' : name;
  const peopleOf = (world: World) => decodeApprovedList(fromHex(world.entriesHex));
  const keyOf = (world: World, owner: string) => toHex(peopleOf(world).find((entry) => entry.owner === owner)?.passkeyPublicKey ?? new Uint8Array());
  const rowFor = (step: HTMLElement, owner: string) => within(step).getByText(owner).closest('li') as HTMLElement;

  async function opened(answer: (world: World) => (name: string, key: Hex) => PasskeyNameState) {
    const world = await buildWorld({ ownerOf });
    arrange(world);
    passkeyAnswer = answer(world);
    open(1000);
    return { world, step: await findStep(/^3\. People approved$/) };
  }

  it('shows "Name confirmed" for a key holder whose record matches, and reads with the viewer own RPC', async () => {
    const { step } = await opened(() => () => 'confirmed');
    await waitFor(() => {
      expect(within(rowFor(step, 'asha.eth')).getByText('Name confirmed')).toBeTruthy();
    });
    expect(passkeyReads.length).toBeGreaterThan(0);
    expect(passkeyReads.every((read) => read.rpcUrl === settings.rpcUrl)).toBe(true);
    expect(screen.getByRole('alert').textContent).not.toMatch(/Step\s*3/);
  });

  it('reads only names, never a setter or a plain name', async () => {
    const { world } = await opened(() => () => 'confirmed');
    await waitFor(() => {
      expect(passkeyReads.length).toBe(3);
    });
    expect(passkeyReads.map((read) => read.name).sort()).toEqual(['asha.eth', 'ben.eth', 'north.centres.maths-board.eth']);
    const setterKey = toHex(peopleOf(world).find((entry) => entry.role === 1)?.passkeyPublicKey ?? new Uint8Array());
    expect(passkeyReads.some((read) => read.key === setterKey)).toBe(false);
  });

  it('says "Not confirmed" in plain words for a missing or wrong record, and never fails the exam', async () => {
    const { step } = await opened((w) => (_name, key) => (key === keyOf(w, 'asha.eth') ? 'mismatch' : 'missing'));
    expect(await within(step).findByText('The record on asha.eth names a different security key.')).toBeTruthy();
    expect(within(rowFor(step, 'asha.eth')).getByText('Not confirmed')).toBeTruthy();
    expect(within(step).getByText('ben.eth has no record for this security key yet.')).toBeTruthy();
    // The two failures on this page are the test PKI's, in steps 2 and 6. Step 3 has none.
    expect(step.querySelector('.vf-step-failures')).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toMatch(/Step\s*3/);
    expect(stateOf(step)).toBe('done');
  });

  it('treats a name that could not be read as not confirmed, and still passes the step', async () => {
    const { step } = await opened(() => () => 'unreadable');
    expect(await within(step).findByText('asha.eth could not be read just now.')).toBeTruthy();
    expect(within(step).getAllByText('Not confirmed').length).toBe(2);
    expect(stateOf(step)).toBe('done');
    expect(screen.getByRole('alert').textContent).not.toMatch(/Step\s*3/);
  });

  it('shows a centre name as a label that proves nothing about independence', async () => {
    const { step } = await opened(() => () => 'missing');
    expect(await within(step).findByText(/It does not show that the centre is independent/)).toBeTruthy();
    expect(within(rowFor(step, 'north.centres.maths-board.eth')).getByText('Label only')).toBeTruthy();
    expect(within(rowFor(step, 'north.centres.maths-board.eth')).queryByText('Not confirmed')).toBeNull();
    expect(within(step).getByText(/Whoever controls centres\.maths-board\.eth vouches for the names under it/)).toBeTruthy();
    expect(within(step).getByText(/, and whoever controls centres\.maths-board\.eth vouches for it/)).toBeTruthy();
  });

  it('keeps the evidence folded, and says Sepolia names prove nothing', async () => {
    const { step } = await opened(() => () => 'confirmed');
    await waitFor(() => {
      expect(within(step).getAllByText('Name confirmed').length).toBe(3);
    });
    expect(within(step).getByText(/anyone can register a similar name/)).toBeTruthy();
    expect(step.querySelector('details')?.contains(within(step).getAllByText('Name confirmed')[0] as HTMLElement)).toBe(true);
  });

  it('reads nothing, and says "Not an ENS name" as a warning and not a failure, when no party has an ENS name', async () => {
    // An older exam, or a board that skipped the app: the contract does not check the owner.
    const world = await buildWorld({ ownerOf: (name) => name });
    arrange(world);
    open(1000);
    const step = await findStep(/^3\. People approved$/);
    await within(step).findByText('Neutral 1');
    expect(within(rowFor(step, 'Neutral 1')).getByText('Not an ENS name')).toBeTruthy();
    expect(passkeyReads).toEqual([]);
    expect(within(step).queryByText('Name confirmed')).toBeNull();
    expect(within(step).queryByText('Not confirmed')).toBeNull();
    expect(step.querySelector('.vf-step-failures')).toBeNull();
    expect(stateOf(step)).toBe('done');
    expect(document.querySelector('.vf-warnings')?.textContent).toMatch(/11 key holders or centres on the list are not named by an ENS name/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/Step\s*3/);
  });
});
