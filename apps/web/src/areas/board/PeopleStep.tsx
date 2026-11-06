import type { Directory } from '@paperseal/chain';
import { matchInvites, ownerProblem, partyNameProblem, roles, setterEntries, threshold, type Hex, type InviteState } from '@paperseal/protocol';
import type { RegistrationEntry, TeeClient } from '@paperseal/tee-client';
import { Button, Check, Field, Hash, Panel, Row, Rows, Stage, Stamp } from '@paperseal/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { useCurrentExamId } from '../../shared/currentExam';
import { directoryName } from '../../shared/names';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import { useBoardForm, useReader } from './BoardForm';
import { usePoll } from './hooks';
import { withDetails } from './details';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { InviteBackup } from './InviteBackup';
import { Fold, PostAction, ReadBackRows } from './Parts';
import { createInvite, linkFor, reissueInvite, type BoardInvite } from './invites';
import { defaultRole, partyEntries, partyRoles, partyState, useDirectoryNames, useParties, usePartyRecords, type ChosenParty, type PartyState } from './parties';
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

/** The public exam page's link. See "Registration by name" in spec/api.md. */
export const examPageLink = (base: string, examId: Hex) => `${base.split('#')[0] ?? ''}#/exam?exam=${examId}`;

function CopyLink(props: { label: string; url: string }) {
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
      <Button aria-label={props.label} onClick={onClick}>
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

/** Makes one setter invite: an optional private note, then a link to copy. */
function AddInvite(props: { invites: readonly BoardInvite[]; onAdd: (invite: BoardInvite) => void }) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setText('');
    props.onAdd(createInvite(props.invites, text));
  };
  return (
    <form className="board-invite-form" onSubmit={submit}>
      <Field label="A note for yourself (optional, kept private)" value={text} onChange={setText} />
      <Button type="submit">Add invite</Button>
    </form>
  );
}

const stateWords: Record<InviteState['kind'], string> = {
  waiting: 'Waiting for them to register',
  matched: 'Registered',
  conflict: 'Two security keys used this invite, so neither is on the list.',
};

/** One setter invite: where it stands, and what the board can do about it. */
function InviteRow(props: { invite: BoardInvite; state: InviteState; link: string; onReissue: () => void }) {
  const { invite, state } = props;
  return (
    <Row label={invite.label}>
      <span className="board-link">
        <Check status={state.kind === 'matched' ? 'pass' : state.kind === 'conflict' ? 'fail' : 'pending'}>{stateWords[state.kind]}</Check>
        {state.kind === 'waiting' ? <CopyLink label={`Copy the link for ${invite.label}`} url={props.link} /> : null}
        {state.kind === 'conflict' ? (
          <Button aria-label={`Make a new link for ${invite.label}`} onClick={props.onReissue}>
            Make a new link
          </Button>
        ) : null}
      </span>
    </Row>
  );
}

/** Where a chosen name stands, in plain words. */
function PartyLine(props: { name: string; state: PartyState; onRetry: () => void }) {
  const { name, state } = props;
  switch (state.kind) {
    case 'reading':
      return <Check status="pending">Reading {name}</Check>;
    case 'unread':
      return (
        <>
          <Check status="pending">{name} can&apos;t be read right now.</Check>
          <Button aria-label={`Try reading ${name} again`} onClick={props.onRetry}>
            Try again
          </Button>
          <Fold summary="Details">
            <p>{state.reason}</p>
          </Fold>
        </>
      );
    case 'no-record':
      return <Check status="fail">{name} has no security key on it, so nobody can register under it.</Check>;
    case 'waiting':
      return <Check status="pending">Waiting for them to register</Check>;
    case 'other-key':
      return <Check status="fail">Someone registered under {name} with a different security key, so they are not on the list.</Check>;
    case 'registered':
      return <Check status="pass">Name confirmed</Check>;
  }
}

