import type { Hex, Question } from '@paperseal/protocol';
import { Badge, Button, EmptyState, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { describeError, Register } from '../../shared/Register';
import type { ConfirmOutcome } from './confirm';
import {
  compareWithBuild,
  loadReceipts,
  verifyReceipt,
  type BuildMatch,
  type StoredReceipt,
} from './receipts';
import { describeStage, useSession } from './session';
import { checkQuestion, ReceiptInvalidError, sealAndSubmit, submitNotOpen } from './submit';

const stepLabels = { chain: 'Exam on-chain', attestation: 'TEE attestation', list: 'Approved list hash' } as const;

function StageRow() {
  const { status, statusError } = useSession();
  if (statusError) return <Row label="TEE stage">Unavailable: {statusError}</Row>;
  if (!status) return <Row label="TEE stage">Loading.</Row>;
  return (
    <Row label="TEE stage">
      {status.stage}. {describeStage(status.stage)}
    </Row>
  );
}

function Outcome(props: { outcome: ConfirmOutcome }) {
  const { outcome } = props;
  if (outcome.ok) {
    return (
      <Panel title="Confirmed">
        <p>
          <Badge tone="ok">Passed</Badge> The TEE attestation is trusted and the approved list hash it signed equals
          the hash on-chain. Encrypting is open.
        </p>
        <Rows>
          <Row label="TEE instance key">
            <Mono>{outcome.confirmed.instancePublicKey}</Mono>
          </Row>
        </Rows>
      </Panel>
    );
  }
  return (
    <Panel title="Blocked">
      <p role="alert">
        <Badge tone="bad">Blocked</Badge> {stepLabels[outcome.step]} failed. Nothing will be encrypted or sent until
        this passes.
      </p>
      <ul>
        {outcome.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </Panel>
  );
}

export function SignIn() {
  const session = useSession();
  const [again, setAgain] = useState(false);
  const { env, examId, credential } = session;

  if (!session.configured || !examId || !env.tee) {
    return (
      <Screen title="Sign in" lede="Setters sign in with a passkey on a security key.">
        <EmptyState title="Sign-in unavailable">
          Set VITE_TEE_URL, VITE_RPC_URL, VITE_REGISTRY_ADDRESS and VITE_EXAM_ID, or publish an exam, so the app can
          reach the TEE and read ExamRegistry.
        </EmptyState>
      </Screen>
    );
  }

  if (!credential || again) {
    return (
      <Register
        role="setter"
        examId={examId}
        tee={env.tee}
        keys={env.keys()}
        onRegistered={(registered) => {
          session.setCredential(registered);
          setAgain(false);
        }}
      />
    );
  }

  return (
    <Screen title="Sign in" lede="Setters sign in with a passkey on a security key.">
      <Panel title="Your key">
        <Rows>
          <Row label="Name">{credential.owner}</Row>
          <Row label="Passkey public key">
            <Mono>{credential.passkeyPublicKey}</Mono>
          </Row>
          <StageRow />
        </Rows>
        <p>
          The mocked key only lasts this browser session. If the session has ended, register again.
        </p>
        <Button
          onClick={() => {
            setAgain(true);
          }}
        >
          Register again
        </Button>
      </Panel>
      <Panel title="Confirm the TEE">
        <p>
          Before anything is encrypted, the app checks the TEE&apos;s attestation token and that the approved list
          hash the TEE signed matches ExamRegistry.
        </p>
        <Button
          disabled={session.checking}
          onClick={() => {
            void session.runConfirm();
          }}
        >
          {session.checking ? 'Checking' : 'Check the TEE'}
        </Button>
      </Panel>
      {session.outcome ? <Outcome outcome={session.outcome} /> : null}
    </Screen>
  );
}

type ItemState = 'queued' | 'sending' | 'sealed' | 'failed';
interface QueueItem {
  id: number;
  question: Question;
  state: ItemState;
  message?: string;
}

export function Upload() {
  const session = useSession();
  const { confirmed, credential, env, examId, status } = session;
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [nextId, setNextId] = useState(1);
  const [sending, setSending] = useState(false);

  const { refreshStatus } = session;
  useEffect(() => {
    // The stage may have moved since sign-in, so read it again whenever this screen opens.
    void refreshStatus();
  }, [refreshStatus]);

  const patch = (id: number, change: Partial<QueueItem>) => {
    setQueue((items) => items.map((item) => (item.id === id ? { ...item, ...change } : item)));
  };

  if (!confirmed || !credential || !examId || !env.tee) {
    const reasons =
      session.outcome && !session.outcome.ok ? session.outcome.reasons : [];
    return (
      <Screen
        title="Upload questions"
        lede="Questions are padded to a fixed size and encrypted to the TEE's attested key."
      >
        <EmptyState title="Upload locked">
          Questions are only encrypted once the TEE&apos;s attestation passes and its list hash matches the chain.{' '}
          {!credential ? 'Register a key first. ' : 'Run the check on the sign-in screen. '}
          <Link to="/setter">Go to sign in</Link>
          {reasons.length > 0 ? (
            <ul>
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </EmptyState>
      </Screen>
    );
  }

  const stageBlock = status ? submitNotOpen(status.stage) : 'Reading the TEE stage.';
  const selected = topic || confirmed.criteria.topics[0]?.name || '';
  const question: Question = { topic: selected, text };
  const check = checkQuestion(confirmed.criteria, question);

  const add = () => {
    if (check.error) return;
    setQueue((items) => [...items, { id: nextId, question, state: 'queued' }]);
    setNextId(nextId + 1);
    setText('');
  };

  const sendAll = async () => {
    setSending(true);
    const keys = env.keys();
    for (const item of queue.filter((entry) => entry.state === 'queued' || entry.state === 'failed')) {
      patch(item.id, { state: 'sending' });
      try {
        await sealAndSubmit(
          { keys, tee: env.tee as NonNullable<typeof env.tee>, credentialId: credential.credentialId, passkeyPublicKey: credential.passkeyPublicKey },
          confirmed,
          item.question,
        );
        patch(item.id, { state: 'sealed' });
      } catch (error) {
        patch(item.id, {
          state: 'failed',
          message: error instanceof ReceiptInvalidError ? error.message : describeError(error),
        });
        // A refused or unreachable TEE will refuse the rest, so stop and let the setter read why.
        break;
      }
    }
    setSending(false);
    await session.refreshStatus();
  };

  const pending = queue.filter((item) => item.state === 'queued' || item.state === 'failed').length;

  return (
    <Screen
      title="Upload questions"
      lede="Questions are padded to a fixed size and encrypted to the TEE's attested key."
    >
      <Panel title="Status">
        <Rows>
          <StageRow />
        </Rows>
        {stageBlock ? <p role="alert">{stageBlock}</p> : null}
      </Panel>
      <Panel title="New question">
        <label className="ps-field">
          <span>Topic</span>
          <select
            className="ps-input"
            value={selected}
            onChange={(event) => {
              setTopic(event.target.value);
            }}
          >
            {confirmed.criteria.topics.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ps-field">
          <span>Question</span>
          <textarea
            className="ps-input"
            rows={6}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          <span className="ps-field-hint">
            {check.size} of {check.limit} bytes. Every question is padded to the same size before it is encrypted.
          </span>
          {text !== '' && check.error ? <span className="ps-field-error">{check.error}</span> : null}
        </label>
        <Button disabled={check.error !== null} onClick={add}>
          Add to list
        </Button>
      </Panel>
      {queue.length > 0 ? (
        <Panel title="To send">
          <Rows>
            {queue.map((item) => (
              <Row key={item.id} label={item.question.topic}>
                {item.state === 'sealed' ? (
                  <Badge tone="ok">sealed ✓</Badge>
                ) : item.state === 'sending' ? (
                  'Waiting for your security key'
                ) : (
                  <>
                    {item.state === 'failed' ? <span role="alert">{item.message} </span> : 'Queued '}
                    <Button
                      disabled={sending}
                      onClick={() => {
                        setQueue((items) => items.filter((entry) => entry.id !== item.id));
                      }}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </Row>
            ))}
          </Rows>
          <Button
            disabled={sending || pending === 0 || stageBlock !== ''}
            onClick={() => {
              void sendAll();
            }}
          >
            Seal and send {pending} question{pending === 1 ? '' : 's'}
          </Button>
          <p>Each question needs one touch of your security key.</p>
        </Panel>
      ) : null}
    </Screen>
  );
}

type Verified = Record<string, boolean>;

export function matchText(match: BuildMatch): string {
  switch (match) {
    case 'match':
      return 'Matches the Build: your question went to the TEE that built the paper.';
    case 'mismatch':
      return 'Does not match the Build. This question was sealed by a different TEE instance than the one that built the paper, so it may not be in the paper. Tell the board.';
    case 'pending':
      return 'The Build is not posted yet. Check again after the Build.';
  }
}

export function Receipt() {
  const session = useSession();
  const { env, examId, credential } = session;
  // Read on every render: the list is small and uploads write it from another screen.
  const receipts: StoredReceipt[] = examId ? loadReceipts(examId) : [];
  const receiptKey = receipts.map((r) => r.questionHash).join(',');
  const [verified, setVerified] = useState<Verified>({});
  const [build, setBuild] = useState<{ key: Hex | null } | { error: string } | null>(null);

  const passkey = credential?.passkeyPublicKey;
  useEffect(() => {
    if (!examId || !passkey) return;
    let live = true;
    void Promise.all(loadReceipts(examId).map(async (r) => [r.questionHash, await verifyReceipt(examId, passkey, r)] as const)).then(
      (entries) => {
        if (live) setVerified(Object.fromEntries(entries));
      },
    );
    return () => {
      live = false;
    };
  }, [examId, passkey, receiptKey]);

  const checkBuild = useCallback(async () => {
    if (!env.chain || !examId) return;
    try {
      const record = await env.chain.getBuild(examId);
      setBuild({ key: record ? (record.instancePublicKey as Hex) : null });
    } catch (error) {
      setBuild({ error: describeError(error) });
    }
  }, [env.chain, examId]);

  if (receipts.length === 0) {
    return (
      <Screen title="Receipt" lede="Your sealed receipts for this exam, kept in this browser.">
        <Rows>
          <Row label="Sealed questions">0</Row>
        </Rows>
        <EmptyState title="No receipts yet">Upload a question to get a sealed receipt.</EmptyState>
      </Screen>
    );
  }

  const compared =
    build && 'key' in build ? compareWithBuild(receipts, build.key) : null;
  const matchOf = (r: StoredReceipt) => compared?.find((c) => c.receipt.questionHash === r.questionHash)?.match;

  return (
    <Screen title="Receipt" lede="Your sealed receipts for this exam, kept in this browser.">
      <Rows>
        <Row label="Sealed questions">{receipts.length}</Row>
        <StageRow />
      </Rows>
      {receipts.map((receipt) => {
        const ok = verified[receipt.questionHash];
        const match = matchOf(receipt);
        return (
          <Panel key={receipt.questionHash} title="Question">
            <Rows>
              <Row label="Receipt">
                {ok === undefined ? (
                  'Checking the signature.'
                ) : ok ? (
                  <Badge tone="ok">sealed ✓</Badge>
                ) : (
                  <Badge tone="bad">Receipt signature invalid</Badge>
                )}
              </Row>
              <Row label="Question hash">
                <Mono>{receipt.questionHash}</Mono>
              </Row>
              <Row label="TEE instance key">
                <Mono>{receipt.instancePublicKey}</Mono>
              </Row>
              {match ? (
                <Row label="After the Build">
                  <Badge tone={match === 'match' ? 'ok' : match === 'mismatch' ? 'bad' : 'warn'}>
                    {match === 'match' ? 'Match' : match === 'mismatch' ? 'Mismatch' : 'Pending'}
                  </Badge>{' '}
                  {matchText(match)}
                </Row>
              ) : null}
            </Rows>
          </Panel>
        );
      })}
      <Panel title="Check against the Build">
        <p>
          After the Build is posted, each receipt&apos;s instance key must equal the key that signed the Build. If it
          does not, the question went to a different TEE.
        </p>
        <Button
          onClick={() => {
            void checkBuild();
          }}
        >
          Compare with the Build
        </Button>
        {build && 'error' in build ? <p role="alert">{build.error}</p> : null}
        {build && 'key' in build && build.key ? (
          <Rows>
            <Row label="Build instance key">
              <Mono>{build.key}</Mono>
            </Row>
          </Rows>
        ) : null}
      </Panel>
    </Screen>
  );
}
