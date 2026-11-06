import { checkPasskeyName, resolveExamName, type ExamNameResult, type PasskeyNameResult } from '@paperseal/chain';
import { ownerEnsName, requireHardwareAttestation, roles, toHex, type Hex, type Paper } from '@paperseal/protocol';
import {
  Button,
  Check,
  Field,
  Panel,
  RoleHeader,
  Seal,
  Stepper,
  type SealState,
  type Step,
} from '@paperseal/ui';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { teeStorageBucket } from './attest';
import { loadChain, type ChainData } from './checks';
import { clockTime, custody, dayTime, REPOSITORY, type Custody, type CustodyStep, type Failure } from './custody';
import { Evidence } from './evidence';
import { useExamLink } from './link';
import { useLatestRound, useNow } from './live';
import { loadLive, loadRecords, signedKeyPriv, useProof, type Records } from './load';
import { usePoll, type Polled } from './poll';
import { approvedEntries } from './commitments';
import { createStorage } from './storage';
import {
  defaultSettings,
  endpoints,
  isExamId,
  useConnections,
  validateSettings,
  type Settings as SettingsValues,
  type SettingsErrors,
} from './settings';

/** How often the chain and the public files are read again. Records are written rarely, and once. */
export const RECORDS_POLL_MS = 15_000;
/** Each read of the live TEE also checks a fresh attestation, so it is not read more often than this. */
export const LIVE_POLL_MS = 10_000;

/**
 * Reads the exam name on a `#/name/` route, with the viewer's own RPC and nothing else. An RPC that
 * can't answer has decided nothing, so it is read again like any other source, and a later blip
 * keeps the last good read.
 */
function useExamName(name: string | null, rpcUrl: string, everyMs: number): Polled<ExamNameResult> | undefined {
  const load = useMemo(() => {
    if (name === null || !rpcUrl) return null;
    return async () => {
      const result = await resolveExamName(name, { rpcUrl });
      if (!result.ok && result.failed === 'unreadable') throw new Error(result.reason);
      return result;
    };
  }, [name, rpcUrl]);
  const polled = usePoll(load, everyMs);
  return name === null ? undefined : polled;
}

/**
 * Reads each listed party's ENS name against its security key, with the viewer's own RPC and nothing
 * else. Setters have no name. A name is a label and a proof of who holds a key, never a check the exam
 * depends on, so every answer comes back as a result and a failed read never fails anything.
 */
function usePartyNames(entries: Hex | null, rpcUrl: string, everyMs: number): Polled<Record<string, PasskeyNameResult>> {
  const load = useMemo(() => {
    const listed = approvedEntries(entries ?? null) ?? [];
    const named = listed.flatMap((entry) => {
      const name = entry.role === roles.setter ? null : ownerEnsName(entry.owner);
      return name ? [{ name, key: toHex(entry.passkeyPublicKey) }] : [];
    });
    if (named.length === 0 || !rpcUrl) return null;
    return async () =>
      Object.fromEntries(await Promise.all(named.map(async ({ name, key }) => [key, await checkPasskeyName(name, key, { rpcUrl })] as const)));
  }, [entries, rpcUrl]);
  return usePoll(load, everyMs);
}

