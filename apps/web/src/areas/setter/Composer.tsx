import { requireHardwareAttestation, type Criteria, type Question } from '@paperseal/protocol';
import { TeeApiError } from '@paperseal/tee-client';
import { Check, Hash, KeyTouch, PrimaryAction, Row, Rows, Stage, Stamp } from '@paperseal/ui';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

import { describeError, isSecurityKeyError, plainFailure, Trouble } from '../../shared/Register';
import { confirmationExpired } from './confirm';
import type { StoredReceipt } from './receipts';
import { useSession } from './session';
import { nextTopic, saveTopic, topicProgress, type ReceiptChecks } from './state';
import {
  AlreadyHeldError,
  checkQuestion,
  ConfirmationLostError,
  ReceiptInvalidError,
  sealAndSubmit,
  SubmitBlockedError,
  type PendingSubmission,
} from './submit';

/** How long the sealed question stays on screen as it is stamped and folded away. */
const STAMP_MS = 1000;

/** What is being written. It lives above this screen, so it outlasts every re-check. */
export interface Draft {
  text: string;
  setText: (text: string) => void;
  topic: string;
  setTopic: (topic: string) => void;
  /** The attempt whose result is unknown. A retry resends exactly this ciphertext. */
  pending: RefObject<PendingSubmission | null>;
  /** True while `pending` holds an attempt. The draft can't change, or a retry would send the old words. */
  unsure: boolean;
  setUnsure: (unsure: boolean) => void;
}

type Problem = { kind: 'key'; error: unknown } | { kind: 'trouble'; text: string; detail: string[] };

const count = (n: number) => n.toLocaleString('en-GB');
const shortcut = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘ Return' : 'Ctrl + Enter';
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ReceiptLine(props: { number: number; topic: string | undefined; receipt: StoredReceipt; verified: boolean | undefined }) {
  const { receipt, verified } = props;
  return (
    <Row label={props.topic ? `Question ${String(props.number)} · ${props.topic}` : `Question ${String(props.number)}`}>
      {verified === undefined ? (
        'Checking the receipt'
      ) : verified ? (
        <span className="ss-receipt">
          Sealed at {clock(receipt.sealedAt)} <Hash value={receipt.questionHash} label="receipt" />
        </span>
      ) : (
        <Check status="fail">This receipt doesn’t check out</Check>
      )}
    </Row>
  );
}

