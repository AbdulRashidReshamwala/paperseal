import type { ClaimCheck } from '@paperseal/attestation';
import {
  decodeApprovedList,
  decodeCriteria,
  fromHex,
  requireHardwareAttestation,
  roles,
  roundTimeSeconds,
  storageNames,
  type Hex,
} from '@paperseal/protocol';
import { Badge, Button, Connected, EmptyState, Field, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  checkFreshToken,
  checkPublishedToken,
  checkRecordToken,
  type Build,
  type Exam,
  type FreshVerdict,
  type PublishedVerdict,
  type RecordVerdict,
} from './attest';
import {
  chainChecks,
  computedListHash,
  criteriaMatches,
  loadChain,
  sameHex,
  type ChainData,
  type ChainProblem,
  type CheckResult,
} from './checks';
import { approvedEntries, checkManifest, holdersOf, type ManifestReport } from './commitments';
import { RoundRow, useLatestRound, useNow, type LatestRound } from './live';
import { runProof, type ProofChecks, type ProofState } from './proof';
import { releaseTokenName, utf8Text } from './storage';
import { checkReleaseLog, parseReleaseLog, releaseProgress, type LogVerdict, type ReleaseProgress } from './unlock';
import {
  defaultSettings,
  useConnections,
  validateSettings,
  type Settings as SettingsValues,
  type SettingsErrors,
} from './settings';

const setChain = 'Set the RPC URL, ExamRegistry address and exam ID under Connection.';
const needsTee = 'Needs a TEE URL, which you can add under Connection. Every chain check works without it.';

/** A panel that needs the optional TEE URL. Without one it is neutral, never a failure. */
function TeePanel<T>(props: {
  title: string;
  load: (() => Promise<T>) | null;
  /** Shown when the TEE URL is set but something else is still missing. */
  notConnected?: string;
  hasTee: boolean;
  /** Reads the TEE again this often, so a live panel doesn't go stale. */
  pollMs?: number;
  children: (value: T) => ReactNode;
}) {
  if (!props.hasTee) return <EmptyState title={`${props.title}: optional`}>{needsTee}</EmptyState>;
  return (
    <Connected
      title={props.title}
      notConnected={props.notConnected ?? needsTee}
      load={props.load}
      {...(props.pollMs === undefined ? {} : { pollMs: props.pollMs })}
    >
      {props.children}
    </Connected>
  );
}

/** How often the live panels read the TEE again. */
export const LIVE_STATUS_POLL_MS = 5000;
/** The live release panel also checks a fresh attestation each time, so it reads less often. */
export const LIVE_RELEASE_POLL_MS = 10_000;

function TeeStatus() {
  const { tee } = useConnections();
  const load = useMemo(() => (tee ? () => tee.status() : null), [tee]);
  return (
    <TeePanel title="Live TEE status" hasTee={tee !== null} load={load} pollMs={LIVE_STATUS_POLL_MS}>
      {(status) => (
        <Rows>
          <Row label="Stage">{status.stage}</Row>
          <Row label="Shares released">
            {status.release.released.length} of {status.release.required}
          </Row>
        </Rows>
      )}
    </TeePanel>
  );
}

/** A record that is on-chain but whose bytes can't be used. Never shown as "not posted". */
function ProblemRow({ label, problem }: { label: string; problem: ChainProblem }) {
  return (
    <Row label={label}>
      <Badge tone={problem.kind === 'mismatch' ? 'bad' : 'warn'}>
        {problem.kind === 'mismatch' ? 'Fail' : 'Could not be read'}
      </Badge>{' '}
      {problem.message}
    </Row>
  );
}

const posted = (written: boolean, yes = 'Posted', no = 'Not posted') => (
  <Badge tone={written ? 'ok' : 'neutral'}>{written ? yes : no}</Badge>
);

/** Pass or Fail, or neutral when there is nothing on the chain to compare yet. */
/** Pass or Fail, or neutral when there is nothing to compare yet. */
const checkBadge = (result: CheckResult, absent = 'Not posted') =>
  result === 'absent' ? (
    <Badge tone="neutral">{absent}</Badge>
  ) : (
    <Badge tone={result === 'pass' ? 'ok' : 'bad'}>{result === 'pass' ? 'Pass' : 'Fail'}</Badge>
  );