function useExamView(pollMs: { records: number; live: number; proofRetry?: number }) {
  const connections = useConnections();
  const { drand, settings, examId: savedExam } = connections;
  const link = useExamLink();
  const name = useExamName(link.kind === 'name' ? link.name : null, settings.rpcUrl, pollMs.records);
  const resolved = name?.state === 'ready' && name.value.ok ? name.value.value : null;

  // On a name route the name supplies the registry and exam, and any TEE, storage and bucket it
  // sets, for this view only. Nothing is loaded until it passes, and nothing is saved.
  const onName = name !== undefined;
  const examId: Hex | null = onName
    ? (resolved?.examId ?? null)
    : link.kind === 'exam'
      ? link.id
      : link.kind === 'invalid'
        ? null
        : savedExam;
  const teeUrl = onName ? (resolved ? (resolved.teeUrl ?? settings.teeUrl) : '') : settings.teeUrl;
  const storageUrl = onName ? (resolved ? (resolved.storageUrl ?? settings.storageUrl) : '') : settings.storageUrl;
  const registryAddress = onName ? (resolved?.registry ?? '') : settings.registryAddress;
  const bucket = resolved?.bucket ?? teeStorageBucket;
  const named = useMemo(
    () => (onName ? endpoints({ rpcUrl: settings.rpcUrl, teeUrl, storageUrl, registryAddress, examId: examId ?? '' }) : null),
    [onName, settings.rpcUrl, teeUrl, storageUrl, registryAddress, examId],
  );
  const tee = named ? named.tee : connections.tee;
  const registry = named ? named.registry : connections.registry;
  const storage = useMemo(() => (storageUrl && examId ? createStorage(storageUrl, examId) : null), [storageUrl, examId]);

  const latest = useLatestRound(drand);
  const now = useNow();

  const loadRecordsNow = useMemo(() => {
    const chain = loadChain(registry, examId);
    if (!chain || !registry || !examId) return null;
    return () => loadRecords({ chain, storage, examId, registry: registry.address as Hex, bucket });
  }, [registry, examId, storage, bucket]);
  const records = usePoll(loadRecordsNow, pollMs.records);

  const chain = records.state === 'ready' ? records.value.chain : null;
  const partyNames = usePartyNames(chain?.entries ?? null, settings.rpcUrl, pollMs.records);
  const chainRef = useRef<ChainData | null>(chain);
  useEffect(() => {
    chainRef.current = chain;
  }, [chain]);

  const examPublished = chain?.exam != null;
  const loadLiveNow = useMemo(() => {
    if (!tee || !registry || !examId || !examPublished) return null;
    return () => loadLive({ tee, chain: () => chainRef.current, examId, registry: registry.address as Hex, bucket });
  }, [tee, registry, examId, examPublished, bucket]);
  const live = usePoll(loadLiveNow, pollMs.live);

  const proof = useProof({
    storage,
    examId,
    client: drand,
    chain,
    keyPrivSha256: records.state === 'ready' ? signedKeyPriv(records.value.log) : null,
    latest,
    now,
    ...(pollMs.proofRetry === undefined ? {} : { retryMs: pollMs.proofRetry }),
  });

  return {
    examId,
    invalidLink: link.kind === 'invalid',
    ...(link.kind === 'name' && name ? { name: { name: link.name, result: name, used: { teeUrl, storageUrl, bucket } } } : {}),
    sources: { chain: registry !== null, storage: storage !== null, tee: tee !== null },
    records,
    partyNames,
    live,
    latest,
    now,
    proof,
  };
}

function SealMark({ state, empty }: { state: SealState | null; empty: string }) {
  // Keep one element mounted, so the seal closes and breaks as its state changes.
  if (state) return <Seal state={state} caption />;
  return (
    <figure className="vf-no-seal">
      <span className="vf-no-seal-ring" aria-hidden="true" />
      <figcaption>{empty}</figcaption>
    </figure>
  );
}

/**
 * The same shape as `Stage`, because `Stage` can only show a seal in one of its three states, and
 * before the paper is sealed this page has to show that there is no seal yet.
 */
function Head({ view, zone }: { view: Custody; zone: string }) {
  return (
    <section className="ps-stage" data-sealed="true">
      <div className="ps-stage-main">
        <p className="ps-eyebrow">Where this exam is now</p>
        <h1 className="ps-stage-title">{view.headline}</h1>
        <div className="ps-stage-lede">
          <p>{view.verdict}</p>
          {requireHardwareAttestation ? null : (
            <p className="vf-demo">This is a demonstration. The security keys are simulated.</p>
          )}
        </div>
        <p className="ps-stage-next">
          <span className="ps-stage-next-label">What happens next</span>
          <span>{view.next}</span>
        </p>
        <p className="vf-zone">Times are in your time zone, {zone}.</p>
      </div>
      <div className="ps-stage-seal">
        <SealMark state={view.seal} empty={view.noSeal} />
      </div>
    </section>
  );
}