/** One name: a tick, then a role and where it stands once it is chosen. */
function PartyRow(props: {
  name: string;
  party: ChosenParty | undefined;
  state: PartyState | undefined;
  onTick: (ticked: boolean) => void;
  onRole: (role: number | null) => void;
  onRetry: () => void;
}) {
  const { name, party, state } = props;
  return (
    <Row
      label={
        <label className="board-tick">
          <input
            type="checkbox"
            aria-label={`Include ${name}`}
            checked={party !== undefined}
            onChange={(event) => {
              props.onTick(event.target.checked);
            }}
          />{' '}
          {name}
        </label>
      }
    >
      {party ? (
        <span className="board-link">
          <select
            className="ps-input board-role"
            aria-label={`Role for ${name}`}
            value={party.role ?? ''}
            onChange={(event) => {
              props.onRole(event.target.value === '' ? null : Number(event.target.value));
            }}
          >
            <option value="">Choose a role</option>
            {partyRoles.map((role) => (
              <option key={role} value={role}>
                {roleNames[role]}
              </option>
            ))}
          </select>
          {state ? <PartyLine name={name} state={state} onRetry={props.onRetry} /> : null}
        </span>
      ) : null}
    </Row>
  );
}

/** Adds a name that isn't in the directory. Its own records decide, as for any other. */
function AddName(props: { taken: readonly string[]; onAdd: (name: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = text.trim();
    const problem = name === '' ? 'Enter an ENS name, like iit-delhi.eth.' : (ownerProblem(name) ?? partyNameProblem(name));
    if (problem) {
      setError(problem);
      return;
    }
    if (props.taken.includes(name)) {
      setError(`${name} is already here.`);
      return;
    }
    setError(undefined);
    setText('');
    props.onAdd(name);
  };
  return (
    <form className="board-invite-form" onSubmit={submit}>
      <Field
        label="Add a name that isn't listed"
        value={text}
        error={error}
        onChange={(value) => {
          setText(value);
          setError(undefined);
        }}
      />
      <Button type="submit">Add name</Button>
    </form>
  );
}

const directoryWords = (read: Directory | null): string | null => {
  if (!read) return 'Reading the directory.';
  switch (read.state) {
    case 'found':
      return read.names.length === 0 ? `${directoryName} lists nobody yet.` : null;
    case 'none':
      return `${directoryName} lists nobody yet.`;
    case 'malformed':
      return `The list on ${directoryName} can't be used. Ask whoever runs it to fix it.`;
    default:
      return `${directoryName} can't be read right now.`;
  }
};

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

/** Step 4: names to choose and setters to invite, then the list composed from whoever registered. */
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
  const { parties, update: updateParties } = useParties(examId);
  const directory = useDirectoryNames(environment.ensLookup);
  const [search, setSearch] = useState('');
  const chosenNames = useMemo(() => parties.map((party) => party.name), [parties]);
  const { records, retry } = usePartyRecords(environment.ensLookup, chosenNames);
  const partyRows = useMemo(
    () => parties.map((party) => ({ party, state: partyState(party.name, records[party.name], registrations) })),
    [parties, records, registrations],
  );
  const entries = useMemo(() => [...partyEntries(partyRows), ...setterEntries(matching)], [partyRows, matching]);
  const composed = useMemo(() => (examId && entries.length > 0 ? tryCompose(examId, entries) : null), [examId, entries]);

  const listed = useMemo(() => (directory.read?.state === 'found' ? directory.read.names : []), [directory.read]);
  const shown = useMemo(() => {
    const all = [...new Set([...listed, ...chosenNames])];
    const wanted = search.trim().toLowerCase();
    return wanted === '' ? all : all.filter((name) => name.includes(wanted));
  }, [listed, chosenNames, search]);
  const seen = directoryWords(directory.read);
  const unreadDirectory = directory.read !== null && !['found', 'none', 'malformed'].includes(directory.read.state);

  const tick = (name: string, ticked: boolean) => {
    updateParties(ticked ? [...parties, { name, role: defaultRole(parties) }] : parties.filter((party) => party.name !== name));
  };
  const setRole = (name: string, role: number | null) => {
    updateParties(parties.map((party) => (party.name === name ? { ...party, role } : party)));
  };

  // A registration that fits neither an invite nor a chosen name. Anyone can make one, so only the count shows.
  const stray = matching.unmatched.filter(
    (registration) => !partyRows.some(({ state }) => state.kind === 'registered' && state.registration.passkeyPublicKey === registration.passkeyPublicKey),
  ).length;

  const counts = (role: number) => entries.filter((entry) => entry.role === role).length;
  const conflicts = matching.rows.filter(({ state }) => state.kind === 'conflict').length;
  const blocked = !tee
    ? 'Paper Seal is not connected, so nobody can register yet. Reload this page. If it stays like this, contact whoever runs Paper Seal.'
    : !examId
      ? 'No exam is open. Go back to the exam board page and open your exam.'
      : entries.length === 0
        ? parties.length === 0 && invites.length === 0
          ? 'Choose who takes part, then share the exam link.'
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

  return (
    <Stage
      eyebrow={props.eyebrow}
      title="Choose who takes part"
      lede="Tick each key holder and centre, and share the exam link with them once. Invite setters with a private link. When everyone has registered, post the list."
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
          <Panel title="Key holders and centres">
            {examId ? (
              <>
                <p className="board-link">
                  <span>Share this exam link once. It holds nothing secret.</span>
                  <CopyLink label="Copy the exam link" url={examPageLink(base, examId)} />
                </p>
                <Field label="Search the directory" value={search} onChange={setSearch} />
                {seen ? (
                  <p className="board-note">
                    {seen}{' '}
                    {unreadDirectory ? <Button onClick={directory.retry}>Try again</Button> : null}
                  </p>
                ) : null}
                {shown.length > 0 ? (
                  <Rows>
                    {shown.map((name) => {
                      const row = partyRows.find(({ party }) => party.name === name);
                      return (
                        <PartyRow
                          key={name}
                          name={name}
                          party={row?.party}
                          state={row?.state}
                          onTick={(ticked) => {
                            tick(name, ticked);
                          }}
                          onRole={(role) => {
                            setRole(name, role);
                          }}
                          onRetry={retry}
                        />
                      );
                    })}
                  </Rows>
                ) : null}
                <AddName
                  taken={[...listed, ...chosenNames]}
                  onAdd={(name) => {
                    tick(name, true);
                  }}
                />
              </>
            ) : null}
            <p className="board-note">
              ENS names are read on Sepolia, a test network, where anyone can register a similar name. Whoever runs {directoryName} decides which key belongs to each name on it.
            </p>
          </Panel>
          <Panel title="Setters">
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
                {matching.rows.map(({ invite, state }) => (
                  <InviteRow
                    key={invite.id}
                    invite={invite}
                    state={state}
                    link={linkFor(base, examId, invite)}
                    onReissue={() => {
                      update(invites.map((item) => (item.id === invite.id ? reissueInvite(invite) : item)));
                    }}
                  />
                ))}
              </Rows>
            ) : null}
            {examId ? <InviteBackup examId={examId} invites={invites} onRestore={update} /> : null}
            <p className="board-note">
              Each link works for one setter only, so send it to them privately. It is safe to close this page while you wait.
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
            {stray > 0 ? <p className="board-note">{stray === 1 ? '1 other registration matches nobody here, so it is not on the list.' : `${String(stray)} other registrations match nobody here, so they are not on the list.`}</p> : null}
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
            {partyRows.map(({ party, state }) =>
              state.kind === 'registered' ? (
                <Row key={party.name} label={party.name}>
                  <Hash value={state.registration.passkeyPublicKey} label="security key" />
                </Row>
              ) : null,
            )}
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