export function Overview() {
  const { registry, examId } = useConnections();
  const load = useMemo(() => loadChain(registry, examId), [registry, examId]);
  return (
    <Screen title="Overview" lede="Public checks on this exam. Nothing here needs an account.">
      <Connected title="Chain checks" notConnected={setChain} load={load}>
        {(data) => {
          const checks = chainChecks(examId, data);
          return (
            <Rows>
              <Row label="Exam published">{posted(checks.published, 'Published', 'Not published')}</Row>
              {data.exam && <ExamSettingsRows exam={data.exam} />}
              <Row label="Criteria hash matches the exam">{checkBadge(checks.criteria)}</Row>
              {data.problems?.criteria ? <ProblemRow label="Criteria bytes" problem={data.problems.criteria} /> : null}
              <Row label="Approved list hash matches the chain">{checkBadge(checks.list)}</Row>
              {data.problems?.list ? <ProblemRow label="Approved list bytes" problem={data.problems.list} /> : null}
              <Row label="Build">{posted(checks.build, 'Exists', 'No Build yet')}</Row>
            </Rows>
          );
        }}
      </Connected>
      <TeeStatus />
    </Screen>
  );
}

const clock = (unixSeconds: number) =>
  `${new Date(unixSeconds * 1000).toISOString().replace('.000Z', '')} UTC`;
const roundClock = (round: bigint) => clock(roundTimeSeconds(Number(round)));

const verdict = (ok: boolean) => <Badge tone={ok ? 'ok' : 'bad'}>{ok ? 'Pass' : 'Fail'}</Badge>;
const failure = (error: unknown) => (
  <Badge tone="bad">{error instanceof Error ? error.message : String(error)}</Badge>
);
const roleNames: Record<number, string> = {
  1: 'Setter',
  2: 'Neutral party',
  3: 'Centre, key holder',
  4: 'Approved centre',
};


function ExamSettingsRows({ exam }: { exam: Exam }) {
  const s = exam.settings;
  return (
    <>
      <Row label="T, exam start">{clock(Number(s.examStart))}</Row>
      <Row label="Δ">{String(s.delta)} s</Row>
      <Row label={`Lock round ${s.lockRound}`}>{roundClock(s.lockRound)}</Row>
      <Row label={`Unlock round ${s.unlockRound}`}>{roundClock(s.unlockRound)}</Row>
      <Row label={`End round ${s.endRound}`}>{roundClock(s.endRound)}</Row>
      <Row label="Criteria hash">
        <Mono>{s.criteriaHash}</Mono>
      </Row>
    </>
  );
}

function CriteriaRows({ exam, encoded, problem }: { exam: Exam; encoded: Hex | null; problem?: ChainProblem | undefined }) {
  if (problem) return <ProblemRow label="Criteria" problem={problem} />;
  if (!encoded) return <Row label="Criteria">Not published</Row>;
  const bytes = fromHex(encoded);
  const hashOk = criteriaMatches(bytes, exam.settings.criteriaHash);
  let decoded;
  try {
    decoded = decodeCriteria(bytes);
  } catch (error) {
    return (
      <>
        <Row label="Criteria hash matches the exam">{verdict(hashOk)}</Row>
        <Row label="Criteria decode">{failure(error)}</Row>
      </>
    );
  }
  return (
    <>
      <Row label="Criteria hash matches the exam">{verdict(hashOk)}</Row>
      <Row label="Most of a topic's bank one setter can hold">{decoded.maxSetterPercent}%</Row>
      <Row label="Bank size, times the topic's question count">{decoded.minBankMultiple}x</Row>
      {decoded.topics.map((topic) => (
        <Row key={topic.name} label={`Topic: ${topic.name}`}>
          {topic.questions} questions
        </Row>
      ))}
    </>
  );
}

function ListRows(props: {
  examId: Hex;
  encoded: Hex | null;
  chainHash: Hex | null;
  buildHash: Hex | null;
  problem?: ChainProblem | undefined;
}) {
  const { examId, encoded, chainHash, buildHash } = props;
  if (props.problem) return <ProblemRow label="Approved list" problem={props.problem} />;
  if (!encoded || !chainHash) return <Row label="Approved list">Not posted</Row>;
  const bytes = fromHex(encoded);
  const computed = computedListHash(examId, bytes);
  let entries;
  try {
    entries = decodeApprovedList(bytes);
  } catch (error) {
    entries = error;
  }
  return (
    <>
      <Row label="List hash matches the chain">{verdict(sameHex(computed, chainHash))}</Row>
      <Row label="Recomputed list hash">
        <Mono>{computed}</Mono>
      </Row>
      <Row label="Build's approved list hash">
        {buildHash ? (
          <>
            <Mono>{buildHash}</Mono> {verdict(sameHex(buildHash, computed))}
          </>
        ) : (
          'No Build yet'
        )}
      </Row>
      {Array.isArray(entries) ? (
        entries.map((entry, index) =>
          entry.role === roles.setter ? (
            <Row key={index} label="Setter">
              <Mono>{entry.owner}</Mono>
            </Row>
          ) : (
            <Row key={index} label={roleNames[entry.role] ?? `Unknown role ${entry.role}`}>
              {entry.owner}
            </Row>
          ),
        )
      ) : (
        <Row label="List decode">{failure(entries)}</Row>
      )}
    </>
  );
}

