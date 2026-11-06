import { chain } from '@paperseal/protocol';
import { useCallback, useEffect, useState } from 'react';

import { currentAccount, requestAccount, switchToSepolia, walletChainId } from '../../shared/wallet';
import { useBoardForm } from './BoardForm';
import { explainError, PublishBlockedError } from './publishFlow';

type Polled<T> = { source: unknown; state: 'ready'; value: T; problem: string | null } | { source: unknown; state: 'error'; problem: string };

/**
 * Reads `load` now and again `ms` after each read finishes, so a slow source is never read twice
 * at once. A failed read keeps the last good value and says why. `load` gets that value.
 * `reload` reads again straight away.
 */
export function usePoll<T>(load: ((previous: T | null) => Promise<T>) | null, ms: number) {
  const [polled, setPolled] = useState<Polled<T> | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!load) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: T | null = null;
    const read = () => {
      load(last)
        .then(
          (value) => {
            last = value;
            if (live) setPolled({ source: load, state: 'ready', value, problem: null });
          },
          (error: unknown) => {
            const problem = error instanceof Error ? error.message : String(error);
            if (!live) return;
            setPolled((previous) =>
              previous?.source === load && previous.state === 'ready' ? { ...previous, problem } : { source: load, state: 'error', problem },
            );
          },
        )
        .finally(() => {
          if (live) timer = setTimeout(read, ms);
        });
    };
    read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, ms, round]);

  const reload = useCallback(() => {
    setRound((n) => n + 1);
  }, []);
  const current = polled?.source === load ? polled : null;
  return {
    value: current?.state === 'ready' ? current.value : null,
    problem: current?.problem ?? null,
    /** Nothing has come back yet. */
    pending: load !== null && current === null,
    reload,
  };
}

/** The time now, updated every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(id);
    };
  }, [ms]);
  return now;
}

interface WalletState {
  account: string | null;
  chainId: number | null;
  board: string | null;
  error: string | null;
}

/**
 * The board's wallet, as far as the screens need it. `problem` warns early, but it never decides
 * anything: the flows repeat every check right before they send.
 */
export function useBoardWallet() {
  const { environment } = useBoardForm();
  const [wallet, setWallet] = useState<WalletState>({ account: null, chainId: null, board: null, error: null });

  const refresh = useCallback(async () => {
    const provider = environment.getProvider();
    if (!provider) {
      setWallet({ account: null, chainId: null, board: null, error: 'Your wallet was not found. Install a wallet extension in Chrome, then reload this page.' });
      return;
    }
    try {
      const [account, chainId] = [await currentAccount(provider), await walletChainId(provider)];
      const board = environment.createRegistry ? await environment.createRegistry().board() : null;
      setWallet({ account, chainId, board, error: null });
    } catch (error) {
      setWallet((previous) => ({ ...previous, error: explainError(error) }));
    }
  }, [environment]);

  // A wallet that is already connected to this site shows without a prompt.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Asks the wallet to share an account if it hasn't, which is part of the one action on screen. */
  const ensureAccount = useCallback(async () => {
    const provider = environment.getProvider();
    if (!provider) throw new PublishBlockedError('Your wallet was not found. Install a wallet extension in Chrome, then reload this page.');
    const account = (await currentAccount(provider)) ?? (await requestAccount(provider));
    // A wallet on another network is asked to move. If it declines, `problem` keeps the plain instruction.
    await switchToSepolia(provider);
    await refresh();
    return account;
  }, [environment, refresh]);

  let problem = wallet.error;
  if (!problem && wallet.chainId !== null && wallet.chainId !== chain.chainId) {
    problem = 'Your wallet is on the wrong network. Switch it to Sepolia in your wallet.';
  } else if (!problem && wallet.account && wallet.board && wallet.account.toLowerCase() !== wallet.board.toLowerCase()) {
    problem = 'This wallet account is not the exam board’s account. Switch accounts in your wallet.';
  }
  return { wallet, problem, ensureAccount };
}

export type WalletStage = 'checking' | 'simulating' | 'wallet' | 'mining' | 'reading';

/** The primary button's words while a flow runs. */
export const walletStageLabels: Record<WalletStage, string> = {
  checking: 'Checking your wallet',
  simulating: 'Checking your request',
  wallet: 'Confirm in your wallet',
  mining: 'Saving to the public record',
  reading: 'Checking it saved correctly',
};
