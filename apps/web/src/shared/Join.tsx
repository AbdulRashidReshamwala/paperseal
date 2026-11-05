import { decodeInviteFragment, InviteError } from '@paperseal/protocol';
import { Page, RoleHeader, Stage } from '@paperseal/ui';
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { setCurrentExamId } from './currentExam';
import { holdInvite, rolePaths } from './invite';

/*
 * Where an invite link lands: `#/join?exam=..&role=..&owner=..&secret=..`. The invite is read from
 * the fragment, held in memory and removed from the address bar in the same step, so the secret is
 * never left in the browser's history, and the page of the invited role takes over. A link that
 * doesn't read cleanly gets a plain explanation and is cleared the same way.
 */
export default function Join() {
  const { pathname, search, state } = useLocation();
  const navigate = useNavigate();
  // Reading is pure. What it finds is acted on below, and a failure travels in the router's state,
  // so the explanation survives the address being cleared.
  const read = useMemo(() => {
    if (search === '') return null;
    try {
      return { invite: decodeInviteFragment(`#${pathname}${search}`) };
    } catch (error) {
      if (!(error instanceof InviteError)) throw error;
      return { problem: error.message };
    }
  }, [pathname, search]);

  useEffect(() => {
    if (!read) return;
    if ('invite' in read) {
      holdInvite(read.invite);
      setCurrentExamId(read.invite.examId);
      void navigate(rolePaths[read.invite.role], { replace: true });
    } else {
      void navigate('/join', { replace: true, state: { problem: read.problem } });
    }
  }, [read, navigate]);

  const problem = typeof (state as { problem?: unknown } | null)?.problem === 'string' ? (state as { problem: string }).problem : null;

  if (search !== '') {
    return (
      <Page header={<RoleHeader role="Invitation" />}>
        <Stage title="Opening your invitation" next="This takes a moment." />
      </Page>
    );
  }
  return (
    <Page header={<RoleHeader role="Invitation" />}>
      <Stage
        title={problem ? 'This invitation link doesn’t work' : 'Open your invitation link'}
        lede={
          problem
            ? 'The link is incomplete or was changed on the way. Open the link your exam board sent you again, copied in full.'
            : 'You register from the private link your exam board sent you. There is nothing to type here.'
        }
        next="If you can’t find the link, or it still doesn’t work, ask your exam board to send it again."
      >
        {problem ? (
          <details>
            <summary>Details for your exam board</summary>
            <p>{problem}</p>
          </details>
        ) : null}
      </Stage>
    </Page>
  );
}