type Neutral = { kind: 'neutral'; message: string };
const neutral = (message: string): Neutral => ({ kind: 'neutral', message });

/** Nothing to judge yet. Never red, because nothing failed. */
function NeutralNote({ children }: { children: ReactNode }) {
  return (
    <p>
      <Badge tone="neutral">Not yet</Badge> {children}
    </p>
  );
}

const short = (value: unknown) => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined');
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
};

function ClaimRow({ check }: { check: ClaimCheck }) {
  return (
    <Row label={<Mono>{check.claim}</Mono>}>
      <Badge tone={check.ok ? 'ok' : 'bad'}>{check.ok ? 'Pass' : 'Fail'}</Badge> <Mono>{short(check.actual)}</Mono>
      {check.ok ? null : (
        <>
          {' '}
          expected <Mono>{short(check.expected)}</Mono>
          {check.note ? ` (${check.note})` : ''}
        </>
      )}
    </Row>
  );
}

function SignatureRow({ signature }: { signature: PublishedVerdict['signature'] }) {
  return (
    <Row label="Token signature, up to Google's root">
      {signature.ok ? <Badge tone="ok">Pass</Badge> : <Badge tone="bad">Fail: {signature.error.message}</Badge>}
    </Row>
  );
}

/** `requireHardwareAttestation`, plainly, so viewers can see when the demo mode is on. */
function HardwarePanel() {
  return (
    <Panel title="Passkey hardware attestation">
      <Rows>
        <Row label={<Mono>requireHardwareAttestation</Mono>}>
          <Badge tone={requireHardwareAttestation ? 'ok' : 'warn'}>{String(requireHardwareAttestation)}</Badge>
        </Row>
      </Rows>
      <p>
        {requireHardwareAttestation
          ? 'The TEE checks that every registered passkey comes from approved security-key hardware.'
          : 'Demo mode. The TEE does not check the attestation chain of registered passkeys, so a software passkey could be registered as a key holder, setter or centre.'}
      </p>
      <p>This is the value in spec/constants.json when this verifier was built. The TEE&apos;s own value is part of its attested image.</p>
    </Panel>
  );
}

type PublishedResult = Neutral | { kind: 'ready'; verdict: PublishedVerdict; build: Build };
type FreshResult = Neutral | { kind: 'ready'; verdict: FreshVerdict };

