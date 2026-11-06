import { entriesFor, listRolesFor, matchInvites, roles, threshold, type InviteRole, type InviteState } from '@paperseal/protocol';
import type { RegistrationEntry, TeeClient } from '@paperseal/tee-client';
import { Button, Check, Field, Hash, Panel, Row, Rows, Stage } from '@paperseal/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { useCurrentExamId } from '../../shared/currentExam';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import { useBoardForm, useReader } from './BoardForm';
import { usePoll } from './hooks';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { Fold, PostAction, useCopy } from './Parts';
import { centreRoles, createInvite, inviteRoleNames, linkFor, reissueInvite, type BoardInvite } from './invites';
import { bankNeeded } from './plan';
import { checkPostTarget, type PostGate } from './postGate';
import { postApprovedListFlow, type PostOutcome } from './postFlow';
import { explainError } from './publishFlow';
import { roleNames, tryCompose } from './registrations';
import { useInvites } from './useInvites';

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

function CopyLink(props: { who: string; url: string }) {
  const [copy, write] = useCopy();
  const onClick = () => {
    write(props.url);
  };
  return (
    <span className="board-link">
      <Button aria-label={`Copy the link for ${props.who}`} onClick={onClick}>
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

const inviteRoleOptions: InviteRole[] = ['keyholder', 'centre', 'setter'];

/** Makes one invite: a role and a name, then a link to copy. Setters need no name, and any note stays here. */
function AddInvite(props: { invites: readonly BoardInvite[]; onAdd: (invite: BoardInvite) => void }) {
  const [role, setRole] = useState<InviteRole>('keyholder');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const made = createInvite(props.invites, role, text);
    if (!made.ok) {
      setError(made.reason);
      return;
    }
    setError(undefined);
    setText('');
    props.onAdd(made.invite);
  };
  return (
    <form className="board-invite-form" onSubmit={submit}>
      <label className="ps-field">
        <span>Role</span>
        <select
          className="ps-input board-role"
          value={role}
          onChange={(event) => {
            setRole(event.target.value as InviteRole);
            setError(undefined);
          }}
        >
          {inviteRoleOptions.map((option) => (
            <option key={option} value={option}>
              {inviteRoleNames[option]}
            </option>
          ))}
        </select>
      </label>
      <Field
        label={role === 'setter' ? 'Your own note (never published, optional)' : 'Name for the approved list'}
        value={text}
        error={error}
        onChange={(value) => {
          setText(value);
          setError(undefined);
        }}
      />
      <Button type="submit">Add invite</Button>
    </form>
  );
}

const stateWords: Record<InviteState['kind'], string> = {
  waiting: 'Waiting for them to register',
  matched: 'Registered',
  conflict: 'Two security keys used this invite. Neither is on the list.',
};

/** One invite: who it is for, where it stands, and what the board can do about it. */
function InviteRow(props: {
  invite: BoardInvite;
  state: InviteState;
  link: string;
  role: number | undefined;
  onRole: (role: number | null) => void;
  onReissue: () => void;
}) {
  const { invite, state } = props;
  const who = `${invite.label} (${inviteRoleNames[invite.role]})`;
  return (
    <Row label={who}>
      <span className="board-link">
        <Check status={state.kind === 'matched' ? 'pass' : state.kind === 'conflict' ? 'fail' : 'pending'}>{stateWords[state.kind]}</Check>
        {state.kind === 'matched' && invite.role === 'centre' ? (
          <select
            className="ps-input board-role"
            aria-label={`Role for ${invite.label}`}
            value={props.role ?? ''}
            onChange={(event) => {
              props.onRole(event.target.value === '' ? null : Number(event.target.value));
            }}
          >
            <option value="">Leave out</option>
            {centreRoles.map((role) => (
              <option key={role} value={role}>
                {roleNames[role]}
              </option>
            ))}
          </select>
        ) : null}
        {state.kind === 'waiting' ? <CopyLink who={who} url={props.link} /> : null}
        {state.kind === 'conflict' ? (
          <Button aria-label={`Reissue the invite for ${who}`} onClick={props.onReissue}>
            Reissue invite
          </Button>
        ) : null}
      </span>
    </Row>
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

/** Step 4: invites to send, then the list composed from whoever registered with one. */
export function PeopleStep(props: { eyebrow: string; snapshot: Snapshot; onPosted: () => void }) {
  const { environment, tee, addReceipt } = useBoardForm();
  const examId = useCurrentExamId();
  const reader = useReader();
  const gate = usePostGate(tee);
  const load = useMemo(() => (tee ? () => tee.registrations() : null), [tee]);
  const { value, problem } = usePoll(load, TEE_STATUS_POLL_MS);
  const registrations: readonly RegistrationEntry[] = useMemo(() => value?.registrations ?? [], [value]);
  const { invites, update } = useInvites(examId);
  // The tags are recomputed from the stored secrets on every read, so nothing the TEE says is taken on trust.
  const matching = useMemo(() => matchInvites(invites, registrations), [invites, registrations]);
  // `null` is the board leaving a centre out. Anything not touched keeps its default.
  const [touched, setTouched] = useState<Record<string, number | null>>({});
  const picked = useMemo(() => {
    const merged: Record<string, number | undefined> = listRolesFor(matching);
    for (const { invite, state } of matching.rows) {
      if (invite.role !== 'centre' || state.kind !== 'matched') continue;
      const key = state.registration.passkeyPublicKey;
      if (key in touched) merged[key] = touched[key] ?? undefined;
    }
    return merged;
  }, [matching, touched]);
  const entries = useMemo(() => entriesFor(matching, picked), [matching, picked]);
  const composed = useMemo(() => (examId && entries.length > 0 ? tryCompose(examId, entries) : null), [examId, entries]);

  const counts = (role: number) => entries.filter((entry) => entry.role === role).length;
  const conflicts = matching.rows.filter(({ state }) => state.kind === 'conflict').length;
  const blocked = !tee
    ? 'The sealed machine is not connected, so nobody can register yet.'
    : !examId
      ? 'No exam is selected.'
      : entries.length === 0
        ? invites.length === 0
          ? 'Add an invite for each person, then send them their link.'
          : 'Waiting for people to register.'
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

  const changeInvite = (next: BoardInvite) => {
    update(invites.map((invite) => (invite.id === next.id ? next : invite)));
  };

  return (
    <Stage
      eyebrow={props.eyebrow}
      title="Bring people in"
      lede="Add an invite for each person and send them their link. The list builds itself from whoever registers with one. When everyone is in, post it."
      action={
        <>
          <Panel title="Invites">
            {examId ? (
              <AddInvite
                invites={invites}
                onAdd={(invite) => {
                  update([...invites, invite]);
                }}
              />
            ) : null}
            {invites.length > 0 && examId ? (
              <Rows>
                {matching.rows.map(({ invite, state }) => {
                  const key = state.kind === 'matched' ? state.registration.passkeyPublicKey : undefined;
                  return (
                    <InviteRow
                      key={invite.id}
                      invite={invite}
                      state={state}
                      link={linkFor(base, examId, invite)}
                      role={key ? picked[key] : undefined}
                      onRole={(role) => {
                        if (key) setTouched({ ...touched, [key]: role });
                      }}
                      onReissue={() => {
                        changeInvite(reissueInvite(invite));
                      }}
                    />
                  );
                })}
              </Rows>
            ) : null}
            <p className="board-note">
              Each link works for one person and carries a secret, so send it privately. Invites are kept in this browser, so
              open the board here to see who has registered.
            </p>
          </Panel>
          <Panel title="On the list">
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
            {conflicts > 0 ? (
              <p className="board-problem" role="alert">
                <Check status="fail">An invite was used by two security keys, so neither is on the list. Reissue it, then send the new link.</Check>
              </p>
            ) : null}
            {matching.unmatched.length > 0 ? (
              <Rows>
                {matching.unmatched.map((registration) => (
                  <Row key={registration.passkeyPublicKey} label="Not invited">
                    <span className="board-link">
                      <Check status="fail">Registered without one of your invites. Not on the list.</Check>
                      <Hash value={registration.passkeyPublicKey} label="security key" />
                    </span>
                  </Row>
                ))}
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
      {entries.length > 0 ? (
        <Fold summary="Registered security keys">
          <Rows>
            {matching.rows.map(({ invite, state }) =>
              state.kind === 'matched' ? (
                <Row key={invite.id} label={invite.label}>
                  <Hash value={state.registration.passkeyPublicKey} label="security key" />
                </Row>
              ) : null,
            )}
          </Rows>
        </Fold>
      ) : null}
    </Stage>
  );
}
