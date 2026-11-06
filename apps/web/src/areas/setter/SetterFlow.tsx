import type { Criteria, Hex, Stage as ExamStage } from '@paperseal/protocol';
import { Button, LoadingSeal, Page, RoleHeader, Stage, useLoaded } from '@paperseal/ui';
import { useExamTitle } from '../../shared/NamedExam';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useMachineElsewhere } from '../../shared/machineExam';
import { credentialIsForInvite, useInvite } from '../../shared/invite';
import { Register, SetterRegistered, Trouble } from '../../shared/Register';
import { Closed } from './Closed';
import { Composer, emptyOptions, type Draft } from './Composer';
import type { ConfirmOutcome } from './confirm';
import { loadReceipts, verifyReceipt, type StoredReceipt } from './receipts';
import { useSession } from './session';
import { loadTopics, setterScreen, type BuildRead, type ReceiptChecks } from './state';
import type { PendingSubmission } from './submit';
import './setter.css';

const BUILD_POLL_MS = 15_000;

const stillOpen: readonly ExamStage[] = ['publish', 'onboard', 'submit'];

const blockedWhy: Record<Extract<ConfirmOutcome, { ok: false }>['step'], string> = {
  chain: 'We could not check your exam’s details. Wait a minute, then press “Check again”.',
  attestation: 'We could not confirm that this page is connected to the right place. Wait a minute, then press “Check again”.',
  list: 'The list of people for this exam does not match the one your exam board published. Contact your exam board.',
};

const BLOCKED_TITLE = 'We can’t take your questions yet';

function Blocked(props: { outcome: Extract<ConfirmOutcome, { ok: false }> }) {
  const { runConfirm, checking } = useSession();
  return (
    <div className="ss-blocked">
      <Trouble detail={props.outcome.reasons}>Nothing new has been sent. Press “Check again”. If this stays, contact your exam board before you write more.</Trouble>
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
  const title = useExamTitle(examId);

  // Above every screen, so a re-check or the bank closing never loses what is being written. It is
  // held in memory only: a question's text is never stored.
  const [text, setText] = useState('');
  const [topic, setTopic] = useState('');
  const [choice, setChoice] = useState(false);
  const [options, setOptions] = useState<string[]>(() => emptyOptions());
  const [unsure, setUnsure] = useState(false);
  const pending = useRef<PendingSubmission | null>(null);
  const draft: Draft = { text, setText, topic, setTopic, choice, setChoice, options, setOptions, pending, unsure, setUnsure };

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

  const machine = useMachineElsewhere(env.tee, examId);

  const screen = setterScreen({
    configured: session.configured,
    stage,
    statusFailed: statusError !== null,
    registered,
    buildPosted: build.state === 'posted',
    elsewhere: machine.elsewhere,
  });

  // The criteria stay on hand through a re-check, so the writing area never leaves the page.
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  if (confirmed && confirmed.criteria !== criteria) setCriteria(confirmed.criteria);

  // Runs by itself, and again whenever a confirmation ages out. A failure stays until someone asks
  // to check again, so it can't flicker away.
  useEffect(() => {
    if (screen === 'write' && outcome === null && !checking) void runConfirm();
  }, [screen, outcome, checking, runConfirm]);

  // The stage picks the screen, so nothing shows until the first read of it is back.
  const loaded = useLoaded(!session.configured || ((stage !== null || statusError !== null) && machine.settled));

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
        return <Quiet title="Opening your exam…" next="This takes a moment. Then this page shows what to do." />;
      case 'unreachable':
        return (
          <Quiet
            title="Can’t connect right now"
            lede="Check your internet connection. Nothing has been lost."
            next="This page keeps trying by itself. Leave it open, or come back to this link later."
            detail={statusError}
          />
        );
      case 'not-open':
        return (
          <Quiet
            title="Nothing to do yet"
            lede="Your exam board is still setting up this exam, so registration is not open."
            next="Come back to this link later, or leave this page open and it moves on by itself."
          />
        );
      case 'register':
        if (!examId || !env.tee) return null;
        return (
          <Register
            examId={examId}
            tee={env.tee}
            keys={env.keys()}
            onRegistered={session.credentialSaved}
            {...(stage === 'submit' ? { next: 'Then you can write your questions.' } : {})}
          />
        );
      case 'waiting':
        return (
          <SetterRegistered
            next={
              stage === 'onboard'
                ? 'Questions open once your exam board has sent the list of people for this exam. This page opens for writing by itself.'
                : 'Your exam board is still setting up this exam. This page opens for writing by itself.'
            }
          />
        );
      case 'write': {
        const failed = outcome && !outcome.ok ? outcome : null;
        if (!criteria) {
          if (failed) {
            return <Stage title={BLOCKED_TITLE} lede={blockedWhy[failed.step]} action={<Blocked outcome={failed} />} next="Press “Check again” in a minute. If it still fails, your exam board can tell you when to try again." />;
          }
          return <LoadingSeal />;
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

  return <Page header={<RoleHeader role="Setter" exam={title} />}>{loaded ? body() : <LoadingSeal />}</Page>;
}