export function Attestation() {
  const { tee, registry, examId, storage } = useConnections();
  const chainLoad = useMemo(() => loadChain(registry, examId), [registry, examId]);

  const published = useMemo(() => {
    if (!chainLoad || !storage || !registry || !examId) return null;
    return async (): Promise<PublishedResult> => {
      const { exam, build } = await chainLoad();
      if (!exam) return neutral('The exam is not published on the chain yet.');
      if (!build) return neutral('There is no Build on the chain yet, so there is no instance key to check the token against.');
      const bytes = await storage.get(storageNames.token);
      if (!bytes) return neutral(`${storageNames.token} is not in storage yet. It is written before the Build.`);
      const verdict = await checkPublishedToken({
        token: utf8Text(bytes).trim(),
        exam,
        build,
        examId,
        registry: registry.address as Hex,
      });
      return { kind: 'ready', verdict, build };
    };
  }, [chainLoad, storage, registry, examId]);

  const fresh = useMemo(() => {
    if (!chainLoad || !tee || !registry || !examId) return null;
    return async (): Promise<FreshResult> => {
      const { exam } = await chainLoad();
      if (!exam) return neutral('The exam is not published on the chain yet.');
      return { kind: 'ready', verdict: await checkFreshToken({ tee, exam, examId, registry: registry.address as Hex }) };
    };
  }, [chainLoad, tee, registry, examId]);

  return (
    <Screen
      title="Attestation"
      lede="Each check on the TEE's Google-signed token, against the exam settings on the chain."
    >
      <HardwarePanel />
      <Connected
        title="Published token"
        notConnected={`Needs the storage URL, which you can add under Connection, and the chain settings. ${setChain}`}
        load={published}
      >
        {(result) =>
          result.kind === 'neutral' ? (
            <NeutralNote>{result.message}</NeutralNote>
          ) : (
            <Rows>
              <Row label="Whole token, signature and claims and the Build signature">
                <Badge tone={result.verdict.verified ? 'ok' : 'bad'}>{result.verdict.verified ? 'Pass' : 'Fail'}</Badge>
              </Row>
              <SignatureRow signature={result.verdict.signature} />
              {result.verdict.claims.map((check) => (
                <ClaimRow key={check.claim} check={check} />
              ))}
              <Row label="Build signed by the token's instance key">
                {result.verdict.build.ok ? (
                  <Badge tone="ok">Pass</Badge>
                ) : (
                  <Badge tone="bad">Fail: {result.verdict.build.error}</Badge>
                )}
              </Row>
              <Row label="Instance key">
                <Mono>{result.build.instancePublicKey}</Mono>
              </Row>
            </Rows>
          )
        }
      </Connected>
      <TeePanel
        title="Fresh token"
        hasTee={tee !== null}
        notConnected={`Also needs the chain settings. ${setChain}`}
        load={fresh}
      >
        {(result) =>
          result.kind === 'neutral' ? (
            <NeutralNote>{result.message}</NeutralNote>
          ) : (
            <Rows>
              <Row label="Trusted: token signature, every claim and the instance key signature">
                <Badge tone={result.verdict.trusted ? 'ok' : 'bad'}>{result.verdict.trusted ? 'Pass' : 'Fail'}</Badge>
              </Row>
              <SignatureRow signature={result.verdict.signature} />
              {result.verdict.claims.map((check) => (
                <ClaimRow key={check.claim} check={check} />
              ))}
              <Row label="Instance key signs the encryption key">
                {result.verdict.instanceKey.ok ? (
                  <Badge tone="ok">Pass</Badge>
                ) : (
                  <Badge tone="bad">Fail: {result.verdict.instanceKey.error}</Badge>
                )}
              </Row>
              <Row label="Instance key">
                <Mono>{result.verdict.instancePublicKey}</Mono>
              </Row>
            </Rows>
          )
        }
      </TeePanel>
    </Screen>
  );
}


type ManifestResult =
  | Neutral
  | { kind: 'ready'; report: ManifestReport; build: Build | null; owners: Record<string, string> };

function ManifestRows({ result }: { result: Extract<ManifestResult, { kind: 'ready' }> }) {
  const { report, build, owners } = result;
  return (
    <Rows>
      <Row label="Manifest hash matches the Build's storageManifestHash">
        <Mono>{report.hash}</Mono> {checkBadge(report.hashCheck, 'No Build yet')}
      </Row>
      {build && (
        <Row label="Build's storageManifestHash">
          <Mono>{build.storageManifestHash}</Mono>
        </Row>
      )}
      {report.kind === 'malformed' ? (
        <Row label="Manifest format">
          <Badge tone="bad">Fail: {report.error}</Badge>
        </Row>
      ) : (
        <>
          <Row label="Manifest is for this exam">{checkBadge(report.examIdCheck)}</Row>
          <Row label="Lists every file, with one share per key holder on the approved list">
            {checkBadge(report.coverage.check, 'No approved list yet')}
            {report.coverage.error ? ` ${report.coverage.error}` : ''}
          </Row>
          {report.files.map((file) => (
            <Row key={file.name} label={<Mono>{file.name}</Mono>}>
              <Mono>{file.sha256}</Mono>
              {file.recipient && (
                <>
                  {' '}
                  recipient {owners[file.recipient] ?? 'not an approved key holder'}{' '}
                  {file.recipientOnList ? checkBadge(file.recipientOnList) : null}
                </>
              )}
            </Row>
          ))}
        </>
      )}
    </Rows>
  );
}

