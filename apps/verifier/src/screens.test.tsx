// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { buildWorld, examId, offlineQuicknet, registryAddress, setterName, setterSalt, type World } from './fixtures';
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

  it('Commitments shows the setter as sealed, then Pass or Fail per published name', async () => {
    const world = await buildWorld();
    arrange(world);
    open('/commitments', 1000);
    expect(await screen.findByText('Setter (sealed)')).toBeTruthy();
    expect(screen.queryByText(setterName)).toBeNull();
    expect(screen.getByText(/only works after the board publishes/)).toBeTruthy();
    const box = await screen.findByPlaceholderText(/"salt"/);
    const check = () => fireEvent.click(screen.getByRole('button', { name: 'Check against the list' }));

    fireEvent.change(box, { target: { value: JSON.stringify([{ name: 'Not A Setter', salt: setterSalt }]) } });
    check();
    expect(await screen.findByText(/is not a setter on the chain list/)).toBeTruthy();

    fireEvent.change(box, { target: { value: JSON.stringify([{ name: setterName, salt: setterSalt }]) } });
    check();
    await waitFor(() => expect(screen.queryByText(/is not a setter on the chain list/)).toBeNull());
    expect(screen.getByText(setterName)).toBeTruthy();

    fireEvent.change(box, { target: { value: 'not json' } });
    check();
    expect(await screen.findByText('This is not JSON.')).toBeTruthy();
  });

  it('Commitments is neutral, not failing, when the manifest is not published', async () => {
    const world = await buildWorld();
    arrange(world);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 404 }))));
    open('/commitments', 1000);
    expect(await screen.findByText(/manifest.json is not in storage yet/)).toBeTruthy();
  });

  it('Unlock shows holders released from the verified published log', async () => {
    const world = await buildWorld();
    arrange(world);
    open('/unlock', 1000);
    expect(await screen.findByText('8 of 8 needed')).toBeTruthy();
    expect(screen.getAllByText('Released')).toHaveLength(8);
    expect(screen.getAllByText('Not released')).toHaveLength(2);
    expect(screen.getByText('Round clock')).toBeTruthy();
    expect(await screen.findAllByText('Published')).toHaveLength(3);
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