function FailureAlarm({ failures }: { failures: readonly Failure[] }) {
  if (failures.length === 0) return null;
  return (
    <section className="vf-alarm" role="alert">
      <h2>{failures.length === 1 ? 'A check failed' : `${String(failures.length)} checks failed`}</h2>
      <ul>
        {failures.map((failure) => (
          <li key={`${String(failure.step)}${failure.message}`}>
            <strong>
              Step {failure.step}, {failure.label}.
            </strong>{' '}
            {failure.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function When({ step, now }: { step: CustodyStep; now: number }) {
  if (step.at === null) return null;
  return (
    <span className="vf-when">
      <span>{clockTime(step.at, now)}</span>
    </span>
  );
}

function toStep(step: CustodyStep, now: number): Step {
  const when = <When step={step} now={now} />;
  const note =
    step.failures.length > 0 ? (
      <span className="vf-step-failures">
        {step.failures.map((failure) => (
          <Check key={failure} status="fail">
            {failure}
          </Check>
        ))}
      </span>
    ) : (
      step.note
    );
  return {
    id: step.id,
    label: `${String(step.number)}. ${step.label}`,
    state: step.state,
    ...(step.at === null ? {} : { when }),
    note: step.aside ? (
      <>
        {note}
        <span className="vf-aside">{step.aside}</span>
      </>
    ) : (
      note
    ),
    evidence: <Evidence items={step.items} />,
  };
}

function PaperView({ paper }: { paper: Paper }) {
  const topics = [...new Set(paper.questions.map((q) => q.topic))];
  return (
    <Panel title="The paper">
      {topics.map((topic) => (
        <section key={topic}>
          <h3>{topic}</h3>
          <ol>
            {paper.questions
              .filter((q) => q.topic === topic)
              .map((q, i) => (
                <li key={i}>
                  {q.text}
                  {q.options ? (
                    <ol className="vf-options" type="A" aria-label="Options">
                      {q.options.map((option, at) => (
                        <li key={at}>{option}</li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
          </ol>
        </section>
      ))}
    </Panel>
  );
}

function Freshness({ records }: { records: Polled<Records> }) {
  if (records.state !== 'ready') return null;
  const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium' }).format(records.readAt);
  return (
    <p className="vf-fresh">
      {records.stale
        ? `The public record could not be read again, so this shows what it said at ${time}. This page keeps trying.`
        : `Last read at ${time}. This page updates by itself.`}
    </p>
  );
}

function ExamPicker({ current, invalid }: { current: boolean; invalid: boolean }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();

  function submit(event: FormEvent) {
    event.preventDefault();
    // A name is passed on as typed: the name check refuses one that is not already normalised.
    const name = draft.trim();
    if (name.includes('.')) {
      setError(undefined);
      setDraft('');
      void navigate(`/name/${encodeURIComponent(name)}`);
      return;
    }
    const id = name.toLowerCase();
    if (!isExamId(id)) {
      setError('Enter an exam ID: 0x followed by 64 letters or digits.');
      return;
    }
    setError(undefined);
    setDraft('');
    void navigate(`/exam/${id}`);
  }

  return (
    <form className="vf-picker" onSubmit={submit}>
      <Field
        label="Exam ID or name"
        hint={
          current
            ? 'To check a different exam, enter its ID or its name, such as jee-main-2026.board.eth.'
            : 'Your exam board publishes this, usually as a link to this page. It is an ID, or a name such as jee-main-2026.board.eth.'
        }
        value={draft}
        error={error ?? (invalid ? 'This link does not hold a valid exam ID. Ask your exam board for the right one.' : undefined)}
        onChange={setDraft}
      />
      <Button type="submit">Open this exam</Button>
    </form>
  );
}

function OwnConnection({ open }: { open: boolean }) {
  const { settings, apply, reset } = useConnections();
  const [draft, setDraft] = useState<SettingsValues>(settings);
  const [errors, setErrors] = useState<SettingsErrors>({});

  const edit = (key: keyof SettingsValues) => (value: string) => {
    setDraft({ ...draft, [key]: value.trim() });
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateSettings(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) apply(draft);
  }

  return (
    <details className="vf-connection" open={open}>
      <summary>Choose where this page reads from</summary>
      <form onSubmit={submit}>
        <Field
          label="Where to read the public record"
          hint="The web address of a service you trust that serves the Sepolia public record (an RPC URL). It must allow requests from this page."
          value={draft.rpcUrl}
          error={errors.rpcUrl}
          onChange={edit('rpcUrl')}
        />
        <Field
          label="Live machine address (optional)"
          hint="The web address of the machine that builds the paper (the TEE URL). It adds live progress. Every other check works without it, and what it says counts only after its proof passes."
          value={draft.teeUrl}
          error={errors.teeUrl}
          onChange={edit('teeUrl')}
        />
        <Field
          label="Where the public files are kept"
          hint="The web address of the public file store, without the exam ID (the storage URL). Files are read from <address>/<exam ID>/. Any copy of the store works, because the checks catch changes. It must allow requests from this page."
          value={draft.storageUrl}
          error={errors.storageUrl}
          onChange={edit('storageUrl')}
        />
        <Field
          label="Exam registry location"
          hint="Where the exam registry lives on the public record: 0x followed by 40 letters or digits (the ExamRegistry address)."
          value={draft.registryAddress}
          error={errors.registryAddress}
          onChange={edit('registryAddress')}
        />
        <div className="vf-actions">
          <Button type="submit">Save</Button>
          <Button
            onClick={() => {
              reset();
              setDraft(defaultSettings);
              setErrors({});
            }}
          >
            Reset to defaults
          </Button>
        </div>
      </form>
    </details>
  );
}

const zoneName = () =>
  new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(0).find((part) => part.type === 'timeZoneName')?.value ??
  'local time';

/** The public verifier: one chain of custody for one exam, and no sign-in. */
export function VerifierPage(props: { pollMs?: { records: number; live: number; proofRetry?: number } }) {
  const view = useExamView(props.pollMs ?? { records: RECORDS_POLL_MS, live: LIVE_POLL_MS });
  const result = custody(view);
  const start = view.records.state === 'ready' ? view.records.value.chain.exam?.settings.examStart : undefined;
  const on = start === undefined ? undefined : dayTime(Number(start));
  // The name shows only once it has passed, so the header never vouches for a name that failed.
  const passedName = result.steps.find((step) => step.id === 'name')?.state === 'done' ? view.name?.name : undefined;
  const exam = passedName ? (on ? `${passedName}, on ${on}` : passedName) : on ? `Exam on ${on}` : undefined;
  const chosen = view.examId !== null || view.name !== undefined;
  // A name that failed a check needs no other connection, only one that could not be read does.
  const needsConnection = view.name ? ['off', 'error'].includes(view.name.result.state) : !view.sources.chain;
  return (
    <div className="ps-shell vf-page">
      <RoleHeader role="Public record" {...(exam ? { exam } : {})} note="Anyone can check this" />
      <main>
        <FailureAlarm failures={result.failures} />
        <Head view={result} zone={zoneName()} />
        {view.records.state === 'error' ? (
          <p className="vf-gap">
            <Check status="not-checked">
              The public record could not be read. This page keeps trying.
              <details>
                <summary>Details</summary>
                {view.records.message}
              </details>
            </Check>
          </p>
        ) : null}
        {view.latest.error && view.latest.round === null ? (
          <p className="vf-gap">
            <Check status="not-checked">
              The public clock could not be reached, so times come from this device&apos;s clock. Nothing opens early because of this.
            </Check>
          </p>
        ) : null}
        <Stepper steps={result.steps.map((step) => toStep(step, view.now))} evidenceLabel="Show the evidence" />
        <Freshness records={view.records} />
        {result.paper ? <PaperView paper={result.paper} /> : null}
        {chosen ? (
          <Panel title="Check a different exam">
            <ExamPicker current invalid={false} />
          </Panel>
        ) : (
          <Panel title="Choose an exam">
            <ExamPicker current={false} invalid={view.invalidLink} />
          </Panel>
        )}
        <section className="ps-panel vf-self-host">
          <h2>Check it yourself</h2>
          <p>
            You don&apos;t have to trust this page, or whoever hosts it. It needs no account, and everything it reads is public, so
            you can read the same records from a source you choose, or{' '}
            <a href={`https://github.com/${REPOSITORY}`} target="_blank" rel="noreferrer">
              host your own copy
            </a>
            . Your choices stay in this browser.
          </p>
          <OwnConnection open={needsConnection} />
        </section>
      </main>
    </div>
  );
}