export function Commitments() {
  const { registry, examId, storage } = useConnections();
  const chainLoad = useMemo(() => loadChain(registry, examId), [registry, examId]);

  const manifest = useMemo(() => {
    if (!chainLoad || !storage || !examId) return null;
    return async (): Promise<ManifestResult> => {
      const { build, entries } = await chainLoad();
      const bytes = await storage.get(storageNames.manifest);
      if (!bytes) return neutral(`${storageNames.manifest} is not in storage yet. It is written before the Build.`);
      const list = approvedEntries(entries);
      return {
        kind: 'ready',
        report: checkManifest(bytes, { examId, build, entries: list }),
        build,
        owners: Object.fromEntries((list ? holdersOf(list) : []).map((h) => [h.derivedPublicKey, h.owner])),
      };
    };
  }, [chainLoad, storage, examId]);

  return (
    <Screen title="Commitments" lede="Write-once records in ExamRegistry, and the files in storage they commit to.">
      <Connected title="ExamRegistry" notConnected={setChain} load={chainLoad}>
        {({ exam, list, build, criteria, entries, problems }) => (
          <Rows>
            <Row label="Exam settings">{posted(exam !== null)}</Row>
            {exam && <ExamSettingsRows exam={exam} />}
            {exam && <CriteriaRows exam={exam} encoded={criteria} problem={problems?.criteria} />}
            <Row label="Approved list">{posted(list !== null)}</Row>
            {examId && (
              <ListRows
                examId={examId}
                encoded={entries}
                chainHash={list?.listHash ?? null}
                buildHash={build?.approvedListHash ?? null}
                problem={problems?.list}
              />
            )}
            <Row label="Build">{posted(build !== null)}</Row>
            {build && (
              <Row label="Selected from bank">
                {build.selected} of {build.bankSize}
              </Row>
            )}
          </Rows>
        )}
      </Connected>
      <Connected
        title="Storage manifest"
        notConnected={`Needs the storage URL, which you can add under Connection, and the chain settings. ${setChain}`}
        load={manifest}
      >
        {(result) =>
          result.kind === 'neutral' ? <NeutralNote>{result.message}</NeutralNote> : <ManifestRows result={result} />
        }
      </Connected>
    </Screen>
  );
}


function Schedule({ exam }: { exam: Exam }) {
  const { drand } = useConnections();
  const latest = useLatestRound(drand);
  const now = useNow();
  const s = exam.settings;
  return (
    <Rows>
      <Row label="Latest drand round">
        {latest.round !== null ? (
          <Mono>{latest.round}</Mono>
        ) : (
          <Badge tone="neutral">{latest.error ? 'drand not reached' : 'Loading'}</Badge>
        )}
      </Row>
      <RoundRow label="Lock" round={s.lockRound} latest={latest} now={now} at={roundClock(s.lockRound)} />
      <RoundRow label="Unlock, T minus Δ" round={s.unlockRound} latest={latest} now={now} at={roundClock(s.unlockRound)} />
      <RoundRow label="End, paper opens" round={s.endRound} latest={latest} now={now} at={roundClock(s.endRound)} />
    </Rows>
  );
}

/**
 * Release progress. Until `trusted`, which says the TEE or token behind it passed, every badge is
 * neutral: a count from an unverified source is something said, not evidence.
 */
function ProgressRows({ progress, trusted }: { progress: ReleaseProgress; trusted: boolean }) {
  return (
    <>
      <Row label="Holders released">
        {progress.count} of {progress.required} needed{trusted ? '' : ' (not verified)'}
      </Row>
      {progress.rows.map((row) => (
        <Row key={`${row.owner}${String(row.role)}`} label={`${row.owner}, ${roleNames[row.role] ?? 'key holder'}`}>
          <Badge tone={row.released && trusted ? 'ok' : 'neutral'}>{row.released ? 'Released' : 'Not released'}</Badge>
        </Row>
      ))}
      {progress.unknown.map((key) => (
        <Row key={key} label="Released by a key that is not an approved key holder">
          <Badge tone={trusted ? 'bad' : 'neutral'}>{trusted ? 'Fail' : 'Unverified'}</Badge> <Mono>{key}</Mono>
        </Row>
      ))}
    </>
  );
}

function LogRows(props: { verdict: LogVerdict; signatureLabel: string; signatureAbsent: string }) {
  const { verdict } = props;
  return (
    <>
      <Row label="Log is for this exam">{checkBadge(verdict.examId)}</Row>
      <Row label="entriesHash matches the entries">{checkBadge(verdict.entriesHash)}</Row>
      <Row label={props.signatureLabel}>{checkBadge(verdict.signature, props.signatureAbsent)}</Row>
      {verdict.error ? (
        <Row label="Log error">
          <Badge tone="bad">{verdict.error}</Badge>
        </Row>
      ) : null}
    </>
  );
}

type LogResult =
  | Neutral
  | { kind: 'malformed'; message: string }
  | {
      kind: 'ready';
      verdict: LogVerdict;
      /** The `release-token.jwt` check, or null if the token is not in storage. */
      token: RecordVerdict | null;
      progress: ReleaseProgress | null;
    };

type LiveResult =
  | Neutral
  | {
      kind: 'ready';
      fresh: FreshVerdict;
      stage: string;
      required: number;
      progress: ReleaseProgress | null;
      released: number;
      log: LogVerdict | null;
    };

