import { createArkivReader } from '@paperseal/arkiv';
import { checkPasskeyName, createEnsLookup, resolveExamName, type ExamNameResult } from '@paperseal/chain';
import { createSwarmClient } from '@paperseal/swarm';
import { ownerEnsName, roles, toHex, type Hex, type Paper } from '@paperseal/protocol';
import { Button, Check, CopyButton, Field, Hash, LoadingSeal, PrimaryAction, RoleHeader, Seal, type SealState, useLoaded } from '@paperseal/ui';
import { approvedEntries, createBackupCache, createStorage, loadChain, type BackupSource, type ChainData } from '@paperseal/verify';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { http } from 'viem';

import { AgentCheck, agentCheckPrompt } from './agent-check';
import { RecentExams } from './history-page';
import { clockTime, custody, dayTime, REPOSITORY, type AsideHash, type Custody, type CustodyStep, type Failure, type PartyName, type ReleaseCount } from './custody';
import { Evidence } from './evidence';
import { copies, people, timeline, type People } from './facts';
import { readBoardName, readExamName, readVersion } from './identity';
import { useExamLink, useShareAddress } from './link';
import { useLatestRound, useNow } from './live';
import { loadArkiv, loadLive, loadRecords, releaseRecorded, roundReached, signedKeyPriv, useProof, withinTime, type Records } from './load';
import { eachLimited } from './history';
import { READ_TIMEOUT_MS, usePoll, type Polled } from './poll';
import { momentNotes, renumbered, shownFailures, shownNumbers, shownOrder } from './record';
import { ClockFold, EvidenceSection, MachineRow, PeopleSection, RecordFold, Section } from './sections';
import { loadSwarm } from './swarm';
import {
  arkivWriters,
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
/** Once an exam is over and opened nothing changes, so its records are only looked at now and then. */
export const FINISHED_POLL_MS = 10 * 60_000;
/** How often the public clock is read while an exam still has something ahead of it. */
const CLOCK_POLL_MS = 6000;
/** How many party names are read at once. */
const NAME_READS_AT_ONCE = 4;
/** The exam's names and its Swarm backups change rarely, so they are looked at now and then. */
const SLOW_POLL_MS = 5 * 60_000;
/** A Swarm read fetches each file of a backup, so it gets longer. */
const SWARM_TIMEOUT_MS = 60_000;

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
 * depends on, so every answer comes back as a result and a failed read never fails anything. Each is
 * read as it stood when the list was posted: a name given a new key later says nothing about this
 * exam. Today's record is read only to say a confirmed name has changed since.
 */
function usePartyNames(entries: Hex | null, postedBlock: bigint | null, rpcUrl: string, everyMs: number): Polled<Record<string, PartyName>> {
  const load = useMemo(() => {
    const listed = approvedEntries(entries ?? null) ?? [];
    const named = listed.flatMap((entry) => {
      const name = entry.role === roles.setter ? null : ownerEnsName(entry.owner);
      return name ? [{ name, key: toHex(entry.passkeyPublicKey) }] : [];
    });
    if (named.length === 0 || !rpcUrl || postedBlock === null) return null;
    const readName = async (name: string, key: Hex): Promise<PartyName> => {
      const then = await checkPasskeyName(name, key, { rpcUrl, atBlock: postedBlock });
      if (then.state !== 'confirmed') return then;
      const today = await checkPasskeyName(name, key, { rpcUrl });
      return today.state === 'mismatch' ? { ...then, changedSince: true } : then;
    };
    // A name that answered is kept for the visit. Only one the RPC could not answer is read again.
    const known = new Map<string, PartyName>();
    return async () => {
      const left = named.filter(({ key }) => !known.has(key));
      const read = await eachLimited(left, NAME_READS_AT_ONCE, async ({ name, key }) => [key, await readName(name, key)] as const);
      for (const [key, result] of read) if (result.state !== 'unreadable') known.set(key, result);
      return { ...Object.fromEntries(read), ...Object.fromEntries(known) };
    };
  }, [entries, postedBlock, rpcUrl]);
  return usePoll(load, everyMs);
}

/** Who ran the exam. A name is a label: a failed read shows as its own state and holds up nothing. */
function useIdentity(args: {
  rpcUrl: string;
  board: Hex | null;
  examId: Hex | null;
  registry: Hex | null;
  known: string | null;
  reader: Parameters<typeof readExamName>[0]['reader'];
  writers: readonly Hex[];
  commit: Hex | null;
  imageDigest: Hex | null;
}) {
  const { rpcUrl, board, examId, registry, known, reader, writers, commit, imageDigest } = args;
  const loadBoard = useMemo(() => {
    if (!rpcUrl || !board) return null;
    const lookup = createEnsLookup({ transport: http(rpcUrl, { batch: true }) });
    return () => readBoardName(board, lookup);
  }, [rpcUrl, board]);
  const loadName = useMemo(() => {
    if (known !== null || !rpcUrl || !examId || !registry) return null;
    return () => readExamName({ reader, writers, examId, registry, rpcUrl });
  }, [known, rpcUrl, examId, registry, reader, writers]);
  const loadVersionNow = useMemo(() => (commit && imageDigest ? () => readVersion(REPOSITORY, commit, imageDigest) : null), [commit, imageDigest]);
  return {
    boardName: usePoll(loadBoard, SLOW_POLL_MS),
    examName: usePoll(loadName, SLOW_POLL_MS),
    version: usePoll(loadVersionNow, null),
  };
}

function useExamView(pollMs: { records: number; live: number; proofRetry?: number; finished?: number }) {
  const connections = useConnections();
  const { drand, settings, examId: savedExam, arkiv } = connections;
  const link = useExamLink();
  useShareAddress(link);
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
  const bucket = resolved?.bucket ?? settings.storageBucket;
  const named = useMemo(
    () => (onName ? endpoints({ rpcUrl: settings.rpcUrl, teeUrl, storageUrl, registryAddress, examId: examId ?? '' }) : null),
    [onName, settings.rpcUrl, teeUrl, storageUrl, registryAddress, examId],
  );
  const tee = named ? named.tee : connections.tee;
  const registry = named ? named.registry : connections.registry;
  const storage = useMemo(() => (storageUrl && examId ? createStorage(storageUrl, examId) : null), [storageUrl, examId]);

  // Set further down, once the record says so: this page then reads far less, because nothing changes.
  const [finished, setFinished] = useState(false);
  const recordsEvery = finished ? (pollMs.finished ?? FINISHED_POLL_MS) : pollMs.records;
  const latest = useLatestRound(drand, finished ? recordsEvery : CLOCK_POLL_MS);
  const now = useNow();

  // The Arkiv mirror is read only from published writers: on a name route the ones the name lists
  // now, plus the viewer's own (spec/arkiv.md, "Writers").
  const nameWriters = onName ? (resolved?.arkivWriters ?? null) : null;
  const nameWritersKey = nameWriters ? nameWriters.join(',') : null;
  const writers = useMemo(
    () => arkivWriters(settings.arkivWriters, nameWritersKey === null ? null : nameWritersKey.split(',').filter(Boolean)),
    [settings.arkivWriters, nameWritersKey],
  );
  const wantsArkiv = writers.length > 0 && settings.arkivRpcUrl !== '';
  const arkivReader = useMemo(
    () => (wantsArkiv ? (arkiv?.reader ?? createArkivReader({ rpcUrl: settings.arkivRpcUrl })) : null),
    [wantsArkiv, arkiv, settings.arkivRpcUrl],
  );

  // The Swarm backup, found on Arkiv from the same writers and read through the viewer's own Swarm
  // API (spec/arkiv.md, "Backups"). Off without writers or without a Swarm API.
  const swarmApiUrl = settings.swarmApiUrl;
  const backup = useMemo<BackupSource | null>(() => {
    if (!arkivReader || !swarmApiUrl || !registry || !examId) return null;
    return {
      rows: arkivReader,
      swarm: createSwarmClient({ apiUrl: swarmApiUrl }),
      swarmApiUrl,
      writers: writers.map((writer) => writer.address),
      examId,
      registry: registry.address as Hex,
      cache: createBackupCache(),
    };
  }, [arkivReader, swarmApiUrl, registry, examId, writers]);

  const loadRecordsNow = useMemo(() => {
    const chain = loadChain(registry, examId);
    if (!chain || !registry || !examId) return null;
    return () => loadRecords({ chain, storage, examId, registry: registry.address as Hex, bucket, backup });
  }, [registry, examId, storage, bucket, backup]);
  const records = usePoll(loadRecordsNow, recordsEvery);

  const chain = records.state === 'ready' ? records.value.chain : null;
  const partyNames = usePartyNames(chain?.entries ?? null, chain?.list?.postedBlock ?? null, settings.rpcUrl, recordsEvery);
  const chainRef = useRef<ChainData | null>(chain);
  useEffect(() => {
    chainRef.current = chain;
  }, [chain]);

  const examPublished = chain?.exam != null;
  const endRound = chain?.exam?.settings.endRound;
  const ended = endRound !== undefined && roundReached(Number(endRound), latest.round, now);
  // The live machine only gives progress for an exam under way. Once the release is recorded, or
  // the exam is over, nothing here asks it anything.
  const released = records.state === 'ready' && releaseRecorded(records.value.log);
  const wantsLive = examPublished && !ended && !released;
  const loadLiveNow = useMemo(() => {
    if (!tee || !registry || !examId || !wantsLive) return null;
    return () => loadLive({ tee, chain: () => chainRef.current, examId, registry: registry.address as Hex, bucket });
  }, [tee, registry, examId, wantsLive, bucket]);
  const live = usePoll(loadLiveNow, pollMs.live);

  // Each press of "Read again" bumps this, which makes a new read of Arkiv and Swarm below.
  const [retries, setRetries] = useState(0);
  const loadArkivNow = useMemo(() => {
    if (!arkivReader || !registry || !examId || !examPublished) return null;
    void retries;
    const addresses = writers.map((writer) => writer.address);
    return () =>
      withinTime(
        loadArkiv({ reader: arkivReader, writers: addresses, chain: () => chainRef.current, examId, registry: registry.address as Hex, bucket }),
        READ_TIMEOUT_MS,
        'Arkiv took too long to answer.',
      );
  }, [arkivReader, writers, registry, examId, examPublished, bucket, retries]);
  const arkivRead = usePoll(loadArkivNow, finished ? recordsEvery : pollMs.live * 3);

  // Every backup recorded for this exam, read and checked for the Copies section only.
  const swarmCache = useMemo(() => createBackupCache(), []);
  const writerAddresses = useMemo(() => writers.map((writer) => writer.address), [writers]);
  const loadSwarmNow = useMemo(() => {
    if (!arkivReader || !registry || !examId || !examPublished) return null;
    void retries;
    const client = swarmApiUrl ? createSwarmClient({ apiUrl: swarmApiUrl }) : null;
    return () =>
      withinTime(
        loadSwarm({
          rows: arkivReader,
          swarm: client,
          apiUrl: swarmApiUrl,
          cache: swarmCache,
          chain: () => chainRef.current,
          writers: writerAddresses,
          examId,
          registry: registry.address as Hex,
          bucket,
        }),
        SWARM_TIMEOUT_MS,
        'The backup took too long to read.',
      );
  }, [arkivReader, registry, examId, examPublished, swarmApiUrl, swarmCache, writerAddresses, bucket, retries]);
  const swarmRead = usePoll(loadSwarmNow, finished ? recordsEvery : SLOW_POLL_MS);

  const boardAddress = chain?.registryCode.state === 'match' ? chain.registryCode.board : null;
  const identity = useIdentity({
    rpcUrl: settings.rpcUrl,
    board: boardAddress,
    examId,
    registry: (registry?.address as Hex | undefined) ?? null,
    known: resolved?.name ?? null,
    reader: arkivReader,
    writers: writerAddresses,
    commit: chain?.exam?.commitHash ?? null,
    imageDigest: chain?.exam?.imageDigest ?? null,
  });

  // An exam opened by ID moves to its name once that name has passed every check. The ID keeps working.
  const navigate = useNavigate();
  const verifiedName = identity.examName.state === 'ready' ? identity.examName.value.name : null;
  useEffect(() => {
    if (link.kind === 'exam' && verifiedName) void navigate(`/name/${encodeURIComponent(verifiedName)}`, { replace: true });
  }, [link.kind, verifiedName, navigate]);

  const proof = useProof({
    storage,
    examId,
    client: drand,
    chain,
    keyPrivSha256: records.state === 'ready' ? signedKeyPriv(records.value.log) : null,
    latest,
    now,
    backup,
    ...(pollMs.proofRetry === undefined ? {} : { retryMs: pollMs.proofRetry }),
  });

  const noPaper = chain !== null && chain.build === null;
  const opened = proof?.ok === true && proof.result.state === 'opened';
  const over = ended && (noPaper || opened);
  if (over !== finished) setFinished(over);

  return {
    examId,
    // What the agent prompt names: the registry and storage this view reads, a name's included.
    agent: { registry: registryAddress, storageUrl },
    invalidLink: link.kind === 'invalid',
    ...(link.kind === 'name' && name ? { name: { name: link.name, result: name, used: { teeUrl, storageUrl, bucket }, configuredRegistry: settings.registryAddress } } : {}),
    sources: { chain: registry !== null, storage: storage !== null, tee: tee !== null, arkiv: arkivReader !== null },
    records,
    partyNames,
    live,
    arkiv: arkivRead,
    arkivWriters: writers,
    arkivWritersIgnored: resolved?.arkivWritersIgnored ?? [],
    swarm: swarmRead,
    retryCopies: () => {
      setRetries((count) => count + 1);
    },
    identity,
    board: boardAddress,
    registryAddress: (registry?.address as Hex | undefined) ?? null,
    openedName: resolved?.name ?? null,
    latest,
    now,
    proof,
  };
}

function SealMark({ state, empty }: { state: SealState | null; empty: string }) {
  // Keep one element mounted, so the seal closes and breaks as its state changes.
  if (state) return <Seal state={state} caption={state === 'open' ? 'Approved' : true} />;
  return (
    <figure className="vf-no-seal">
      <span className="vf-no-seal-ring" aria-hidden="true" />
      <figcaption>{empty}</figcaption>
    </figure>
  );
}

/** The address to share: the exam's name once it has passed, and otherwise its ID. */
function shareLinkOf(examId: Hex, name: string | null): string {
  const here = globalThis.location as Location | undefined;
  const base = here ? `${here.origin}${here.pathname}` : '';
  return name ? `${base}#/name/${name}` : `${base}?exam=${examId}`;
}

interface Fact {
  label: string;
  value: string;
  /** Set when the value is an address: it shows short and copyable, so it fits the column. */
  hashLabel?: string;
}

/** The few facts under the verdict, each only once the page knows it. */
function factsOf(args: { start: number | null; board: string | null; found: People | null; releases: ReleaseCount | undefined; checked: string | null; zone: string | undefined }): Fact[] {
  const { start, board, found, releases, checked, zone } = args;
  const approved = found ? found.holders.length + found.centres.length + found.setters.length : null;
  return [
    ...(start === null ? [] : [{ label: 'Exam', value: dayTime(start, zone) }]),
    // A board with no name is shown by its account, which is evidence, so it stays whole one tap away.
    ...(board ? [{ label: 'Run by', value: board, ...(/^0x[0-9a-fA-F]{40}$/.test(board) ? { hashLabel: 'exam board account' } : {}) }] : []),
    ...(approved === null ? [] : [{ label: 'People', value: `${String(approved)} approved` }]),
    // The same count step 6's note gives, so the two can't disagree.
    ...(releases ? [{ label: 'Key releases', value: `${String(releases.count)} of ${String(releases.required)}` }] : []),
    ...(checked ? [{ label: 'Last checked', value: checked }] : []),
  ];
}

function Facts({ facts }: { facts: readonly Fact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="vf-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.hashLabel ? <Hash value={fact.value} label={fact.hashLabel} /> : fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Scrolls to a section and moves focus there, so a keyboard or screen reader follows. */
function goTo(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const still = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
}

/**
 * The page's contents, which follow the reader so the left column always says where they are. The
 * links never change the address: its hash is the page's route.
 */
function SectionNav({ sections }: { sections: readonly { id: string; title: string }[] }) {
  const ids = sections.map((section) => section.id).join(' ');
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const targets = ids.split(' ').flatMap((id) => document.getElementById(id) ?? []);
    if (targets.length === 0 || !('IntersectionObserver' in globalThis)) return;
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setCurrent(entry.target.id);
      },
      { rootMargin: '-30% 0px -60% 0px' },
    );
    for (const target of targets) seen.observe(target);
    return () => {
      seen.disconnect();
    };
  }, [ids]);
  const shown = current ?? sections[0]?.id;
  return (
    <nav className="vf-toc" aria-label="On this page">
      <ol>
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              aria-current={shown === section.id ? 'location' : undefined}
              onClick={(event) => {
                event.preventDefault();
                setCurrent(section.id);
                goTo(section.id);
              }}
            >
              {section.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The verdict, which stays in view while the record scrolls: the seal, the headline, what happens
 * next, a few facts and the ways on. Before the paper is sealed it shows that there is no seal yet.
 */
function Verdict(props: { view: Custody; facts: readonly Fact[]; stale: ReactNode; actions: ReactNode; agent: ReactNode; nav: ReactNode }) {
  const { view } = props;
  const box = useRef<HTMLDivElement>(null);
  // Its height sets where it sticks, so a tall verdict holds by its foot rather than running off the window.
  useEffect(() => {
    const node = box.current;
    if (!node || !('ResizeObserver' in globalThis)) return;
    const measure = new ResizeObserver(() => {
      node.style.setProperty('--vf-verdict-height', `${String(node.offsetHeight)}px`);
    });
    measure.observe(node);
    return () => {
      measure.disconnect();
    };
  }, []);
  return (
    <div className="vf-verdict" ref={box}>
      <SealMark state={view.seal} empty={view.noSeal} />
      <h1 className="vf-headline">{view.headline}</h1>
      <p className="vf-lede">{view.verdict}</p>
      <p className="vf-next">
        <span className="ps-sr">What happens next</span> <span>{view.next}</span>
      </p>
      <Facts facts={props.facts} />
      {props.stale}
      {props.actions}
      {props.agent}
      {props.nav}
    </div>
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

function Warnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="vf-warnings" role="status">
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

/** An aside, with any address it quotes shortened to a copyable hash so it fits on a phone. */
function Aside({ text, hash }: { text: string; hash: AsideHash | undefined }) {
  const at = hash ? text.indexOf(hash.value) : -1;
  if (!hash || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <Hash value={hash.value} label={hash.label} />
      {text.slice(at + hash.value.length)}
    </>
  );
}

const STATE_WORDS: Record<CustodyStep['state'], string> = {
  done: 'Done',
  current: 'In progress',
  waiting: 'Waiting',
  failed: 'Failed',
  'not-applicable': 'Not applicable',
};

function Chevron() {
  return (
    <svg className="vf-chevron" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/**
 * One step: its number on the rail, what happened, when, and its state in words. The whole line opens
 * the evidence. A step's shape and word say its state, so nothing rests on colour.
 */
function StepRow(props: { step: CustodyStep; next: CustodyStep | undefined; now: number; numbers: ReadonlyMap<number, number>; moment: string | undefined; extra: ReactNode }) {
  const { step, now, numbers, moment } = props;
  // An aside that quotes an address holds a button, which can't sit inside the line that opens the step.
  const asideInLine = step.aside && !step.asideHash ? step.aside : null;
  const asideInProof = step.aside && step.asideHash ? step.aside : null;
  return (
    <li className="vf-step" data-state={step.state} data-next={props.next?.state} aria-current={step.state === 'current' ? 'step' : undefined}>
      <details>
        <summary>
          <span className="vf-step-mark" aria-hidden="true">
            {step.number}
          </span>
          <span className="vf-step-body">
            <span className="vf-step-label">{step.label}</span>
            {step.failures.length > 0 ? (
              <span className="vf-step-failures">
                {step.failures.map((failure) => (
                  <Check key={failure} status="fail">
                    {renumbered(failure, numbers)}
                  </Check>
                ))}
              </span>
            ) : (
              <span className="vf-step-note">{step.note}</span>
            )}
            {moment ? <span className="vf-step-note">{moment}</span> : null}
            {asideInLine ? <span className="vf-aside">{asideInLine}</span> : null}
          </span>
          <span className="vf-step-side">
            {step.at === null ? null : <span className="vf-step-time">{clockTime(step.at, now)}</span>}
            <span className={step.state === 'done' ? 'ps-sr' : 'vf-step-word'}>{STATE_WORDS[step.state]}</span>
          </span>
          <Chevron />
        </summary>
        <div className="vf-proof">
          {asideInProof ? (
            <p className="vf-evidence-text">
              <Aside text={asideInProof} hash={step.asideHash} />
            </p>
          ) : null}
          {props.extra}
          <Evidence items={step.items} />
        </div>
      </details>
    </li>
  );
}

const sheetDate = (seconds: number, timeZone?: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', ...(timeZone ? { timeZone } : {}) })
    .format(seconds * 1000)
    .replace(',', '');

/** The opened paper, set as one printed sheet: subjects as headings, questions numbered, options lettered. */
function PaperSheet({ paper, start, zone }: { paper: Paper; start: number | null; zone: string | undefined }) {
  const topics = [...new Set(paper.questions.map((q) => q.topic))];
  return (
    <article className="vf-sheet" aria-label="Question paper">
      <header>
        <strong>Question paper</strong>
        {start === null ? null : <span>{sheetDate(start, zone)}</span>}
      </header>
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
    </article>
  );
}

/** When the record was last read, or why this shows an older read. */
function freshness(records: Polled<Records>, zone: string): { time: string; stale: string | null } | null {
  if (records.state !== 'ready') return null;
  const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium' }).format(records.readAt);
  return {
    time: `${time}, ${zone}`,
    stale: records.stale ? `The public record could not be read again, so this shows what it said at ${time}. This page keeps trying. Times are in ${zone}.` : null,
  };
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

/** The way to the exam history, under the exam box. */
function HistoryLink() {
  return (
    <p className="vf-more">
      <Link to="/exams">See the exam history</Link>, or find the exams a person is listed for.
    </p>
  );
}

/** The viewer's own sources, saved in this browser. The exam history shows it too. */
export function OwnConnection({ open }: { open: boolean }) {
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
          label="Bucket the live machine must name"
          hint="The name of the file store bucket the machine that builds the paper was started with (the storage bucket). Its proof must name exactly this bucket, so a machine started for another store fails that check. Leave this empty only if you have no live machine to check."
          value={draft.storageBucket}
          error={errors.storageBucket}
          onChange={edit('storageBucket')}
        />
        <Field
          label="Exam registry location"
          hint="Where the exam registry lives on the public record: 0x followed by 40 letters or digits (the ExamRegistry address)."
          value={draft.registryAddress}
          error={errors.registryAddress}
          onChange={edit('registryAddress')}
        />
        <Field
          label="Where to read the copy on Arkiv (optional)"
          hint="The web address of an Arkiv node (the Arkiv RPC URL). A copy of the record of releases is kept there, so progress still shows when the live machine cannot be reached. It must allow requests from this page."
          value={draft.arkivRpcUrl}
          error={errors.arkivRpcUrl}
          onChange={edit('arkivRpcUrl')}
        />
        <Field
          label="Who may write the copy on Arkiv (optional)"
          hint="The writer addresses your exam board publishes, with commas between them (the Arkiv writer addresses). Rows from anyone else are never read, and every row is checked before it counts. Leave this empty to turn the copy off."
          value={draft.arkivWriters}
          error={errors.arkivWriters}
          onChange={edit('arkivWriters')}
        />
        <Field
          label="Where to read the backup on Swarm (optional)"
          hint="The web address of a Swarm node's API, usually your own Bee node (the Swarm API URL). The exam board can keep a second copy of the public files on Swarm, found through the copy on Arkiv. This page reads it only when the public files are missing or do not match, and checks every file against the public record before it counts. Leave this empty to turn the backup off."
          value={draft.swarmApiUrl}
          error={errors.swarmApiUrl}
          onChange={edit('swarmApiUrl')}
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

/** Notices that something could not be read. Nothing has failed, and the page keeps trying. */
function ReadNotices({ view }: { view: ReturnType<typeof useExamView> }) {
  return (
    <>
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
    </>
  );
}

/** The quiet close of every page: how to check without trusting this one. */
function CheckYourself({ needsConnection, children }: { needsConnection: boolean; children?: ReactNode }) {
  return (
    <section className="vf-section vf-closing">
      <h2>Check it yourself</h2>
      <p>
        You don&apos;t have to trust this page, or whoever hosts it. It needs no account, and everything it reads is public, so you
        can read the same records from a source you choose, or{' '}
        <a href={`https://github.com/${REPOSITORY}`} target="_blank" rel="noreferrer">
          host your own copy
        </a>
        . Your choices stay in this browser.
      </p>
      <OwnConnection open={needsConnection} />
      {children}
    </section>
  );
}

/** The public verifier: one chain of custody for one exam, and no sign-in. */
export function VerifierPage(props: { pollMs?: { records: number; live: number; proofRetry?: number; finished?: number } }) {
  const view: ReturnType<typeof useExamView> & { timeZone?: string } = useExamView(props.pollMs ?? { records: RECORDS_POLL_MS, live: LIVE_POLL_MS });
  const result = custody(view);
  const startRecorded = view.records.state === 'ready' ? view.records.value.chain.exam?.settings.examStart : undefined;
  const start = startRecorded === undefined ? null : Number(startRecorded);
  const on = start === null ? undefined : dayTime(start);
  // The name shows only once it has passed, so the header never vouches for a name that failed.
  const passedName = result.steps.find((step) => step.id === 'name')?.state === 'done' ? view.name?.name : undefined;
  const exam = passedName ? (on ? `${passedName}, on ${on}` : passedName) : on ? `Exam on ${on}` : undefined;
  const chosen = view.examId !== null || view.name !== undefined;
  const agentReady = chosen ? agentCheckPrompt({ examId: view.examId, registry: view.agent.registry, storageUrl: view.agent.storageUrl }) : null;
  const zone = view.timeZone;
  const recordedExam = view.records.state === 'ready' ? view.records.value.chain.exam : null;
  const found = people(view);
  const held = copies(view, result, view.swarm);
  const moments = timeline(view);
  const boardRead = view.identity.boardName.state === 'ready' ? view.identity.boardName.value : null;
  const boardLabel = boardRead && 'name' in boardRead ? boardRead.name : view.board;
  // A name that failed a check needs no other connection, only one that could not be read does.
  const needsConnection = view.name ? ['off', 'error'].includes(view.name.result.state) : !view.sources.chain;
  // The record decides every step, so the page waits for its first read.
  const loaded = useLoaded(!view.sources.chain || !view.examId || view.records.state !== 'loading');
  if (!loaded) {
    return (
      <div className="ps-shell vf-page">
        <RoleHeader role="Public record" />
        <LoadingSeal />
      </div>
    );
  }

  if (!chosen) {
    return (
      <div className="ps-shell vf-page">
        <RoleHeader role="Public record" />
        <main className="vf-single">
          <section className="vf-start">
            <h1 className="vf-headline">{result.headline}</h1>
            <p className="vf-lede">{result.verdict}</p>
            <p className="vf-next">
              <span className="ps-sr">What happens next</span> <span>{result.next}</span>
            </p>
            <ReadNotices view={view} />
            <ExamPicker current={false} invalid={view.invalidLink} />
          </section>
          {/* Its own link goes to the full history, so the box above needs none. */}
          <RecentExams />
          <CheckYourself needsConnection={needsConnection} />
        </main>
      </div>
    );
  }

  const shown = shownOrder(result.steps);
  const numbers = shownNumbers(result.steps, shown);
  const notes = momentNotes(moments);
  const zoneWords = zoneName();
  const fresh = freshness(view.records, zoneWords);
  const examName = view.openedName ?? (view.identity.examName.state === 'ready' ? view.identity.examName.value.name : null);
  const shareLink = view.examId ? shareLinkOf(view.examId, examName) : null;
  const releases = result.steps.find((step) => step.id === 'unlock')?.releases;
  const sections = [
    { id: 'vf-steps', title: 'How it ran' },
    ...(result.paper ? [{ id: 'vf-paper', title: 'The paper' }] : []),
    ...(found ? [{ id: 'vf-people', title: 'People' }] : []),
    ...(held ? [{ id: 'vf-evidence', title: 'Evidence' }] : []),
  ];
  const record =
    recordedExam && view.examId && view.registryAddress ? (
      <RecordFold examId={view.examId} registry={view.registryAddress} commit={recordedExam.commitHash} imageDigest={recordedExam.imageDigest} />
    ) : null;

  return (
    <div className="ps-shell vf-page">
      <RoleHeader role="Public record" {...(exam ? { exam } : {})} note={<Link to="/">Check another exam</Link>} />
      <main className="vf-columns">
        <Verdict
          view={result}
          facts={factsOf({ start, board: boardLabel, found, releases, checked: fresh?.time ?? null, zone })}
          stale={fresh?.stale ? <p className="vf-fresh">{fresh.stale}</p> : null}
          actions={
            result.paper || shareLink ? (
              <div className="vf-actions">
                {result.paper ? (
                  <PrimaryAction
                    onClick={() => {
                      goTo('vf-paper');
                    }}
                  >
                    Read the paper
                  </PrimaryAction>
                ) : null}
                {shareLink ? <CopyButton text={shareLink}>Copy link</CopyButton> : null}
              </div>
            ) : null
          }
          // The AI check shows only when it can run: not over plain http.
          agent={agentReady?.ok ? <AgentCheck prompt={agentReady.text} /> : null}
          nav={<SectionNav sections={sections} />}
        />
        <div className="vf-record">
          <FailureAlarm failures={shownFailures(result.failures, numbers)} />
          <Warnings warnings={result.warnings} />
          <ReadNotices view={view} />
          <Section id="vf-steps" title="How it ran" intro="Each step of this exam, as the public record shows it. Open a step to see its evidence.">
            <ol className="vf-steps" aria-label="Steps for this exam">
              {shown.map((step, at) => (
                <StepRow
                  key={step.id}
                  step={step}
                  next={shown[at + 1]}
                  now={view.now}
                  numbers={numbers}
                  moment={notes.get(step.id)}
                  extra={step.id === 'published' && recordedExam ? <MachineRow version={view.identity.version} /> : null}
                />
              ))}
            </ol>
            <p className="vf-foot">Times are in {zoneWords}.</p>
            {moments.length > 0 ? <ClockFold moments={moments} /> : null}
          </Section>
          {result.paper ? (
            <Section id="vf-paper" title="The paper" intro="The paper as it was opened after the exam. It matches the paper sealed before the exam.">
              <PaperSheet paper={result.paper} start={start} zone={zone} />
            </Section>
          ) : null}
          {found ? (
            <PeopleSection
              found={found}
              zone={zone}
              board={view.board}
              boardName={view.identity.boardName}
              examName={view.identity.examName}
              openedName={view.openedName}
            />
          ) : null}
          {held ? <EvidenceSection found={held} zone={zone} view={view} onRetry={view.retryCopies} record={record} /> : record}
          <CheckYourself needsConnection={needsConnection}>
            <h3>Check a different exam</h3>
            <ExamPicker current invalid={false} />
            <HistoryLink />
          </CheckYourself>
        </div>
      </main>
    </div>
  );
}
