// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { currentAccount, onWalletChange } from '../../shared/wallet';
import { BoardFormProvider } from './BoardForm';
import { useBoardWallet } from './hooks';
import { WalletProblem } from './Parts';
import type { PublishEnvironment } from './publishFlow';

const board = '0xC3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa20';
const other = '0x12bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb34';

type Listener = () => void;

/** A wallet whose accounts and network the test can change, with the events a real one fires. */
function fakeWallet(start: { accounts: string[]; chain?: string; pick?: string[] | 'decline'; events?: boolean }) {
  const listeners = new Map<string, Set<Listener>>();
  const state = { accounts: start.accounts, chain: start.chain ?? '0xaa36a7' };
  const requests: { method: string; params?: unknown }[] = [];
  const provider: Record<string, unknown> = {
    request: (args: { method: string; params?: unknown }) => {
      requests.push(args);
      switch (args.method) {
        case 'eth_accounts':
          return Promise.resolve(state.accounts);
        case 'eth_chainId':
          return Promise.resolve(state.chain);
        case 'wallet_requestPermissions':
          if (start.pick === 'decline' || !start.pick) return Promise.reject(new Error('User rejected the request.'));
          state.accounts = start.pick;
          return Promise.resolve([]);
        default:
          return Promise.reject(new Error(`unexpected ${args.method}`));
      }
    },
  };
  if (start.events !== false) {
    provider.on = (event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      set.add(listener);
    };
    provider.removeListener = (event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    };
  }
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  const count = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  return { provider, state, requests, emit, count };
}

function wrapperFor(provider: unknown) {
  const environment = {
    registryAddress: board,
    getProvider: () => provider,
    createRegistry: () => ({ board: () => Promise.resolve(board) }),
  } as unknown as PublishEnvironment;
  return ({ children }: { children: ReactNode }) => <BoardFormProvider environment={environment}>{children}</BoardFormProvider>;
}

afterEach(() => {
  cleanup();
});

describe('the board wallet follows the wallet', () => {
  it('refreshes when the account or the network changes, and stops listening on unmount', async () => {
    const wallet = fakeWallet({ accounts: [other] });
    const { result, unmount } = renderHook(() => useBoardWallet(), { wrapper: wrapperFor(wallet.provider) });
    await waitFor(() => {
      expect(result.current.wallet.account).toBe(other);
    });
    expect(wallet.count()).toBe(2);

    wallet.state.accounts = [board];
    wallet.emit('accountsChanged');
    await waitFor(() => {
      expect(result.current.wallet.account).toBe(board);
    });
    expect(result.current.problem).toBeNull();

    wallet.state.chain = '0x1';
    wallet.emit('chainChanged');
    await waitFor(() => {
      expect(result.current.problem).toMatch(/wrong network/);
    });

    unmount();
    expect(wallet.count()).toBe(0);
  });

  it('works with a wallet that has no events', async () => {
    const wallet = fakeWallet({ accounts: [board], events: false });
    expect(() => onWalletChange(wallet.provider as never, () => undefined)()).not.toThrow();
    const { result } = renderHook(() => useBoardWallet(), { wrapper: wrapperFor(wallet.provider) });
    await waitFor(() => {
      expect(result.current.wallet.account).toBe(board);
    });
  });

  it('prefers the board account when the page is connected to several', async () => {
    const wallet = fakeWallet({ accounts: [other, board] });
    expect(await currentAccount(wallet.provider as never)).toBe(other);
    expect(await currentAccount(wallet.provider as never, board.toLowerCase())).toBe(board);
    const { result } = renderHook(() => useBoardWallet(), { wrapper: wrapperFor(wallet.provider) });
    await waitFor(() => {
      expect(result.current.wallet.account).toBe(board);
    });
    expect(result.current.problem).toBeNull();
  });
});

function Probe() {
  const wallet = useBoardWallet();
  return <WalletProblem wallet={wallet} />;
}

describe('the board account button', () => {
  it('names both accounts and opens the wallet picker, then refreshes', async () => {
    const wallet = fakeWallet({ accounts: [other], pick: [board] });
    render(<Probe />, { wrapper: wrapperFor(wallet.provider) });
    expect(await screen.findByText('Connected: 0x12…34. The exam board uses: 0xC3…20.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the board’s account' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Choose the board’s account' })).toBeNull();
    });
    expect(wallet.requests).toContainEqual({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
  });

  it('changes nothing and shows no new error when the prompt is declined', async () => {
    const wallet = fakeWallet({ accounts: [other], pick: 'decline' });
    render(<Probe />, { wrapper: wrapperFor(wallet.provider) });
    fireEvent.click(await screen.findByRole('button', { name: 'Choose the board’s account' }));
    await waitFor(() => {
      expect(wallet.requests.some((r) => r.method === 'wallet_requestPermissions')).toBe(true);
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText(/rejected/)).toBeNull();
    expect(screen.getByText('Connected: 0x12…34. The exam board uses: 0xC3…20.')).toBeTruthy();
  });
});