export function UnlockStatus() {
  const { tee, registry, examId, storage } = useConnections();
  const chainLoad = useMemo(() => loadChain(registry, examId), [registry, examId]);

  const schedule = useMemo(() => {
    if (!chainLoad) return null;
    return async () => (await chainLoad()).exam;
  }, [chainLoad]);

  const published = useMemo(() => {
    if (!chainLoad || !storage || !examId) return null;
    return async (): Promise<LogResult> => {
      const { entries } = await chainLoad();
      const bytes = await storage.get(storageNames.releaseLog);
      if (!bytes) return neutral(`${storageNames.releaseLog} is not in storage yet. The TEE writes it at unlock.`);
      let log;
      try {
        log = parseReleaseLog(bytes);
      } catch (error) {
        return { kind: 'malformed', message: (error as Error).message };
      }
      const tokenBytes = await storage.get(releaseTokenName);
      const { exam } = await chainLoad();
      const token =
        tokenBytes && exam && registry
          ? await checkRecordToken({
              token: utf8Text(tokenBytes).trim(),
              exam,
              examId,
              registry: registry.address as Hex,
              instancePublicKey: log.instancePublicKey,
            })
          : null;
      const list = approvedEntries(entries);
      return {
        kind: 'ready',
        // The log's own key is only used once `release-token.jwt` attests it. Until then there is no
        // key to check under, so the signature shows "Not checked" and never a pass.
        verdict: await checkReleaseLog(log, examId, token?.verified ? log.instancePublicKey : null),
        token,
        progress: list
          ? releaseProgress(
              holdersOf(list),
              log.entries.map((entry) => entry.passkeyPublicKey),
            )
          : null,
      };
    };
  }, [chainLoad, storage, registry, examId]);

  const live = useMemo(() => {
    if (!chainLoad || !tee || !registry || !examId) return null;
    return async (): Promise<LiveResult> => {
      const { exam, entries } = await chainLoad();
      if (!exam) return neutral('The exam is not published on the chain yet.');
      const [fresh, status, log] = await Promise.all([
        checkFreshToken({ tee, exam, examId, registry: registry.address as Hex }),
        tee.status(),
        tee.releaseLog().catch(() => null),
      ]);
      const list = approvedEntries(entries);
      return {
        kind: 'ready',
        fresh,
        stage: status.stage,
        required: status.release.required,
        released: status.release.released.length,
        progress: list ? releaseProgress(holdersOf(list), status.release.released) : null,
        // A log is only checked under a key whose attestation passed.
        // Only a log signed by the key that just passed attestation is checked.
        log: log
          ? await checkReleaseLog(
              log,
              examId,
              fresh.trusted && log.instancePublicKey === fresh.instancePublicKey ? fresh.instancePublicKey : null,
            )
          : null,
      };
    };
  }, [chainLoad, tee, registry, examId]);

  return (
    <Screen
      title="Unlock status"
      lede="Which holders have released, and the signed log. Shares are never published."
    >
      <Connected title="Round clock" notConnected={setChain} load={schedule}>
        {(exam) =>
          exam ? <Schedule exam={exam} /> : <NeutralNote>The exam is not published on the chain yet.</NeutralNote>
        }
      </Connected>
      <Connected
        title="Published release log"
        notConnected={`Needs the storage URL, which you can add under Connection, and the chain settings. ${setChain}`}
        load={published}
      >
        {(result) => {
          if (result.kind === 'neutral') return <NeutralNote>{result.message}</NeutralNote>;
          if (result.kind === 'malformed') {
            return (
              <Rows>
                <Row label="Release log format">
                  <Badge tone="bad">Fail: {result.message}</Badge>
                </Row>
              </Rows>
            );
          }
          const trusted = result.token?.verified === true;
          return (
            <>
              {trusted ? null : (
                <p>
                  <Badge tone="warn">Unverified</Badge> Until that token passes, nothing says which TEE signed this
                  log, so its release list is not evidence.
                </p>
              )}
              <Rows>
                <LogRows
                  verdict={result.verdict}
                  signatureLabel="Signed by the key the log names"
                  signatureAbsent="Not checked"
                />
                {result.progress && <ProgressRows progress={result.progress} trusted={trusted} />}
              </Rows>
              <Rows>
                <Row label="release-token.jwt attests the key that signed the log">
                  {result.token ? (
                    <>
                      <Badge tone={result.token.verified ? 'ok' : 'bad'}>{result.token.verified ? 'Pass' : 'Fail'}</Badge>{' '}
                      {result.token.signature.ok ? null : result.token.signature.error.message}
                      {result.token.claims
                        .filter((claim) => !claim.ok)
                        .map((claim) => ` ${claim.claim}`)
                        .join('')}
                    </>
                  ) : (
                    <Badge tone="neutral">Not in storage yet or the exam is not published</Badge>
                  )}
                </Row>
              </Rows>
            </>
          );
        }}
      </Connected>
      <TeePanel
        title="Live TEE release"
        hasTee={tee !== null}
        notConnected={`Also needs the chain settings. ${setChain}`}
        load={live}
        pollMs={LIVE_RELEASE_POLL_MS}
      >
        {(result) =>
          result.kind === 'neutral' ? (
            <NeutralNote>{result.message}</NeutralNote>
          ) : (
            <>
              {result.fresh.trusted ? null : (
                <p>
                  <Badge tone="warn">Unverified</Badge> The TEE failed attestation, so what it reports here is not
                  evidence. See Attestation.
                </p>
              )}
              <Rows>
                <Row label="TEE attestation passes, so its answers can be trusted">
                  <Badge tone={result.fresh.trusted ? 'ok' : 'bad'}>{result.fresh.trusted ? 'Pass' : 'Fail'}</Badge>
                </Row>
                <Row label="Stage">
                  {result.stage}
                  {result.fresh.trusted ? '' : ' (not verified)'}
                </Row>
                {result.progress ? (
                  <ProgressRows progress={result.progress} trusted={result.fresh.trusted} />
                ) : (
                  <Row label="Holders released">
                    {result.released} of {result.required} needed{result.fresh.trusted ? '' : ' (not verified)'}
                  </Row>
                )}
                {result.log ? (
                  <LogRows
                    verdict={result.log}
                    signatureLabel="Signed by the live TEE's attested key"
                    signatureAbsent="Not checked, the log is not signed by the attested key"
                  />
                ) : (
                  <Row label="Release log">
                    <Badge tone="neutral">Not available yet</Badge>
                  </Row>
                )}
              </Rows>
            </>
          )
        }
      </TeePanel>
    </Screen>
  );
}


