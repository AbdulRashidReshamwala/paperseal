import type { ExamRegistry } from '@paperseal/chain';
import { checkToken, type ClaimCheck } from '@paperseal/attestation';
import {
  chain,
  decodeApprovedList,
  decodeCriteria,
  fromHex,
  roundTimeSeconds,
  type Hex,
} from '@paperseal/protocol';
import { Badge, Button, Connected, EmptyState, Field, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { chainChecks, computedListHash, criteriaMatches, loadChain, sameHex, type CheckResult } from './checks';
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
  children: (value: T) => ReactNode;
}) {
  if (!props.hasTee) return <EmptyState title={`${props.title}: optional`}>{needsTee}</EmptyState>;
  return (
    <Connected title={props.title} notConnected={props.notConnected ?? needsTee} load={props.load}>
      {props.children}
    </Connected>
  );
}

function TeeStatus() {
  const { tee } = useConnections();
  const load = useMemo(() => (tee ? () => tee.status() : null), [tee]);
  return (
    <TeePanel title="Live TEE status" hasTee={tee !== null} load={load}>
      {(status) => (
        <Rows>
          <Row label="Stage">{status.stage}</Row>
          <Row label="Shares released">
            {status.release.holders.length} of {status.release.required}
          </Row>
        </Rows>
      )}
    </TeePanel>
  );
}

const posted = (written: boolean, yes = 'Posted', no = 'Not posted') => (
  <Badge tone={written ? 'ok' : 'neutral'}>{written ? yes : no}</Badge>
);

/** Pass or Fail, or neutral when there is nothing on the chain to compare yet. */
const checkBadge = (result: CheckResult) =>
  result === 'absent' ? (
    <Badge tone="neutral">Not posted</Badge>
  ) : (
    <Badge tone={result === 'pass' ? 'ok' : 'bad'}>{result === 'pass' ? 'Pass' : 'Fail'}</Badge>
  );

function ClaimRow({ check }: { check: ClaimCheck }) {
  return (
    <Row label={<Mono>{check.claim}</Mono>}>
      <Badge tone={check.ok ? 'ok' : 'bad'}>{check.ok ? 'Pass' : 'Fail'}</Badge>
    </Row>
  );
}

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
              <Row label="Approved list hash matches the chain">{checkBadge(checks.list)}</Row>
              <Row label="Build">{posted(checks.build, 'Exists', 'No Build yet')}</Row>
            </Rows>
          );
        }}
      </Connected>
      <TeeStatus />
    </Screen>
  );
}

export function Attestation() {
  const { tee, registry, examId } = useConnections();
  /*
   * spec/ does not list approved VM types, so that check is given nothing to match
   * and fails. The container args check is not implemented in @paperseal/attestation
   * and reports that itself.
   */
  const load = useMemo(() => {
    if (!tee || !registry || !examId) return null;
    return async () => {
      const [{ token, instancePublicKey }, exam] = await Promise.all([
        tee.attestation(),
        registry.getExam(examId),
      ]);
      if (!exam) throw new Error('This exam has not been published.');
      return checkToken(
        token,
        {
          instancePublicKey: fromHex(instancePublicKey),
          examId: fromHex(examId),
          imageDigest: exam.imageDigest,
          approvedHwModels: [],
          settings: {
            examId: exam.settings.examId,
            examStart: Number(exam.settings.examStart),
            delta: Number(exam.settings.delta),
            lockRound: String(exam.settings.lockRound),
            unlockRound: String(exam.settings.unlockRound),
            endRound: String(exam.settings.endRound),
            criteriaHash: exam.settings.criteriaHash,
            rpcHost: exam.settings.rpcHost,
            registry: registry.address,
            chainId: chain.chainId,
          },
          registry: registry.address,
          cmdOverride: [],
          env: {},
        },
        { mode: 'live', now: Math.floor(Date.now() / 1000) },
      );
    };
  }, [tee, registry, examId]);

  return (
    <Screen title="Attestation" lede="Each check on the TEE's Google-signed token.">
      <TeePanel
        title="Fresh attestation"
        hasTee={tee !== null}
        notConnected={`Also needs the chain settings. ${setChain}`}
        load={load}
      >
        {(verdict) => (
          <Rows>
            <Row label={<Mono>signature</Mono>}>
              {verdict.signature.ok ? (
                <Badge tone="ok">Pass</Badge>
              ) : (
                <Badge tone="bad">{verdict.signature.error.message}</Badge>
              )}
            </Row>
            {verdict.claims.map((check) => (
              <ClaimRow key={check.claim} check={check} />
            ))}
          </Rows>
        )}
      </TeePanel>
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

type Exam = NonNullable<Awaited<ReturnType<ExamRegistry['getExam']>>>;

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

function CriteriaRows({ exam, encoded }: { exam: Exam; encoded: Hex | null }) {
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
}) {
  const { examId, encoded, chainHash, buildHash } = props;
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
        entries.map((entry, index) => (
          <Row key={index} label={roleNames[entry.role] ?? `Unknown role ${entry.role}`}>
            {entry.owner}
          </Row>
        ))
      ) : (
        <Row label="List decode">{failure(entries)}</Row>
      )}
    </>
  );
}

export function Commitments() {
  const { registry, examId } = useConnections();
  const load = useMemo(() => loadChain(registry, examId), [registry, examId]);

  return (
    <Screen title="Commitments" lede="Write-once records in ExamRegistry.">
      <Connected title="ExamRegistry" notConnected={setChain} load={load}>
        {({ exam, list, build, criteria, entries }) => (
          <Rows>
            <Row label="Exam settings">{posted(exam !== null)}</Row>
            {exam && <ExamSettingsRows exam={exam} />}
            {exam && <CriteriaRows exam={exam} encoded={criteria} />}
            <Row label="Approved list">{posted(list !== null)}</Row>
            {examId && (
              <ListRows
                examId={examId}
                encoded={entries}
                chainHash={list?.listHash ?? null}
                buildHash={build?.approvedListHash ?? null}
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
    </Screen>
  );
}

export function UnlockStatus() {
  const { tee } = useConnections();
  const load = useMemo(() => (tee ? () => tee.releaseLog() : null), [tee]);
  return (
    <Screen title="Unlock status" lede="Which holders have released, and the signed log. Shares are never published.">
      <TeeStatus />
      <TeePanel title="Release log" hasTee={tee !== null} load={load}>
        {({ entries }) =>
          entries.length === 0 ? (
            'No releases yet.'
          ) : (
            <Rows>
              {entries.map((entry) => (
                <Row key={entry.holderId} label={entry.holderId}>
                  <Mono>{entry.shareHash}</Mono>
                </Row>
              ))}
            </Rows>
          )
        }
      </TeePanel>
    </Screen>
  );
}

export function Proof() {
  return (
    <Screen title="Post-exam proof" lede="Available after the end round.">
      <EmptyState title="No proof yet">
        Once the end round opens the paper, this page checks the selection statement and the salted
        paper hash. The checks are not built.
      </EmptyState>
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
