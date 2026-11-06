import type { ExamRegistry } from '@paperseal/chain';
import { Button, Check, LoadingSeal, PrimaryAction } from '@paperseal/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { registry } from './registry';
import { RoleStop } from './RolePage';
import { chooseAccounts, currentAccount, injectedProvider, onWalletChange, requestAccount, shortAddress } from './wallet';

type Access =
  | { state: 'checking' | 'not-ready' | 'no-wallet' | 'not-connected' | 'unreadable' | 'open' }
  | { state: 'wrong-account'; connected: string; board: string };

const RETRY_MS = 5000;

/**
 * Shows the board's pages only to the wallet account that is `board()` on ExamRegistry, and follows
 * the wallet, so moving to another account closes them again. This only decides which page to show.
 * What the board can do is decided by the contract.
 *
 * It looks at the wallet's active account, the first one it lists, even if this page is also allowed
 * the board's: someone who has moved to another account should not stay on the board's pages.
 */
export function BoardGate(props: { children: ReactNode; reader?: Pick<ExamRegistry, 'board'> | null; retryMs?: number }) {
  const reader = props.reader === undefined ? registry : props.reader;
  const retryMs = props.retryMs ?? RETRY_MS;
  const [access, setAccess] = useState<Access>({ state: 'checking' });
  const [declined, setDeclined] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // The contract never changes its board, so once read it holds for this page.
  const board = useRef<string | null>(null);
  const latest = useRef(0);

  const check = useCallback(async () => {
    latest.current += 1;
    const round = latest.current;
    const read = async (): Promise<Access> => {
      if (!reader) return { state: 'not-ready' };
      const provider = injectedProvider();
      if (!provider) return { state: 'no-wallet' };
      try {
        board.current ??= await reader.board();
        const account = await currentAccount(provider);
        if (!account) return { state: 'not-connected' };
        if (account.toLowerCase() === board.current.toLowerCase()) return { state: 'open' };
        return { state: 'wrong-account', connected: account, board: board.current };
      } catch {
        return { state: 'unreadable' };
      }
    };
    const next = await read();
    if (round === latest.current) setAccess(next);
  }, [reader]);

  useEffect(() => {
    void check();
    const provider = injectedProvider();
    if (!provider) return;
    return onWalletChange(provider, () => {
      void check();
    });
  }, [check]);

  useEffect(() => {
    if (access.state !== 'unreadable') return;
    const timer = setTimeout(() => {
      void check();
    }, retryMs);
    return () => {
      clearTimeout(timer);
    };
  }, [access, check, retryMs]);

  const connect = async () => {
    const provider = injectedProvider();
    if (!provider) return;
    setDeclined(false);
    setConnecting(true);
    await requestAccount(provider).catch(() => {
      setDeclined(true);
    });
    setConnecting(false);
    await check();
  };

  const choose = async () => {
    const provider = injectedProvider();
    if (!provider) return;
    await chooseAccounts(provider);
    await check();
  };

  switch (access.state) {
    case 'open':
      return props.children;
    case 'checking':
      return <LoadingSeal />;
    case 'not-ready':
      return (
        <RoleStop
          role="board"
          title="This page is not ready to use yet"
          lede="Ask whoever installed Paper Seal to finish setting it up."
          next="Come back once they have. It is safe to close this page."
        />
      );
    case 'no-wallet':
      return (
        <RoleStop
          role="board"
          title="Install a wallet to use this page"
          lede="This page is only for the exam board, and it needs the board’s wallet. This browser has no wallet."
          next="Install a wallet extension in Chrome, then reload this page."
        />
      );
    case 'not-connected':
      return (
        <RoleStop
          role="board"
          title="Connect the exam board’s wallet"
          lede="This page is only for the exam board."
          action={
            <>
              <PrimaryAction status={connecting ? 'busy' : 'idle'} busyLabel="Confirm in your wallet" onClick={() => void connect()}>
                Connect your wallet
              </PrimaryAction>
              {declined ? (
                <div role="alert">
                  <Check status="fail">Your wallet did not share an account. Press the button to try again.</Check>
                </div>
              ) : null}
            </>
          }
          next="Then your exams and drafts show here."
        />
      );
    case 'wrong-account':
      return (
        <RoleStop
          role="board"
          title="Switch to the exam board’s account"
          lede={`This wallet account is not the exam board’s account. Connected: ${shortAddress(access.connected)}. The exam board uses: ${shortAddress(access.board)}.`}
          action={
            <Button type="button" onClick={() => void choose()}>
              Choose the board’s account
            </Button>
          }
          next="This page opens as soon as your wallet is on that account."
        />
      );
    case 'unreadable':
      return (
        <RoleStop
          role="board"
          title="Can’t check your wallet right now"
          lede="Check this computer’s internet connection, and that your wallet is unlocked."
          next="This page tries again by itself."
        />
      );
  }
}