const proofLabels: Record<keyof ProofChecks, string> = {
  paperFile: 'paper.bin is the file the Build hashed (paperHash)',
  saltedHash: 'Seed and paper give the Build’s saltedPaperHash',
  examId: 'Paper is for this exam',
  selectedCount: 'Question count equals the Build’s selected',
  criteriaCount: 'Build’s selected equals the published criteria’s total',
  topics: 'Each topic has the question count the criteria ask for',
  criteriaHash: 'Published criteria match the exam’s criteriaHash',
};

function PaperView({ paper }: { paper: NonNullable<Extract<ProofState, { state: 'opened' }>['paper']> }) {
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
                <li key={i}>{q.text}</li>
              ))}
          </ol>
        </section>
      ))}
    </Panel>
  );
}

function ProofResult({ result, latest, now }: { result: ProofState; latest: LatestRound; now: number }) {
  switch (result.state) {
    case 'not-ready':
      return <EmptyState title="Proof: not ready">{result.reason}</EmptyState>;
    case 'waiting':
      return (
        <Panel title="The paper is not open yet">
          <p>
            The paper opens when drand publishes round {result.endRound}, at {clock(result.opensAt)}. Nothing here can
            open it sooner.
          </p>
          <Rows>
            <RoundRow label="Paper opens" round={result.endRound} latest={latest} now={now} />
          </Rows>
        </Panel>
      );
    case 'sealed':
      return (
        <EmptyState title="No copy exists, and the paper stays sealed">
          The end round has passed, and storage holds no {storageNames.keyPriv}. If the unlock never happened, the
          timelocked copy of K_priv was never published, so nobody can open the paper. If you expected an unlock, check
          the storage URL under Connection.
        </EmptyState>
      );
    case 'failed':
      return (
        <Panel title="The paper did not open">
          <Rows>
            <Row label={result.step === 'files' ? 'Files' : result.step === 'timelock' ? 'Timelock' : 'Paper decryption'}>
              <Badge tone="bad">Fail: {result.message}</Badge>
            </Row>
          </Rows>
        </Panel>
      );
    case 'opened':
      return (
        <>
          <Panel title="Checks">
            <Rows>
              {(Object.keys(proofLabels) as (keyof ProofChecks)[]).map((name) => (
                <Row key={name} label={proofLabels[name]}>
                  {checkBadge(result.checks[name], 'No criteria on the chain')}
                </Row>
              ))}
              {result.parseError ? (
                <Row label="Paper format">
                  <Badge tone="bad">{result.parseError}</Badge>
                </Row>
              ) : null}
            </Rows>
            <p>
              Selection is attested by the TEE, not independently proven, because the bank stays hidden. The salted
              hash shows this is the paper the Build committed to, not what a centre showed students.
            </p>
          </Panel>
          {result.paper ? (
            <PaperView paper={result.paper} />
          ) : (
            <EmptyState title="Paper withheld">
              The paper opened, but it is not shown because it does not match the Build.
            </EmptyState>
          )}
        </>
      );
  }
}

