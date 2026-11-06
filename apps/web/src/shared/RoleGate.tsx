import type { ExamRegistry } from '@paperseal/chain';
import type { ApprovedListEntry, Hex, Invite } from '@paperseal/protocol';
import { LoadingSeal } from '@paperseal/ui';
import { Suspense, useMemo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import { CHAIN_POLL_MS, centreRoles, holderRoles } from '../release/progress';
import { BoardGate } from './BoardGate';
import { useCurrentExamId } from './currentExam';
import { demoGate } from './demoKeys';
import { loadEnrolments } from './enrolment';
import { examNameInPath } from './examName';
import { holderCredential, listEntryFor, type HolderRole } from './holder';
import { useInvite } from './invite';
import { loadCredential } from './Register';
import { registry } from './registry';
import { rolePages, RoleStop, type GatedRole } from './RolePage';
import { usePoll } from './usePoll';

/*
 * Keeps a role's pages for that role. This is a page guard and nothing more: it only picks what to
 * show. The contract, the sealed machine and each person's key decide what anyone can do.
 */

/** `exam`: a key holder or centre whose role isn't known here. The exam page sends them on. */
export type RightPage = GatedRole | 'exam';

export type Access = { state: 'open' } | { state: 'needs-link' } | { state: 'wrong-role'; right: RightPage };

const open: Access = { state: 'open' };

export function setterAccess(input: { examId: Hex | null; invite: Invite | null; setterKey: boolean; holderKey: boolean }): Access {
  const { examId, invite, setterKey, holderKey } = input;
  if (examId && (setterKey || invite?.examId.toLowerCase() === examId.toLowerCase())) return open;
  return holderKey ? { state: 'wrong-role', right: 'exam' } : { state: 'needs-link' };
}

/**
 * A registered name is kept for both holder pages, because the board picks the role later, so a key
 * only shows its wrong page once the posted list says which role it has.
 */
export function holderAccess(input: {
  role: HolderRole;
  /** The address names an exam, as the public exam link does. */
  linked: boolean;
  enrolled: boolean;
  holderKey: boolean;
  setterKey: boolean;
  /** This key's role on the posted list. Null until there is one to read. */
  listed: number | null;
}): Access {
  const { role, linked, enrolled, holderKey, setterKey, listed } = input;
  if (holderKey) {
    const [mine, other, otherPage]: [readonly number[], readonly number[], HolderRole] =
      role === 'keyholder' ? [holderRoles, centreRoles, 'centre'] : [centreRoles, holderRoles, 'keyholder'];
    if (listed !== null && !mine.includes(listed) && other.includes(listed)) return { state: 'wrong-role', right: otherPage };
    return open;
  }
  if (linked || enrolled) return open;
  return setterKey ? { state: 'wrong-role', right: 'setter' } : { state: 'needs-link' };
}

function WrongRole(props: { role: GatedRole; right: RightPage }) {
  const { role, right } = props;
  return (
    <RoleStop
      role={role}
      title={`This page is for ${rolePages[role].who}`}
      lede={right === 'exam' ? 'You are registered for this exam as a key holder or centre.' : `You are ${rolePages[right].one} on this exam.`}
      action={<Link to={right === 'exam' ? '/exam' : rolePages[right].path}>{right === 'exam' ? 'Open your exam page' : rolePages[right].open}</Link>}
      next="That page shows the one thing to do next."
    />
  );
}

export function SetterGate(props: { children: ReactNode }) {
  const examId = useCurrentExamId();
  const invite = useInvite('setter');
  const access = setterAccess({
    examId,
    invite,
    setterKey: examId !== null && loadCredential(examId, 'setter') !== null,
    holderKey: holderCredential('keyholder', examId) !== null,
  });
  if (access.state === 'open') return props.children;
  if (access.state === 'wrong-role') return <WrongRole role="setter" right={access.right} />;
  return (
    <RoleStop
      role="setter"
      title="Open your invitation link"
      lede="You need the invitation link from your exam board to use this page."
      next="If you can’t find the link, ask your exam board to send it again."
    />
  );
}

const onList = (entry: ApprovedListEntry | null) => entry !== null;

/** This key's role on the posted list, read until there is one. It reads nothing without a key. */
function useListedRole(examId: Hex | null, passkey: Hex | null, reader: Pick<ExamRegistry, 'getApprovedListEntries'> | null): number | null {
  const load = useMemo(() => (reader && examId && passkey ? () => listEntryFor(reader, examId, passkey) : null), [reader, examId, passkey]);
  return usePoll(load, CHAIN_POLL_MS, onList).value?.role ?? null;
}

export function HolderGate(props: { role: HolderRole; children: ReactNode; reader?: Pick<ExamRegistry, 'getApprovedListEntries'> | null }) {
  const { role } = props;
  const examId = useCurrentExamId();
  const { search, pathname } = useLocation();
  const named = new URLSearchParams(search).get('exam');
  const credential = holderCredential(role, examId);
  const listed = useListedRole(examId, credential?.passkeyPublicKey ?? null, props.reader === undefined ? registry : props.reader);
  const access = holderAccess({
    role,
    // NamedExam lets a page with a name in its address through only once that name has passed.
    linked: (named !== null && /^0x[0-9a-f]{64}$/.test(named)) || examNameInPath(pathname) !== null,
    enrolled: loadEnrolments().length > 0,
    holderKey: credential !== null,
    setterKey: examId !== null && loadCredential(examId, 'setter') !== null,
    listed,
  });
  // The area shows its own loading screen while the list is read, so nothing flashes up here.
  if (access.state === 'open') return props.children;
  if (access.state === 'wrong-role') return <WrongRole role={role} right={access.right} />;
  return (
    <RoleStop
      role={role}
      title="Open your exam link"
      lede={`This page is for ${rolePages[role].who} on an exam. You need the exam link from your exam board.`}
      next="If you can’t find the link, ask your exam board to send it again."
    />
  );
}

const DemoGate = demoGate();

/** The gate for one role's area. With demo keys, the person chosen in the demo bar decides the role. */
export default function RoleGate(props: { role: GatedRole; children: ReactNode }) {
  const { role, children } = props;
  const gated = role === 'board' ? <BoardGate>{children}</BoardGate> : children;
  if (DemoGate) {
    return (
      <Suspense fallback={<LoadingSeal />}>
        <DemoGate role={role}>{gated}</DemoGate>
      </Suspense>
    );
  }
  if (role === 'board') return gated;
  return role === 'setter' ? <SetterGate>{children}</SetterGate> : <HolderGate role={role}>{children}</HolderGate>;
}
