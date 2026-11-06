import { toHex, roles, type ApprovedListEntry } from '@paperseal/protocol';
import { Button, Check, Hash, PrimaryAction, Row, Rows } from '@paperseal/ui';
import { shortAddress } from '../../shared/wallet';
import { useState, type HTMLInputTypeAttribute, type ReactNode } from 'react';

import { useBoardForm } from './BoardForm';
import { useBoardWallet, walletStageLabels, type WalletStage } from './hooks';
import { splitDetails } from './details';
import { plainWords } from './plan';
import type { PostOutcome } from './postFlow';
import { explainError } from './publishFlow';
import { roleNames } from './registrations';

/** A problem that stops the flow, in words. */
export function Problem(props: { children: string }) {
  const { say, detail } = splitDetails(props.children);
  return (
    <div className="board-problem" role="alert">
      <Check status="fail">{plainWords(say)}</Check>
      {detail ? (
        <Fold summary="Details">
          <p className="ps-mono">{detail}</p>
        </Fold>
      ) : null}
    </div>
  );
}

/**
 * The wallet's warning from `useBoardWallet`. On a wrong account it names both accounts and offers
 * the wallet's own account picker.
 */
export function WalletProblem(props: { wallet: ReturnType<typeof useBoardWallet> }) {
  const { problem, mismatch, chooseAccount } = props.wallet;
  if (!problem) return null;
  return (
    <>
      <Problem>{problem}</Problem>
      {mismatch ? (
        <>
          <p className="board-blocked">
            Connected: {shortAddress(mismatch.connected)}. The exam board uses: {shortAddress(mismatch.board)}.
          </p>
          <Button type="button" onClick={() => void chooseAccount()}>
            Choose the board’s account
          </Button>
        </>
      ) : null}
    </>
  );
}

/** `Field`, with the input types a date picker and a phone's number pad need. */
export function Input(props: {
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  value: string;
  onChange: (value: string) => void;
  type?: HTMLInputTypeAttribute;
  numeric?: boolean;
}) {
  return (
    <label className="ps-field">
      <span>{props.label}</span>
      <input
        className="ps-input"
        type={props.type ?? 'text'}
        inputMode={props.numeric ? 'numeric' : undefined}
        value={props.value}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={props.error ? true : undefined}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
      {props.error ? <span className="ps-field-error">{plainWords(props.error)}</span> : null}
      {props.hint ? <span className="ps-field-hint">{props.hint}</span> : null}
    </label>
  );
}

/** A folded section. `open` forces it open, for a problem that would otherwise stay hidden. */
export function Fold(props: { summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="ps-step-evidence board-fold" open={props.open}>
      <summary>{props.summary}</summary>
      <div className="ps-step-proof">{props.children}</div>
    </details>
  );
}

/** The approved list's entries. Hashes belong here, in the record, because a person may need to quote them. */
export function EntryRows(props: { entries: readonly ApprovedListEntry[] }) {
  return (
    <Rows>
      {props.entries.map((entry) => (
        <Row key={toHex(entry.passkeyPublicKey)} label={entry.role === roles.setter ? 'Setter' : entry.owner}>
          {roleNames[entry.role] ?? 'Unknown role'} <Hash value={toHex(entry.passkeyPublicKey)} label="security key" />
        </Row>
      ))}
    </Rows>
  );
}

type Progress = { state: 'idle' } | { state: 'running'; stage: WalletStage } | { state: 'failed'; message: string };

/**
 * The one button that posts. It asks the wallet for an account if it has to, and the flow rechecks
 * the wallet, chain and board address. `blocked` says why posting is not allowed yet.
 */
export function PostAction(props: {
  label: string;
  blocked: string | null;
  post: (onStage: (stage: WalletStage) => void) => Promise<PostOutcome>;
  onPosted: (outcome: PostOutcome) => void;
}) {
  const boardWallet = useBoardWallet();
  const { ensureAccount } = boardWallet;
  const [progress, setProgress] = useState<Progress>({ state: 'idle' });

  async function send() {
    setProgress({ state: 'running', stage: 'checking' });
    try {
      await ensureAccount();
      const outcome = await props.post((stage) => {
        setProgress({ state: 'running', stage });
      });
      setProgress({ state: 'idle' });
      props.onPosted(outcome);
    } catch (error) {
      setProgress({ state: 'failed', message: explainError(error) });
    }
  }

  const running = progress.state === 'running';
  const blocked = splitDetails(props.blocked ?? '');
  return (
    <>
      {blocked.say ? <p className="board-blocked">{plainWords(blocked.say)}</p> : null}
      {blocked.detail ? (
        <Fold summary="Details">
          <p className="ps-mono">{blocked.detail}</p>
        </Fold>
      ) : null}
      <WalletProblem wallet={boardWallet} />
      {progress.state === 'failed' ? <Problem>{progress.message}</Problem> : null}
      <PrimaryAction
        disabled={props.blocked !== null}
        status={running ? 'busy' : 'idle'}
        busyLabel={progress.state === 'running' ? walletStageLabels[progress.stage] : ''}
        onClick={() => void send()}
      >
        {props.label}
      </PrimaryAction>
    </>
  );
}

/** Each value read back beside what was sent. */
export function ReadBackRows(props: { rows: readonly { label: string; expected: string; actual: string; match: boolean }[] }) {
  return (
    <Rows>
      {props.rows.map((row) => (
        <Row key={row.label} label={plainWords(row.label)}>
          {row.match ? (
            <Check status="pass">Matches</Check>
          ) : (
            <Check status="fail">
              You entered {row.expected}. The public record has {row.actual}.
            </Check>
          )}
        </Row>
      ))}
    </Rows>
  );
}

/** The read-backs of what this session posted. */
export function ReceiptRows() {
  const { receipts } = useBoardForm();
  const names = { publish: 'Exam', list: 'List of people', build: 'Sealed paper' };
  return receipts.map((receipt) => (
    <Row key={receipt.kind} label={`${names[receipt.kind]}, saved in block ${String(receipt.outcome.blockNumber)}`}>
      <Hash value={receipt.outcome.transactionHash} label="receipt code" />
    </Row>
  ));
}
