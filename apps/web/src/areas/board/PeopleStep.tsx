import { roles, threshold } from '@paperseal/protocol';
import type { RegistrationEntry, TeeClient } from '@paperseal/tee-client';
import { Button, Check, Hash, Panel, Row, Rows, Stage } from '@paperseal/ui';
import { useEffect, useMemo, useState } from 'react';

import { useCurrentExamId } from '../../shared/currentExam';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import { useBoardForm, useReader } from './BoardForm';
import { usePoll } from './hooks';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { Fold, PostAction } from './Parts';
import { bankNeeded, registrationLinks } from './plan';
import { checkPostTarget, type PostGate } from './postGate';
import { postApprovedListFlow, type PostOutcome } from './postFlow';
import { explainError } from './publishFlow';
import { defaultRoles, roleNames, rolesFor, tryCompose, withRoles } from './registrations';

const RECHECK_MS = 10_000;

/**
 * Checks the TEE and the exam before the list can be posted: the TEE must attest for this exam
 * against the chain and be at Onboard. Runs when the exam changes, and again while it is blocked,
 * so a machine that comes up later unblocks the screen by itself.
 */
function usePostGate(tee: TeeClient | null): PostGate {
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
  }, [examId, reader, key, tee]);
  const blocked = result?.gate.state === 'blocked';
  useEffect(() => {
    if (!blocked) return;
    const id = setInterval(() => {
      setRound((n) => n + 1);
    }, RECHECK_MS);
    return () => {
      clearInterval(id);
    };
  }, [blocked]);
  // A blocked result stays on screen during its recheck, so the reason doesn't flicker.
  if (result && (result.key === key || result.gate.state === 'blocked')) return result.gate;
  return { state: 'checking' };
}

