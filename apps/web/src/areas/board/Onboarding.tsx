import { decodeApprovedList, fromHex, roles, toHex, type ApprovedListEntry } from '@paperseal/protocol';
import type { RegistrationEntry } from '@paperseal/tee-client';
import { Badge, Button, Connected, EmptyState, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useCurrentExamId } from '../../shared/currentExam';
import { fromTee, notConnectedToTee, tee } from '../../shared/tee';
import { TeeStatus } from '../../shared/TeeStatus';
import { useBoardForm, useReader } from './BoardForm';
import { checkPostTarget, type PostGate } from './postGate';
import { postApprovedListFlow } from './postFlow';
import { PostPanel } from './PostPanel';
import { explainError } from './publishFlow';
import { formatClock } from './form';
import { roleNames, rolesFor, tryCompose, withRoles } from './registrations';

const loadRegistrations = fromTee((client) => client.registrations());

const loadList = fromTee(async (client) => {
  const { approvedList } = await client.status();
  if (!approvedList) return null;
  try {
    return { entries: decodeApprovedList(fromHex(approvedList.entries)), error: null };
  } catch (error) {
    return { entries: [] as ApprovedListEntry[], error: (error as Error).message };
  }
});

const short = (key: string) => (key === '0x' ? 'none' : `${key.slice(0, 14)}…`);

export function EntryRows(props: { entries: readonly ApprovedListEntry[] }) {
  return (
    <Rows>
      {props.entries.map((entry) => (
        <Row
          key={toHex(entry.passkeyPublicKey)}
          label={entry.role === roles.setter ? 'Setter' : entry.owner}
        >
          {entry.role === roles.setter ? (
            <>
              <Mono>{entry.owner}</Mono>,{' '}
            </>
          ) : null}
          {roleNames[entry.role] ?? `Role ${String(entry.role)}`}, passkey <Mono>{short(toHex(entry.passkeyPublicKey))}</Mono>, derived{' '}
          <Mono>{short(toHex(entry.derivedPublicKey))}</Mono>
        </Row>
      ))}
    </Rows>
  );
}

/** Registrations the TEE reports, which are the entries of the list it read back from the chain. */
function Registered() {
  return (
    <Connected title="Read back by the TEE" notConnected={notConnectedToTee} load={loadList}>
      {(list) =>
        list === null ? (
          'The TEE has not read an approved list from the chain yet.'
        ) : list.error ? (
          `The TEE's list could not be read: ${list.error}`
        ) : (
          <EntryRows entries={list.entries} />
        )
      }
    </Connected>
  );
}

/**
 * Checks the TEE and the exam before the list can be posted: the TEE must attest for this exam
 * against the chain and be at Onboard. Runs when the exam changes, and again on request.
 */
function usePostGate(): { gate: PostGate; recheck: () => void } {
  const examId = useCurrentExamId();
  const reader = useReader();
  const [result, setResult] = useState<{ key: string; gate: Exclude<PostGate, { state: 'checking' }> } | null>(null);
  const [round, setRound] = useState(0);
  const key = `${examId ?? ''}:${String(round)}`;
  useEffect(() => {
    if (!examId || !reader || !tee) return;
    let live = true;
    checkPostTarget({ tee, registry: reader, examId }).then(
      (target) => {
        if (live) setResult({ key, gate: { state: 'ok', target } });
      },
      (error: unknown) => {
        if (live) setResult({ key, gate: { state: 'blocked', reason: explainError(error) } });
      },
    );
    return () => {
      live = false;
    };
  }, [examId, reader, key]);
  const recheck = useCallback(() => {
    setRound((n) => n + 1);
  }, []);
  const gate: PostGate = result?.key === key ? result.gate : { state: 'checking' };
  return { gate, recheck };
}

