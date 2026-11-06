import { entriesFor, listRolesFor, matchInvites, roles, threshold, type InviteRole, type InviteState } from '@paperseal/protocol';
import type { RegistrationEntry, TeeClient } from '@paperseal/tee-client';
import { Button, Check, Field, Hash, Panel, Row, Rows, Stage, Stamp } from '@paperseal/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { useCurrentExamId } from '../../shared/currentExam';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import { useBoardForm, useReader } from './BoardForm';
import { usePoll } from './hooks';
import { withDetails } from './details';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { InviteBackup } from './InviteBackup';
import { Fold, PostAction, ReadBackRows } from './Parts';
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
      <Button aria-label={`Copy the link for ${props.who}`} onClick={onClick}>
        {copy === 'copied' ? 'Copied' : 'Copy link'}
      </Button>
      {copy === 'failed' ? (
        <>
          <span role="status">The link could not be copied. Select it below and copy it yourself.</span>
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
        label={role === 'setter' ? 'A note for yourself (optional, kept private)' : 'Name to show on the public list'}
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
  conflict: 'Two security keys used this invite, so neither is on the list.',
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
          <Button aria-label={`Make a new link for ${who}`} onClick={props.onReissue}>
            Make a new link
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
  const { environment, tee, addReceipt, receipts } = useBoardForm();
  const published = receipts.find((receipt) => receipt.kind === 'publish' && receipt.outcome.matches);
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
    ? 'Paper Seal is not connected, so nobody can register yet. Reload this page. If it stays like this, contact whoever runs Paper Seal.'
    : !examId
      ? 'No exam is open. Go back to the exam board page and open your exam.'
      : entries.length === 0
        ? invites.length === 0
          ? 'Add an invite for each person, then send them their link.'
          : 'Waiting for people to register. You can close this page and come back.'
        : composed && !composed.ok
          ? expected.test(composed.reason)
            ? `The list needs exactly ${String(threshold.neutrals)} key holders and ${String(threshold.centres)} centres holding part of the key.`
            : withDetails('The list is not complete yet. Check the numbers under "On the list".', composed.reason)
          : gate.state === 'checking'
            ? 'Checking that Paper Seal is ready for the list.'
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
      title="Invite people"
      lede="Add an invite for each person and send them their link. When everyone has registered, post the list."
      action={
        <>
          {published ? (
            <div className="board-section">
              <p className="board-stamp">
                <Stamp press>Published</Stamp>
              </p>
              <p>Your exam is saved on the public record, and it matches what you entered.</p>
              {published.outcome.rows.length > 0 ? (
                <Fold summary="Details">
                  <ReadBackRows rows={published.outcome.rows} />
                </Fold>
              ) : null}
            </div>
          ) : null}
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
            {examId ? <InviteBackup examId={examId} invites={invites} onRestore={update} /> : null}
            <p className="board-note">
              Each link works for one person only, so send it to them privately. It is safe to close this page while you wait.
            </p>
          </Panel>
          <Panel title="On the list">
            <Rows>
              <Count label="Key holders" have={counts(roles.neutral)} need={threshold.neutrals} />
              <Count label="Centres holding part of the key" have={counts(roles.centreKeyHolder)} need={threshold.centres} />
              <Row label="Centres getting the key at unlock">{counts(roles.centre)}</Row>
              <Row label="Setters">
                {counts(roles.setter)}
                {needs ? `, at least ${String(needs.setters)} needed` : ''}
              </Row>
            </Rows>
          </Panel>
          <div className="board-section" aria-live="polite">
            {problem ? <p className="board-blocked">Who has registered cannot be loaded right now. This page keeps trying.</p> : null}
            {conflicts > 0 ? (
              <p className="board-problem" role="alert">
                <Check status="fail">An invite was used by two security keys, so neither is on the list. Make a new link for that invite, then send it to the right person.</Check>
              </p>
            ) : null}
            {matching.unmatched.length > 0 ? (
              <Rows>
                {matching.unmatched.map((registration) => (
                  <Row key={registration.passkeyPublicKey} label="Not invited">
                    <span className="board-link">
                      <Check status="fail">This person registered without one of your invites, so they are not on the list.</Check>
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
              if (!examId || !composed?.ok) throw new Error('The list is not ready to post yet. Check the numbers under "On the list".');
              if (!tee || !reader) throw new Error('Paper Seal is not connected, so the list cannot be posted. Reload this page and try again.');
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
      next="You can post the list only once, so wait until everyone has registered. Setters can then send questions, usually about 20 minutes later."
    >
      <ExamRecord snapshot={props.snapshot}>
        {gate.state === 'ok' ? (
          <Row label="Paper Seal">
            <Check status="pass">Ready for the list</Check>
          </Row>
        ) : null}
        {gate.state === 'ok' ? (
          <Row label="Paper Seal key">
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
