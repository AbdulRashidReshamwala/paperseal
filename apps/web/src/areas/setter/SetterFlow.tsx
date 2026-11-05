import type { Criteria, Hex, Stage as ExamStage } from '@paperseal/protocol';
import { Button, Page, RoleHeader, Stage } from '@paperseal/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { credentialIsForInvite, useInvite } from '../../shared/invite';
import { Register, Trouble } from '../../shared/Register';
import { Closed } from './Closed';
import { Composer, type Draft } from './Composer';
import type { ConfirmOutcome } from './confirm';
import { loadReceipts, verifyReceipt, type StoredReceipt } from './receipts';
import { useSession } from './session';
import { loadTopics, setterScreen, type BuildRead, type ReceiptChecks } from './state';
import type { PendingSubmission } from './submit';
import './setter.css';

const BUILD_POLL_MS = 15_000;

const stillOpen: readonly ExamStage[] = ['publish', 'onboard', 'submit'];

const blockedWhy: Record<Extract<ConfirmOutcome, { ok: false }>['step'], string> = {
  chain: 'The exam’s public record could not be read, or it doesn’t match.',
  attestation: 'The machine answering this link couldn’t prove it is the sealed system your exam board published.',
  list: 'The approved list held by the sealed system doesn’t match the public one.',
};

const BLOCKED_TITLE = 'We can’t confirm this is the genuine sealed system';

function Blocked(props: { outcome: Extract<ConfirmOutcome, { ok: false }> }) {
  const { runConfirm, checking } = useSession();
  return (
    <div className="ss-blocked">
      <Trouble detail={props.outcome.reasons}>Sealing has stopped, and nothing new has been sent. Contact your exam board before you continue.</Trouble>
      <Button
        disabled={checking}
        onClick={() => {
          void runConfirm();
        }}
      >
        {checking ? 'Checking' : 'Check again'}
      </Button>
    </div>
  );
}

/** Signature checks for the stored receipts. A receipt absent from the result is still being checked. */
function useReceiptChecks(examId: Hex | null, passkey: Hex | undefined, receipts: readonly StoredReceipt[]): ReceiptChecks {
  const [checks, setChecks] = useState<ReceiptChecks>({});
  useEffect(() => {
    if (!examId || !passkey) return;
    let live = true;
    void Promise.all(receipts.map(async (r) => [r.questionHash, await verifyReceipt(examId, passkey, r)] as const)).then(
      (entries) => {
        if (live) setChecks(Object.fromEntries(entries));
      },
    );
    return () => {
      live = false;
    };
  }, [examId, passkey, receipts]);
  return checks;
}

