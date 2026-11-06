import { looksLikeEnsName, roles } from '@paperseal/protocol';
import { LoadingSeal, Page, RoleHeader, Stage } from '@paperseal/ui';
import { Link, useSearchParams } from 'react-router';

import { Gate } from '../release/Gate';
import { holderGate, useHolderProgress } from '../release/progress';
import { NameRefused, useExamTitle, useLinkedName } from './NamedExam';

/*
 * The public exam page, `#/exam?exam=0x..` or `#/exam?exam=<exam name>.<board's name>`. The board shares this one link with every key holder and
 * centre. It holds no secret. The board decides each person's role, so this page registers them and,
 * once the list is posted, sends them to the page for that role. A name opens the exam only when every
 * check in `resolveExamName` passes and it names this app's registry, so a name that fails shows nothing
 * of whichever exam this browser was last on.
 */

const everyRole: readonly number[] = [roles.neutral, roles.centreKeyHolder, roles.centre];

export default function ExamPage() {
  const [search] = useSearchParams();
  const exam = search.get('exam');
  const linked = useLinkedName(exam && looksLikeEnsName(exam) ? exam : null);
  if (linked?.check.state === 'checking') return <LoadingSeal />;
  if (linked?.check.state === 'refused') return <NameRefused role="Exam" retry={linked.check.retry} onRetry={linked.retry} />;
  return <ExamBody />;
}

function ExamBody() {
  const { progress, actions } = useHolderProgress('keyholder');
  const stage = holderGate(progress, everyRole);
  const entry = progress.chain.value?.entry;
  const neutral = entry?.role === roles.neutral;
  const title = useExamTitle(progress.examId);
  return (
    <Page header={<RoleHeader role="Exam" exam={title} />}>
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
