// @vitest-environment jsdom
import { decodeApprovedList, fromHex, setterOwner, toHex } from '@paperseal/protocol';
import { cleanup, render, within, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { buildWorld, examId, offlineQuicknet, registryAddress, type World } from './fixtures';
import { SettingsProvider, type Settings } from './settings';

let chainData: unknown;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

// The chain is the one thing these tests stub whole: everything read from it is built with real encodings.
vi.mock('./checks', async (original) => ({
  ...(await original<typeof import('./checks')>()),
  loadChain: (registry: unknown, id: unknown) => (registry && id ? () => Promise.resolve(chainData) : null),
}));

/** Whether `release-token.jwt` counts as verified. The test PKI does not lead to Google's root, so by default it does not. */
let tokenVerified = false;
/** What a fresh attestation from the live TEE comes to. */
let freshTrusted = false;
vi.mock('./attest', async (original) => {
  const real = await original<typeof import('./attest')>();
  return {
    ...real,
    checkFreshToken: () =>
      Promise.resolve({
        trusted: freshTrusted,
        signature: { ok: freshTrusted, ...(freshTrusted ? {} : { error: new Error('not Google') }) },
        instanceKey: { ok: true },
        claims: [],
        instancePublicKey: `0x04${'dd'.repeat(64)}`,
      }),
    checkRecordToken: (args: Parameters<typeof real.checkRecordToken>[0]) =>
      tokenVerified ? Promise.resolve({ verified: true, signature: { ok: true }, claims: [] }) : real.checkRecordToken(args),
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

function open(path: string, latestRound: number, over: Partial<Settings> = {}) {
  return render(
    <SettingsProvider initial={{ ...settings, ...over }} drand={offlineQuicknet(latestRound)}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </SettingsProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('screens with data', () => {
  it('Proof opens the paper after the end round and shows each check as Pass', async () => {
    const world = await buildWorld();
    arrange(world);
    open('/proof', 1000);
    expect(await screen.findByText('Differentiate x squared.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Integrate 2x.')).toBeTruthy();
    expect(screen.getAllByText('Pass')).toHaveLength(7);
    expect(screen.queryByText('Fail')).toBeNull();
  });

  it('Proof withholds a paper that does not match the Build and shows Fail', async () => {
    const world = await buildWorld({ wrongSaltedHash: true });
    arrange(world);
    open('/proof', 1000);
    expect(await screen.findByText('Paper withheld', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
    expect(screen.getAllByText('Fail').length).toBeGreaterThan(0);
  });

  it('Proof says no copy exists when the unlock never happened', async () => {
    const world = await buildWorld({ unlocked: false });
    arrange(world);
    open('/proof', 1000);
    expect(await screen.findByText(/No copy exists/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
  });

  it('Proof says when the paper opens before the end round', async () => {
    const world = await buildWorld({ endRound: 99_999_999 });
    arrange(world);
    open('/proof', 1000);
    expect(await screen.findByText(/opens when drand publishes round 99999999/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Differentiate x squared.')).toBeNull();
  });

  it('Attestation shows requireHardwareAttestation plainly, even with nothing connected', () => {
    open('/attestation', 1000, { rpcUrl: '', storageUrl: '', registryAddress: '', examId: '' });
    expect(screen.getByText('requireHardwareAttestation')).toBeTruthy();
    expect(screen.getByText('false')).toBeTruthy();
    expect(screen.getByText(/Demo mode/)).toBeTruthy();
  });

  it('Attestation checks the published token against the chain, claim by claim', async () => {
    const world = await buildWorld();
    arrange(world);
    open('/attestation', 1000);
    expect(await screen.findByText("Token signature, up to Google's root")).toBeTruthy();
    // The test PKI does not lead to Google's pinned root, so the signature must fail, and so must the whole token.
    await waitFor(() => expect(screen.getAllByText(/Fail/).length).toBeGreaterThan(0));
    expect(screen.getByText('eat_nonce')).toBeTruthy();
    expect(screen.getByText('image_digest')).toBeTruthy();
  });

  it('Commitments lists the manifest files with their hashes and checks the manifest against the Build', async () => {
    const world = await buildWorld();
    arrange(world);
    open('/commitments', 1000);
    expect(await screen.findByText('paper.bin')).toBeTruthy();
    expect(screen.getByText(must(world.manifest.files.find((f) => f.name === 'paper.bin')).sha256)).toBeTruthy();
    expect(screen.getByText(/Manifest hash matches/)).toBeTruthy();
  });

  it('Commitments shows a setter as "Setter" with the hash of its passkey, and no name or paste panel', async () => {
    const world = await buildWorld();
    arrange(world);
    open('/commitments', 1000);
    expect(await screen.findByText('Setter')).toBeTruthy();
    const setter = must(decodeApprovedList(fromHex(world.entriesHex)).find((entry) => entry.role === 1));
    // The list decoded only because the setter's owner is the hash of its own passkey.
    expect(setter.owner).toBe(setterOwner(setter.passkeyPublicKey));
    expect(screen.getByText('Setter').closest('li')?.textContent).toContain(setter.owner);
    expect(screen.queryByText(/Setter names/)).toBeNull();
    expect(screen.queryByPlaceholderText(/"salt"/)).toBeNull();
    expect(screen.queryByText(/Setter \(sealed\)/)).toBeNull();
  });

  it('Commitments is neutral, not failing, when the manifest is not published', async () => {
    const world = await buildWorld();
    arrange(world);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))));
    open('/commitments', 1000);
    expect(await screen.findByText(/manifest.json is not in storage yet/)).toBeTruthy();
  });

  it('Unlock shows progress with neutral badges, a warning above the rows and no signature check until the token passes', async () => {
    tokenVerified = false;
    const world = await buildWorld();
    arrange(world);
    open('/unlock', 1000);
    expect(await screen.findByText('8 of 8 needed (not verified)')).toBeTruthy();
    const released = screen.getAllByText('Released');
    expect(released).toHaveLength(8);
    for (const badge of released) expect(badge.getAttribute('data-tone')).toBe('neutral');
    expect(screen.getByText('Not checked')).toBeTruthy();
    const warning = screen.getByText(/nothing says which TEE signed this/);
    const rows = screen.getByText('Holders released').closest('ul');
    // The warning comes before the rows it qualifies.
    expect(warning.compareDocumentPosition(rows ?? warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Round clock')).toBeTruthy();
  });

  it('Unlock shows progress as evidence once release-token.jwt verifies', async () => {
    tokenVerified = true;
    try {
      const world = await buildWorld();
      arrange(world);
      open('/unlock', 1000);
      expect(await screen.findByText('8 of 8 needed')).toBeTruthy();
      const released = screen.getAllByText('Released');
      expect(released).toHaveLength(8);
      for (const badge of released) expect(badge.getAttribute('data-tone')).toBe('ok');
      expect(screen.getAllByText('Not released')).toHaveLength(2);
      expect(screen.queryByText(/nothing says which TEE signed this/)).toBeNull();
      expect(screen.queryByText('Not checked')).toBeNull();
    } finally {
      tokenVerified = false;
    }
  });

  describe('the live TEE release panel', () => {
    async function openLive(trusted: boolean) {
      freshTrusted = trusted;
      const world = await buildWorld();
      arrange(world);
      const holders = decodeApprovedList(fromHex(world.entriesHex)).filter((e) => e.role === 2 || e.role === 3);
      const released = holders.slice(0, 8).map((e) => toHex(e.passkeyPublicKey));
      const files = vi.mocked(fetch);
      const storageFetch = files.getMockImplementation();
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request) => {
          const url = String(input);
          if (url.startsWith('https://tee.example/v1/status')) {
            return Promise.resolve(
              new Response(JSON.stringify({ stage: 'unlock', questionCount: 3, release: { released, required: 8 } })),
            );
          }
          if (url.startsWith('https://tee.example/')) return Promise.resolve(new Response('no', { status: 404 }));
          return (storageFetch as (i: string | URL | Request) => Promise<Response>)(input);
        }),
      );
      open('/unlock', 1000, { teeUrl: 'https://tee.example' });
      return screen.findByText('Live TEE release');
    }

    it('is neutral, with the warning above the rows, when the fresh attestation is not trusted', async () => {
      await openLive(false);
      const warning = await screen.findByText(/The TEE failed attestation/);
      const panel = warning.closest('.ps-panel');
      const rows = panel?.querySelector('ul');
      expect(warning.compareDocumentPosition(rows ?? warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(panel as HTMLElement).getByText('8 of 8 needed (not verified)')).toBeTruthy();
      for (const badge of within(panel as HTMLElement).getAllByText('Released')) expect(badge.getAttribute('data-tone')).toBe('neutral');
    });

    it('shows progress as evidence when the fresh attestation is trusted', async () => {
      await openLive(true);
      const panel = (await screen.findByText('TEE attestation passes, so its answers can be trusted')).closest('.ps-panel') as HTMLElement;
      expect(within(panel).getByText('8 of 8 needed')).toBeTruthy();
      for (const badge of within(panel).getAllByText('Released')) expect(badge.getAttribute('data-tone')).toBe('ok');
      expect(within(panel).queryByText(/The TEE failed attestation/)).toBeNull();
    });
  });

  it('Overview says an on-chain list could not be read, which is not the same as no list', async () => {
    const world = await buildWorld();
    arrange(world);
    (chainData as Record<string, unknown>).entries = null;
    (chainData as Record<string, unknown>).problems = {
      list: { kind: 'unreadable', message: 'The RPC returned no ApprovedListPosted event.' },
    };
    open('/', 1000);
    expect(await screen.findByText('Approved list bytes')).toBeTruthy();
    expect(screen.getByText('Could not be read')).toBeTruthy();
    expect(screen.getByText(/returned no ApprovedListPosted event/)).toBeTruthy();
    expect(screen.queryByText('Fail')).toBeNull();
  });

  it('Overview fails an on-chain list whose bytes do not match the stored hash', async () => {
    const world = await buildWorld();
    arrange(world);
    (chainData as Record<string, unknown>).entries = null;
    (chainData as Record<string, unknown>).problems = {
      list: { kind: 'mismatch', message: 'The ApprovedListPosted bytes do not hash to the on-chain listHash.' },
    };
    open('/', 1000);
    expect(await screen.findByText('Approved list bytes')).toBeTruthy();
    expect(screen.getAllByText('Fail').length).toBeGreaterThan(0);
  });

  it('Unlock is neutral when no log is published yet', async () => {
    const world = await buildWorld();
    arrange(world);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))),
    );
    open('/unlock', 1000);
    expect(await screen.findByText(/release-log.json is not in storage yet/)).toBeTruthy();
    expect(screen.queryByText('Fail')).toBeNull();
  });
});