function TargetPanel(props: { gate: PostGate; recheck: () => void }) {
  const { gate } = props;
  return (
    <Panel title="The exam this list is written for">
      {gate.state === 'checking' ? <p>Checking the TEE against the chain.</p> : null}
      {gate.state === 'blocked' ? <Badge tone="bad">{gate.reason}</Badge> : null}
      {gate.state === 'ok' ? (
        <>
          <Badge tone="ok">The TEE attests for this exam and is at the Onboard stage.</Badge>
          <Rows>
            <Row label="Exam ID">
              <Mono>{gate.target.examId}</Mono>
            </Row>
            <Row label="Commit">
              <Mono>{gate.target.exam.commitHash}</Mono>
            </Row>
            <Row label="Image digest">
              <Mono>{gate.target.exam.imageDigest}</Mono>
            </Row>
            <Row label="Exam start, T">{formatClock(Number(gate.target.exam.settings.examStart))}</Row>
            <Row label="End round">{String(gate.target.exam.settings.endRound)}</Row>
            <Row label="TEE instance key">
              <Mono>{gate.target.instancePublicKey}</Mono>
            </Row>
          </Rows>
        </>
      ) : null}
      <p>The approved list is written once. Check that this is the exam you mean before posting.</p>
      <Button onClick={props.recheck}>Check again</Button>
    </Panel>
  );
}

function Composer(props: { registrations: readonly RegistrationEntry[] }) {
  const { environment } = useBoardForm();
  const examId = useCurrentExamId();
  const reader = useReader();
  const { gate, recheck } = usePostGate();
  const [picked, setPicked] = useState<Record<string, number | undefined>>({});
  const entries = useMemo(() => withRoles(props.registrations, picked), [props.registrations, picked]);
  const composed = useMemo(() => (examId && entries.length > 0 ? tryCompose(examId, entries) : null), [examId, entries]);
  const blocked = !examId
    ? 'No exam is selected. Publish an exam or set VITE_EXAM_ID.'
    : entries.length === 0
      ? 'Choose a role for each registration to include.'
      : composed && !composed.ok
        ? composed.reason
        : gate.state === 'checking'
          ? 'Checking the TEE and the exam before posting.'
          : gate.state === 'blocked'
            ? gate.reason
            : null;

  return (
    <>
      <Panel title="Choose each role">
        {props.registrations.length === 0 ? (
          'Nobody has registered with the TEE yet.'
        ) : (
          <Rows>
            {props.registrations.map((registration) => (
              <Row key={registration.passkeyPublicKey} label={registration.owner}>
                <select
                  className="ps-input"
                  aria-label={`Role for ${registration.owner}`}
                  value={picked[registration.passkeyPublicKey] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    setPicked({ ...picked, [registration.passkeyPublicKey]: value === '' ? undefined : Number(value) });
                  }}
                >
                  <option value="">Leave out</option>
                  {rolesFor(registration.derivedPublicKey).map((role) => (
                    <option key={role} value={role}>
                      {roleNames[role]}
                    </option>
                  ))}
                </select>{' '}
                <Mono>{short(registration.passkeyPublicKey)}</Mono>
              </Row>
            ))}
          </Rows>
        )}
      </Panel>
      {composed?.ok ? (
        <Panel title="Composed list">
          <Rows>
            <Row label="Entries">{entries.length}</Row>
            <Row label="List hash (approvedList message)">
              <Mono>{composed.list.hash}</Mono>
            </Row>
          </Rows>
          <Badge tone="ok">The list passes the approved list rules.</Badge>
        </Panel>
      ) : (
        <EmptyState title="No list composed">{composed ? composed.reason : 'The list is composed once roles are chosen and the list passes the approved list rules.'}</EmptyState>
      )}
      <TargetPanel gate={gate} recheck={recheck} />
      <PostPanel
        title="Post the approved list"
        label="Post approved list"
        blocked={blocked}
        post={async (onStage) => {
          if (!examId || !composed?.ok) throw new Error('There is no composed list to post.');
          if (!tee || !reader) throw new Error('The TEE and ExamRegistry must be connected to post.');
          // Checked again right before sending: the result on screen may be minutes old.
          await checkPostTarget({ tee, registry: reader, examId });
          return postApprovedListFlow(environment, { examId, entries: composed.list.encoded }, onStage);
        }}
      />
    </>
  );
}

export function Onboarding() {
  return (
    <Screen title="Onboarding" lede="Compose the registrations the TEE verified, with the role you give each, into the approved list and post it from the board wallet. Setters register with no name.">
      <TeeStatus />
      <Registered />
      <Connected title="Registrations" notConnected={notConnectedToTee} load={loadRegistrations}>
        {({ registrations }) => <Composer registrations={registrations} />}
      </Connected>
    </Screen>
  );
}