type ProofRun = { key: string; value: { ok: true; result: ProofState } | { ok: false; message: string } };

/** Waits for the end round, then opens the paper once. Never reruns on the countdown tick. */
function ProofBody({ data }: { data: ChainData }) {
  const { storage, examId, drand } = useConnections();
  const latest = useLatestRound(drand);
  const now = useNow();
  const { exam, build, criteria } = data;
  const endRound = exam ? Number(exam.settings.endRound) : null;
  const reached =
    endRound !== null && (latest.round !== null ? latest.round >= endRound : now >= roundTimeSeconds(endRound));
  const key = `${String(reached)}|${String(latest.round !== null)}|${String(build?.postedAt)}`;
  const [run, setRun] = useState<ProofRun | null>(null);
  const currentRound = latest.round;

  useEffect(() => {
    if (!reached) return;
    let live = true;
    runProof({ storage, examId, exam, build, criteria, currentRound, now: Math.floor(Date.now() / 1000), client: drand }).then(
      (result) => {
        if (live) setRun({ key, value: { ok: true, result } });
      },
      (error: unknown) => {
        if (live) setRun({ key, value: { ok: false, message: error instanceof Error ? error.message : String(error) } });
      },
    );
    return () => {
      live = false;
    };
    // The round and the clock only decide when to start. Later ticks must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, storage, examId, drand, exam, build, criteria]);

  if (!exam || endRound === null) {
    return <EmptyState title="Proof: not ready">The exam is not published on the chain yet.</EmptyState>;
  }
  if (!reached) {
    return <ProofResult result={{ state: 'waiting', endRound, opensAt: roundTimeSeconds(endRound) }} latest={latest} now={now} />;
  }
  if (run?.key !== key) return <EmptyState title="Proof">Opening the paper.</EmptyState>;
  if (!run.value.ok) return <EmptyState title="Proof: unavailable">{run.value.message}</EmptyState>;
  return <ProofResult result={run.value.result} latest={latest} now={now} />;
}

export function Proof() {
  const { registry, examId } = useConnections();
  const load = useMemo(() => loadChain(registry, examId), [registry, examId]);
  return (
    <Screen
      title="Post-exam proof"
      lede="At the end round, drand opens the paper for everyone. This page opens it and checks it against the Build."
    >
      <Connected title="Proof" notConnected={`${setChain} The storage URL is needed too.`} load={load}>
        {(data) => <ProofBody data={data} />}
      </Connected>
    </Screen>
  );
}


export function Settings() {
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
    <Screen
      title="Connection"
      lede="Use your own endpoints, so you don't rely on the ones the board picks. Saved in this browser only."
    >
      <Panel>
        <form onSubmit={submit}>
          <Field
            label="Sepolia RPC URL"
            hint="Any Sepolia endpoint you trust. It must allow requests from this page."
            value={draft.rpcUrl}
            error={errors.rpcUrl}
            onChange={edit('rpcUrl')}
          />
          <Field
            label="TEE URL (optional)"
            hint="Adds fresh attestation and live release progress. The chain checks work without it. The TEE is untrusted until its attestation passes."
            value={draft.teeUrl}
            error={errors.teeUrl}
            onChange={edit('teeUrl')}
          />
          <Field
            label="Storage URL"
            hint="The public bucket's base URL, with no exam ID. Files are read from <URL>/<exam ID>/. Hashes protect the content, so any copy of the bucket works. It must allow requests from this page."
            value={draft.storageUrl}
            error={errors.storageUrl}
            onChange={edit('storageUrl')}
          />
          <Field
            label="ExamRegistry address"
            value={draft.registryAddress}
            error={errors.registryAddress}
            onChange={edit('registryAddress')}
          />
          <Field label="Exam ID" value={draft.examId} error={errors.examId} onChange={edit('examId')} />
          <Button type="submit">Save</Button>{' '}
          <Button
            onClick={() => {
              reset();
              setDraft(defaultSettings);
              setErrors({});
            }}
          >
            Reset to defaults
          </Button>
        </form>
      </Panel>
    </Screen>
  );
}