/** Reads the Build from the chain until it is posted. It needs no TEE, which may be long gone by then. */
function useBuild(enabled: boolean): BuildRead {
  const { env, examId } = useSession();
  const { chain } = env;
  const pollMs = env.buildPollMs ?? BUILD_POLL_MS;
  const [build, setBuild] = useState<BuildRead>({ state: 'unread' });
  useEffect(() => {
    if (!enabled || !chain || !examId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      chain.getBuild(examId).then(
        (record) => {
          if (!live) return;
          if (record) {
            setBuild({ state: 'posted', key: record.instancePublicKey as Hex });
            return;
          }
          setBuild({ state: 'not-posted' });
          timer = setTimeout(read, pollMs);
        },
        () => {
          if (!live) return;
          setBuild({ state: 'failed' });
          timer = setTimeout(read, pollMs);
        },
      );
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled, chain, examId, pollMs]);
  return build;
}

function Quiet(props: { title: string; lede?: string; next: string; detail?: string | null; children?: ReactNode }) {
  return (
    <Stage title={props.title} {...(props.lede ? { lede: props.lede } : {})} next={props.next}>
      {props.children}
      {props.detail ? (
        <details>
          <summary>Details for your exam board</summary>
          <p>{props.detail}</p>
        </details>
      ) : null}
    </Stage>
  );
}

/** The setter's one page. Each state shows one thing, and a reload lands in the same place. */
export function SetterFlow() {
  const session = useSession();
  const { env, examId, credential, outcome, confirmed, status, statusError, checking, runConfirm } = session;

  // Above every screen, so a re-check or the bank closing never loses what is being written. It is
  // held in memory only: a question's text is never stored.
  const [text, setText] = useState('');
  const [topic, setTopic] = useState('');
  const [unsure, setUnsure] = useState(false);
  const pending = useRef<PendingSubmission | null>(null);
  const draft: Draft = { text, setText, topic, setTopic, pending, unsure, setUnsure };

  const [receipts, setReceipts] = useState<StoredReceipt[]>(() => (examId ? loadReceipts(examId) : []));
  const [topics, setTopics] = useState<Record<string, string>>(() => (examId ? loadTopics(examId) : {}));
  const reloadReceipts = () => {
    if (!examId) return;
    setReceipts(loadReceipts(examId));
    setTopics(loadTopics(examId));
  };

  const checks = useReceiptChecks(examId, credential?.passkeyPublicKey, receipts);
  const stage = status?.stage ?? null;
  const build = useBuild(stage === null || !stillOpen.includes(stage));

  // A new invitation link means a new key, so the stored one stops counting once a different link is open.
  const invite = useInvite('setter');
  const registered = credential !== null && !(invite && !credentialIsForInvite(credential, invite));

  const screen = setterScreen({
    configured: session.configured,
    stage,
    statusFailed: statusError !== null,
    registered,
    buildPosted: build.state === 'posted',
  });

  // The criteria stay on hand through a re-check, so the writing area never leaves the page.
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  if (confirmed && confirmed.criteria !== criteria) setCriteria(confirmed.criteria);

  // Runs by itself, and again whenever a confirmation ages out. A failure stays until someone asks
  // to check again, so it can't flicker away.
  useEffect(() => {
    if (screen === 'write' && outcome === null && !checking) void runConfirm();
  }, [screen, outcome, checking, runConfirm]);

  const body = (): ReactNode => {
    switch (screen) {
      case 'not-set-up':
        return (
          <Quiet
            title="This link isn’t ready yet"
            lede="Check you opened the link your exam board sent."
            next="Once the link is right, this page opens by itself."
            detail="Set VITE_TEE_URL, VITE_RPC_URL, VITE_REGISTRY_ADDRESS and VITE_EXAM_ID, or publish an exam, so the app can reach the TEE and read ExamRegistry."
          />
        );
      case 'opening':
        return <Quiet title="Opening your exam…" next="This takes a moment." />;
      case 'unreachable':
        return (
          <Quiet
            title="Can’t reach the sealed system right now"
            lede="This is usually a connection problem. Nothing has been lost."
            next="This page keeps trying by itself."
            detail={statusError}
          />
        );
      case 'not-open':
        return (
          <Quiet
            title="Registration hasn’t opened yet"
            lede="Your exam board is still setting up this exam."
            next="This page moves on by itself once registration opens."
          />
        );
      case 'register':
        if (!examId || !env.tee) return null;
        return (
          <Register
            role="setter"
            examId={examId}
            tee={env.tee}
            keys={env.keys()}
            onRegistered={session.credentialSaved}
            {...(stage === 'submit' ? { next: 'We check the sealed system by ourselves, then you can write your questions.' } : {})}
          />
        );
      case 'waiting':
        return (
          <Quiet
            title="Waiting for your exam board"
            lede="Your security key is registered. The board still has to publish the approved list."
            next="This page opens for writing by itself, so you can leave it open or come back to this link. To use a different security key, ask your exam board for a new invitation link."
          />
        );
      case 'write': {
        const failed = outcome && !outcome.ok ? outcome : null;
        if (!criteria) {
          if (failed) {
            return <Stage title={BLOCKED_TITLE} lede={blockedWhy[failed.step]} action={<Blocked outcome={failed} />} next="Your exam board can find out what went wrong and tell you when to try again." />;
          }
          return (
            <>
              <Stage title="Checking this is the genuine sealed system…" next="Then you can start writing. This takes a moment." />
              <span className="ps-sr" role="status">
                Checking this is the genuine sealed system.
              </span>
            </>
          );
        }
        return (
          <Composer
            criteria={criteria}
            draft={draft}
            receipts={receipts}
            checks={checks}
            topics={topics}
            onSealed={reloadReceipts}
            {...(failed
              ? { blocked: { title: BLOCKED_TITLE, lede: blockedWhy[failed.step], panel: <Blocked outcome={failed} /> } }
              : {})}
          />
        );
      }
      case 'closed':
        return <Closed stage={stage} receipts={receipts} checks={checks} topics={topics} build={build} unsealed={text} unsure={unsure} />;
    }
  };

  return <Page header={<RoleHeader role="Setter" />}>{body()}</Page>;
}
