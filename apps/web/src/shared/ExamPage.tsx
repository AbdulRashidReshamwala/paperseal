import { resolveExamName, type EnsLookup } from '@paperseal/chain';
import { looksLikeEnsName, roles, type Hex } from '@paperseal/protocol';
import { Button, LoadingSeal, Page, RoleHeader, Stage } from '@paperseal/ui';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Gate } from '../release/Gate';
import { holderGate, useHolderProgress } from '../release/progress';
import { setCurrentExamId } from './currentExam';
import { nameLookup } from './names';
import { registryAddress } from './registry';

/*
 * The public exam page, `#/exam?exam=0x..` or `#/exam?exam=<exam name>.<board's name>`. The board shares this one link with every key holder and
 * centre. It holds no secret. The board decides each person's role, so this page registers them and,
 * once the list is posted, sends them to the page for that role. A name opens the exam only when every
 * check in `resolveExamName` passes and it names this app's registry, so a name that fails shows nothing
 * of whichever exam this browser was last on.
 */

const everyRole: readonly number[] = [roles.neutral, roles.centreKeyHolder, roles.centre];

type NameCheck = { state: 'checking' } | { state: 'open' } | { state: 'refused'; retry: boolean };

/** Points this browser at the exam a name opens. Null for a link that holds an ID. */
export function useLinkedName(lookup: EnsLookup | null, registry: string | null) {
  const [search] = useSearchParams();
  const exam = search.get('exam');
  const name = exam && looksLikeEnsName(exam) ? exam : null;
  const [checked, setChecked] = useState<{ name: string; check: NameCheck } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!name) return;
    let live = true;
    const read = async (): Promise<NameCheck> => {
      if (!lookup || !registry) return { state: 'refused', retry: false };
      const resolved = await resolveExamName(name, { lookup });
      if (!resolved.ok) return { state: 'refused', retry: resolved.failed === 'unreadable' };
      if (resolved.value.registry.toLowerCase() !== registry.toLowerCase()) return { state: 'refused', retry: false };
      setCurrentExamId(resolved.value.examId as Hex);
      return { state: 'open' };
    };
    void read().then((check) => {
      if (live) setChecked({ name, check });
    });
    return () => {
      live = false;
    };
  }, [lookup, name, registry, round]);
  if (!name) return null;
  return {
    check: checked?.name === name ? checked.check : ({ state: 'checking' } as const),
    retry: () => {
      setChecked(null);
      setRound((n) => n + 1);
    },
  };
}

export default function ExamPage() {
  const linked = useLinkedName(nameLookup, registryAddress);
  if (linked?.check.state === 'checking') return <LoadingSeal />;
  if (linked?.check.state === 'refused') {
    return (
      <Page header={<RoleHeader role="Exam" />}>
        <Stage
          title="This exam could not be opened"
          lede={linked.check.retry ? 'The name cannot be checked right now. Check your internet connection, then press Try again.' : 'The exam name in this link did not pass its checks, so no exam was opened.'}
          {...(linked.check.retry ? { action: <Button onClick={linked.retry}>Try again</Button> } : {})}
          next="Ask the exam board for a new link."
        />
      </Page>
    );
  }
  return <ExamBody />;
}

function ExamBody() {
  const { progress, actions } = useHolderProgress('keyholder');
  const stage = holderGate(progress, everyRole);
  const entry = progress.chain.value?.entry;
  const neutral = entry?.role === roles.neutral;
  return (
    <Page header={<RoleHeader role="Exam" />}>
      {stage ? (
        <Gate stage={stage} role="keyholder" progress={progress} actions={actions} />
      ) : (
        <Stage
          title="You are on the list for this exam"
          lede={`Your name on the list is ${entry?.owner ?? ''}.`}
          action={<Link to={neutral ? '/keyholder' : '/centre'}>{neutral ? 'Open your key holder page' : 'Open your centre page'}</Link>}
          next="That page shows the one thing to do next."
        />
      )}
    </Page>
  );
}
