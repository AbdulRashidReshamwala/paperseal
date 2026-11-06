// @vitest-environment jsdom
import { createExamRegistry, examRegistryRuntime, type EnsLookup } from '@paperseal/chain';
import { criteriaHash, encodeCriteria, ens, examIdFromName, firstRoundAtOrAfter, toHex, type Hex } from '@paperseal/protocol';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createPublicClient, HttpRequestError, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getStoredExamId } from '../../shared/currentExam';
import { useLinkedName } from '../../shared/ExamPage';
import { fakeChain } from '../../test/fakeChain';
import BoardArea from './BoardArea';
import { rememberExam } from './examsStore';
import { examPageLink } from './PeopleStep';
import { publishExam, type PublishEnvironment } from './publishFlow';

const board = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const parent = 'paperseal-demo.eth';
const label = 'initial-test-exam';
const name = `${label}.${parent}`;
const examId = examIdFromName(label);

function registryCode(forBoard: Address): Hex {
  let code: string = examRegistryRuntime.bytecode;
  const word = forBoard.slice(2).toLowerCase().padStart(64, '0');
  for (const offset of examRegistryRuntime.boardOffsets) {
    code = code.slice(0, 2 + offset * 2) + word + code.slice(2 + offset * 2 + 64);
  }
  return code as Hex;
}

/** The chain's names. `registry`: what the exam's name points to, or nothing when it has no records. */
const lookupFor = (registry: Address | null, overrides: Partial<EnsLookup> = {}): EnsLookup => ({
  address: (asked) => Promise.resolve(asked === parent ? board : registry),
  primaryName: () => Promise.resolve(parent),
  text: (asked, key) => Promise.resolve(asked === parent && key === ens.records.directory ? '[]' : null),
  code: () => Promise.resolve(registryCode(board)),
  board: () => Promise.resolve(board),
  resolver: () => Promise.resolve(null),
  ...overrides,
});

async function published(lookup: (registry: Address) => EnsLookup) {
  const node = fakeChain({ board });
  const env: PublishEnvironment = {
    registryAddress: node.registry,
    getProvider: () => node.provider,
    publicClient: createPublicClient({ chain: sepolia, transport: node.transport }),
    createRegistry: (wallet) => createExamRegistry({ address: node.registry, transport: node.transport, ...(wallet ? { wallet } : {}) }),
    ensLookup: lookup(node.registry),
  };
  const now = Math.floor(Date.now() / 1000);
  const encoded = encodeCriteria({ maxSetterPercent: 20, minBankMultiple: 4, topics: [{ name: 'Mechanics', questions: 5 }] });
  await publishExam(
    env,
    {
      examId,
      fields: { commitHash: `0x${'a'.repeat(40)}`, imageDigest: `0x${'b'.repeat(64)}`, rpcHost: 'rpc.example.org', version: 'v1.0.0', run: 'https://example.org' },
      schedule: {
        examStart: now + 7200,
        delta: 600,
        lockRound: String(firstRoundAtOrAfter(now + 3600)),
        unlockRound: String(firstRoundAtOrAfter(now + 6600)),
        endRound: String(firstRoundAtOrAfter(now + 14400)),
      },
      criteria: { encoded: toHex(encoded), hash: toHex(criteriaHash(encoded)) },
    },
    undefined,
    { wait: () => Promise.resolve() },
  );
  return env;
}

function Where() {
  return <output aria-label="address">{useLocation().pathname}</output>;
}