function CopyLink(props: { role: string; url: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const onClick = () => {
    // navigator.clipboard is missing outside a secure context.
    const written = (globalThis.navigator as Navigator | undefined)?.clipboard?.writeText(props.url);
    if (!written) {
      setCopy('failed');
      return;
    }
    written.then(
      () => {
        setCopy('copied');
      },
      () => {
        setCopy('failed');
      },
    );
  };
  return (
    <span className="board-link">
      <Button aria-label={`Copy the link for ${props.role}`} onClick={onClick}>
        {copy === 'copied' ? 'Copied' : 'Copy link'}
      </Button>
      {copy === 'failed' ? (
        <>
          <span role="status">Copy failed. Select the link below.</span>
          <span className="ps-mono">{props.url}</span>
        </>
      ) : null}
    </span>
  );
}

function Count(props: { label: string; have: number; need: number }) {
  const { have, need } = props;
  return (
    <Row label={props.label}>
      <Check status={have === need ? 'pass' : have > need ? 'fail' : 'pending'}>
        {have} of {need}
      </Check>
    </Row>
  );
}

const expected = /^expected \d+ neutral and \d+ centre key holders/;

/** Step 4: links to share, then the live list of who registered, with a role for each. */
export function PeopleStep(props: { eyebrow: string; snapshot: Snapshot; onPosted: () => void }) {
  const { environment, tee, addReceipt } = useBoardForm();
  const examId = useCurrentExamId();
  const reader = useReader();
  const gate = usePostGate(tee);
  const load = useMemo(() => (tee ? () => tee.registrations() : null), [tee]);
  const { value, problem } = usePoll(load, TEE_STATUS_POLL_MS);
  const registrations: readonly RegistrationEntry[] = useMemo(() => value?.registrations ?? [], [value]);
  // `null` is the board leaving someone out. Anything not touched keeps its default.
  const [touched, setTouched] = useState<Record<string, number | null>>({});
  const picked = useMemo(() => {
    const merged: Record<string, number | undefined> = defaultRoles(registrations);
    for (const [key, role] of Object.entries(touched)) merged[key] = role ?? undefined;
    return merged;
  }, [registrations, touched]);
  const entries = useMemo(() => withRoles(registrations, picked), [registrations, picked]);
  const composed = useMemo(() => (examId && entries.length > 0 ? tryCompose(examId, entries) : null), [examId, entries]);

  const counts = (role: number) => entries.filter((entry) => entry.role === role).length;
  const blocked = !tee
    ? 'The sealed machine is not connected, so nobody can register yet.'
    : !examId
      ? 'No exam is selected.'
      : entries.length === 0
        ? 'Waiting for people to register.'
        : composed && !composed.ok
          ? expected.test(composed.reason)
            ? `The list needs exactly ${String(threshold.neutrals)} neutral parties and ${String(threshold.centres)} centres with keys.`
            : composed.reason
          : gate.state === 'checking'
            ? 'Checking the sealed machine before the list can be posted.'
            : gate.state === 'blocked'
              ? gate.reason
              : null;

  const base = 'location' in globalThis ? `${location.origin}${location.pathname}` : '';
  const needs = props.snapshot.found?.criteria ? bankNeeded(props.snapshot.found.criteria) : null;
  const setters = registrations.filter((registration) => registration.derivedPublicKey === '0x');
  const named = registrations.map((registration) => ({
    registration,
    name: registration.derivedPublicKey === '0x' ? `Setter ${String(setters.indexOf(registration) + 1)}` : registration.owner,
  }));

  return (
    <Stage
      eyebrow={props.eyebrow}
      title="Bring people in"
      lede="Send each person the link for their role. When everyone has registered, check each name and role, then post the list."
      action={
        <>
          {examId ? (
            <Panel title="Links to share">
              <Rows>
                {registrationLinks(examId, base).map(({ role, note, url }) => (
                  <Row key={role} label={`${role}: ${note}`}>
                    <CopyLink role={role} url={url} />
                  </Row>
                ))}
              </Rows>
            </Panel>
          ) : null}
          <Panel title="Who has registered">
            <Rows>
              <Count label="Neutral parties" have={counts(roles.neutral)} need={threshold.neutrals} />
              <Count label="Centres with keys" have={counts(roles.centreKeyHolder)} need={threshold.centres} />
              <Row label="Centres without keys">{counts(roles.centre)}</Row>
              <Row label="Setters">
                {counts(roles.setter)}
                {needs ? `, at least ${String(needs.setters)} needed` : ''}
              </Row>
            </Rows>
          </Panel>
          <div className="board-section" aria-live="polite">
            {problem ? <p className="board-blocked">The registrations could not be read. This page keeps trying.</p> : null}
            {tee && registrations.length === 0 && !problem ? <p className="board-blocked">Nobody has registered yet. This list updates by itself.</p> : null}
            {registrations.length > 0 ? (
              <Rows>
                {named.map(({ registration, name }) => {
                  const key = registration.passkeyPublicKey;
                  return (
                    <Row key={key} label={name}>
                      <select
                        className="ps-input board-role"
                        aria-label={`Role for ${name}`}
                        value={picked[key] ?? ''}
                        onChange={(event) => {
                          const next = event.target.value;
                          setTouched({ ...touched, [key]: next === '' ? null : Number(next) });
                        }}
                      >
                        <option value="">Leave out</option>
                        {rolesFor(registration.derivedPublicKey).map((role) => (
                          <option key={role} value={role}>
                            {roleNames[role]}
                          </option>
                        ))}
                      </select>
                    </Row>
                  );
                })}
              </Rows>
            ) : null}
          </div>
          <PostAction
            label="Post the list"
            blocked={blocked}
            post={async (onStage) => {
              if (!examId || !composed?.ok) throw new Error('There is no list to post.');
              if (!tee || !reader) throw new Error('The sealed machine and the public record must be connected to post.');
              // Checked again right before sending: the result on screen may be minutes old.
              await checkPostTarget({ tee, registry: reader, examId });
              return postApprovedListFlow(environment, { examId, entries: composed.list.encoded }, onStage);
            }}
            onPosted={(outcome: PostOutcome) => {
              addReceipt({ kind: 'list', outcome });
              props.onPosted();
            }}
          />
        </>
      }
      next="The list can be posted only once. The sealed machine then reads it, and setters can send questions."
    >
      <ExamRecord snapshot={props.snapshot}>
        {gate.state === 'ok' ? (
          <Row label="Sealed machine">
            <Check status="pass">Running the published code for this exam, ready for the list</Check>
          </Row>
        ) : null}
        {gate.state === 'ok' ? (
          <Row label="Instance key">
            <Hash value={gate.target.instancePublicKey} label="instance key" />
          </Row>
        ) : null}
        {composed?.ok ? (
          <Row label="List fingerprint">
            <Hash value={composed.list.hash} label="list fingerprint" />
          </Row>
        ) : null}
      </ExamRecord>
      {registrations.length > 0 ? (
        <Fold summary="Registered security keys">
          <Rows>
            {named.map(({ registration, name }) => (
              <Row key={registration.passkeyPublicKey} label={name}>
                <Hash value={registration.passkeyPublicKey} label="security key" />
              </Row>
            ))}
          </Rows>
        </Fold>
      ) : null}
    </Stage>
  );
}
