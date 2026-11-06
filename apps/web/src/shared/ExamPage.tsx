import { roles } from '@paperseal/protocol';
import { Page, RoleHeader, Stage } from '@paperseal/ui';
import { Link } from 'react-router';

import { Gate } from '../release/Gate';
import { holderGate, useHolderProgress } from '../release/progress';

/*
 * The public exam page, `#/exam?exam=0x..`. The board shares this one link with every key holder and
 * centre. It holds no secret. The board decides each person's role, so this page registers them and,
 * once the list is posted, sends them to the page for that role.
 */

const everyRole: readonly number[] = [roles.neutral, roles.centreKeyHolder, roles.centre];

export default function ExamPage() {
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