const show = (env: PublishEnvironment, path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/board/*" element={<BoardArea environment={env} tee={null} />} />
      </Routes>
    </MemoryRouter>,
  );

const address = () => screen.getByLabelText('address').textContent;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('opening an exam by its ENS name', () => {
  it('opens the exam the name checks out for, and stays on the name', async () => {
    const env = await published(lookupFor);
    show(env, `/board/exam/${name}`);
    await screen.findByRole('heading', { name: 'Bring everyone in' });
    await screen.findByText(name);
    expect(address()).toBe(`/board/exam/${name}`);
  });

  it('replaces an ID in the address with the name once it verifies, and keeps the page mounted', async () => {
    rememberExam({ id: examId, name: label });
    const env = await published(lookupFor);
    show(env, `/board/exam/${examId}`);
    const heading = await screen.findByRole('heading', { name: 'Bring everyone in' });
    await waitFor(() => {
      expect(address()).toBe(`/board/exam/${name}`);
    });
    expect(screen.getByRole('heading', { name: 'Bring everyone in' })).toBe(heading);
    expect(heading.isConnected).toBe(true);
  });

  it('keeps the ID for an exam with no verified name', async () => {
    rememberExam({ id: examId, name: label });
    const env = await published(() => lookupFor(null));
    show(env, `/board/exam/${examId}`);
    await screen.findByRole('button', { name: 'Set the exam name' });
    expect(address()).toBe(`/board/exam/${examId}`);
  });

  it('says so and opens nothing when the name has no record', async () => {
    const env = await published(() => lookupFor(null));
    show(env, `/board/exam/${name}`);
    await screen.findByText(/This exam name did not pass its checks, so no exam was opened\./);
    expect(screen.queryByRole('heading', { name: 'Bring everyone in' })).toBeNull();
  });

  it('opens nothing when the name belongs to another registry', async () => {
    const env = await published(() => lookupFor('0x00000000000000000000000000000000000000cc'));
    show(env, `/board/exam/${name}`);
    await screen.findByText(/belongs to a different public record, so no exam was opened/);
    expect(screen.queryByRole('heading', { name: 'Bring everyone in' })).toBeNull();
  });

  it('opens nothing when the board does not claim the name, even if it is published', async () => {
    const env = await published((registry) => lookupFor(registry, { primaryName: () => Promise.resolve('someone-else.eth') }));
    show(env, `/board/exam/${name}`);
    await screen.findByText(/did not pass its checks/);
    expect(screen.queryByRole('heading', { name: 'Bring everyone in' })).toBeNull();
  });

  it('offers Try again when the name can not be read, and opens once it can', async () => {
    let down = true;
    const env = await published((registry) =>
      lookupFor(registry, {
        address: (asked) => (down ? Promise.reject(new HttpRequestError({ url: 'https://rpc.example.org', status: 503 })) : Promise.resolve(asked === parent ? board : registry)),
      }),
    );
    show(env, `/board/exam/${name}`);
    await screen.findByText(/cannot be checked right now/);
    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Bring everyone in' });
  });

  it('links a home row by its name once the name verifies', async () => {
    rememberExam({ id: examId, name: label });
    const text = vi.fn(() => Promise.resolve(null));
    const env = await published((registry) => lookupFor(registry, { text }));
    show(env, '/board');
    const open = await screen.findByRole('button', { name: `Open ${label}` });
    // The four text records are the name check's last read.
    await waitFor(() => {
      expect(text).toHaveBeenCalledTimes(4);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.click(open);
    expect(address()).toBe(`/board/exam/${name}`);
  });

  it('keeps a home row on the ID when the name does not verify', async () => {
    rememberExam({ id: examId, name: label });
    const env = await published(() => lookupFor(null));
    show(env, '/board');
    fireEvent.click(await screen.findByRole('button', { name: `Open ${label}` }));
    expect(address()).toBe(`/board/exam/${examId}`);
  });

  it('still sends a junk address back to the list', async () => {
    const env = await published(lookupFor);
    show(env, '/board/exam/nonsense');
    await waitFor(() => {
      expect(address()).toBe('/board');
    });
  });

  it('builds the public link from the name or the ID', () => {
    expect(examPageLink('https://app.example.org/#/board', name)).toBe(`https://app.example.org/#/exam?exam=${name}`);
    expect(examPageLink('https://app.example.org/', examId)).toBe(`https://app.example.org/#/exam?exam=${examId}`);
  });
});

describe('the public exam link by name', () => {
  const registry = '0x00000000000000000000000000000000000000aa' as Address;
  const hook = (lookup: EnsLookup | null, link = `/exam?exam=${name}`) =>
    renderHook(() => useLinkedName(lookup, registry), {
      wrapper: (props: { children: ReactNode }) => <MemoryRouter initialEntries={[link]}>{props.children}</MemoryRouter>,
    });

  it('points this browser at the exam once every check passes', async () => {
    const { result } = hook(lookupFor(registry));
    await waitFor(() => {
      expect(result.current?.check).toEqual({ state: 'open' });
    });
    expect(getStoredExamId()).toBe(examId);
  });

  it('leaves the pointer alone when a check fails', async () => {
    const { result } = hook(lookupFor(null));
    await waitFor(() => {
      expect(result.current?.check).toEqual({ state: 'refused', retry: false });
    });
    expect(getStoredExamId()).toBeNull();
  });

  it('refuses a name on another registry', async () => {
    const { result } = hook(lookupFor('0x00000000000000000000000000000000000000cc'));
    await waitFor(() => {
      expect(result.current?.check).toEqual({ state: 'refused', retry: false });
    });
    expect(getStoredExamId()).toBeNull();
  });

  it('does nothing for a link that holds an ID', () => {
    expect(hook(lookupFor(registry), `/exam?exam=${examId}`).result.current).toBeNull();
  });
});