/** The main screen: one writing area, and one question sealed at a time with one key touch. */
export function Composer(props: {
  criteria: Criteria;
  draft: Draft;
  receipts: readonly StoredReceipt[];
  checks: ReceiptChecks;
  topics: Record<string, string>;
  onSealed: () => void;
  /** Set when the checks failed. The draft stays, and sealing stays shut. */
  blocked?: { title: string; lede: string; panel: ReactNode };
}) {
  const { criteria, draft, receipts, checks, topics, onSealed, blocked } = props;
  const { text, setText, topic, setTopic, pending, unsure, setUnsure } = draft;
  const session = useSession();
  const { confirmed, credential, env, examId } = session;

  const [busy, setBusy] = useState(false);
  const sealing = useRef(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState('');
  const [leaving, setLeaving] = useState<{ id: number; text: string } | null>(null);
  const [heldHashes, setHeldHashes] = useState<StoredReceipt['questionHash'][]>([]);
  const writing = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    writing.current?.focus();
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      setLeaving(null);
    }, STAMP_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [leaving]);

  const sealed = receipts.filter((receipt) => checks[receipt.questionHash] === true);
  const sealedHashes = sealed.map((receipt) => receipt.questionHash);
  const progress = topicProgress(criteria, sealedHashes, topics);
  const selected = topic || nextTopic(progress);
  const chosen = progress.find((entry) => entry.name === selected);

  const question: Question = { topic: selected, text };
  const check = checkQuestion(criteria, question);
  const over = check.size - check.limit;
  // The button only reflects this: `sealAndSubmit` can't run at all without a `Confirmed`.
  const canSeal = confirmed !== null && credential !== null && check.error === null && !busy;

  const seal = async () => {
    if (!canSeal || sealing.current || !env.tee || !examId) return;
    sealing.current = true;
    setBusy(true);
    setProblem(null);
    setNotice('');
    try {
      const receipt = await sealAndSubmit(
        {
          keys: env.keys(),
          tee: env.tee,
          credentialId: credential.credentialId,
          passkeyPublicKey: credential.passkeyPublicKey,
          pending,
        },
        confirmed,
        question,
      );
      saveTopic(examId, receipt.questionHash, selected);
      setTopic(selected);
      // Sealed: the receipt is kept, and the words leave the page.
      setLeaving({ id: receipt.sealedAt, text });
      setText('');
      setNotice(`Question sealed. Your receipt is below. ${count(sealed.length + 1)} sealed so far.`);
      onSealed();
    } catch (error) {
      if (error instanceof ConfirmationLostError) {
        if (confirmationExpired(confirmed, Date.now())) {
          session.expireConfirmation();
          setNotice('The check had timed out, so it is running again. Your question is still here.');
        } else {
          session.dropConfirmation(error.message);
        }
      } else if (error instanceof AlreadyHeldError) {
        // It is in the bank, so it must not be sent again, but it has no receipt to count.
        setHeldHashes((hashes) => [...hashes, error.questionHash]);
        setText('');
      } else if (error instanceof ReceiptInvalidError) {
        setProblem({
          kind: 'trouble',
          text: 'The sealed system’s reply didn’t check out, so this question is not counted as sealed. Tell your exam board.',
          detail: [error.message],
        });
      } else if (error instanceof SubmitBlockedError) {
        setProblem({ kind: 'trouble', text: 'Questions aren’t being accepted right now.', detail: [error.message] });
      } else if (isSecurityKeyError(error)) {
        setProblem({ kind: 'key', error });
      } else {
        const unknown = pending.current !== null;
        setProblem({
          kind: 'trouble',
          text: unknown
            ? 'We couldn’t tell whether this question arrived. Send it again: it can’t be stored twice.'
            : error instanceof TeeApiError
              ? 'The sealed system refused this question. Contact your exam board.'
              : plainFailure(error),
          detail: [describeError(error)],
        });
      }
    } finally {
      sealing.current = false;
      setBusy(false);
      setUnsure(pending.current !== null);
      writing.current?.focus();
      await session.refreshStatus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void seal();
    }
  };

  const locked = busy || unsure;

  const action = (): ReactNode => {
    if (blocked) return blocked.panel;
    if (!confirmed) {
      return <p className="ss-checking">Checking this is the genuine sealed system…</p>;
    }
    if (busy) {
      return (
        <KeyTouch
          state="waiting"
          demo={!requireHardwareAttestation}
          onUse={() => {
            // The prompt shows no button while waiting.
          }}
        />
      );
    }
    if (problem?.kind === 'key') {
      return (
        <KeyTouch
          state="failed"
          error={problem.error}
          demo={!requireHardwareAttestation}
          onUse={() => {
            void seal();
          }}
        />
      );
    }
    return (
      <PrimaryAction
        disabled={!canSeal}
        aria-keyshortcuts="Meta+Enter Control+Enter"
        onClick={() => {
          void seal();
        }}
      >
        {unsure ? 'Send this question again' : 'Seal this question'}
      </PrimaryAction>
    );
  };

  return (
    <Stage
      eyebrow={`${count(sealed.length)} ${sealed.length === 1 ? 'question' : 'questions'} sealed so far`}
      title={blocked ? blocked.title : 'Write a question'}
      {...(blocked ? { lede: blocked.lede } : {})}
      action={
        <div className="ss-composer">
          <fieldset className="ss-topics" disabled={locked}>
            <legend>Topic</legend>
            {progress.map((entry) => (
              <label key={entry.name} className="ss-chip">
                <input
                  type="radio"
                  name="topic"
                  value={entry.name}
                  checked={entry.name === selected}
                  onChange={() => {
                    setTopic(entry.name);
                  }}
                  onClick={(event) => {
                    // A pointer press goes straight back to writing. Arrow keys stay on the chips.
                    if (event.detail > 0) writing.current?.focus();
                  }}
                />
                <span className="ss-chip-name">{entry.name}</span>
                <span className="ss-chip-count">{count(entry.sealed)} sealed</span>
                <span className="ss-chip-bar" aria-hidden="true">
                  <span style={{ width: `${String(Math.min(100, (entry.sealed / entry.needed) * 100))}%` }} />
                </span>
              </label>
            ))}
          </fieldset>
          {chosen ? (
            <p className="ss-topic-note">
              The exam needs at least {count(chosen.needed)} {chosen.name} questions across all setters. No one setter can hold
              more than {count(criteria.maxSetterPercent)}% of a topic.
            </p>
          ) : null}

          <label className="ss-sheet">
            <span className="ss-sheet-label">Your question</span>
            <span className="ss-sheet-page">
              <textarea
                ref={writing}
                className="ps-input ss-text"
                rows={9}
                value={text}
                readOnly={locked}
                aria-invalid={over > 0 ? true : undefined}
                aria-describedby="ss-size"
                onChange={(event) => {
                  setText(event.target.value);
                  setProblem(null);
                  setNotice('');
                }}
                onKeyDown={onKeyDown}
              />
              {leaving ? (
                <span key={leaving.id} className="ss-leaving" aria-hidden="true">
                  <span className="ss-leaving-text">{leaving.text}</span>
                  <span className="ss-leaving-stamp">
                    <Stamp press>Sealed</Stamp>
                  </span>
                </span>
              ) : null}
            </span>
          </label>
          <p id="ss-size" className="ss-size" data-over={over > 0 ? 'true' : undefined}>
            {over > 0
              ? `Too long by about ${count(over)} characters. Shorten it to seal it.`
              : `About ${count(-over)} characters left`}
            <span className="ss-shortcut">{shortcut} seals</span>
          </p>

          {problem?.kind === 'trouble' ? <Trouble detail={problem.detail}>{problem.text}</Trouble> : null}
          <div className="ss-action">{action()}</div>
          <p className="ps-sr" role="status">
            {notice}
          </p>
          {notice && !notice.startsWith('Question sealed') ? <p className="ss-notice">{notice}</p> : null}
        </div>
      }
      next="Each question is sealed on its own with one touch of your security key. It then leaves this page, and its receipt appears below."
    >
      {heldHashes.length > 0 || receipts.length > 0 ? (
        <Rows>
          {heldHashes.map((hash) => (
            <Row key={hash} label="An earlier attempt">
              <span className="ss-receipt">
                The sealed system already has this question, but this browser never got its receipt. It wasn’t sent again.{' '}
                <Hash value={hash} label="question reference" />
              </span>
            </Row>
          ))}
          {receipts
            .map((receipt, index) => (
              <ReceiptLine
                key={receipt.questionHash}
                number={index + 1}
                topic={topics[receipt.questionHash]}
                receipt={receipt}
                verified={checks[receipt.questionHash]}
              />
            ))
            .reverse()}
        </Rows>
      ) : null}
    </Stage>
  );
}
