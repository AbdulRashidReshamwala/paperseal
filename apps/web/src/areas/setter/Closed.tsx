import type { Stage as ExamStage } from '@paperseal/protocol';
import { Check, Hash, Row, Rows, Stage } from '@paperseal/ui';
import type { ReactNode } from 'react';

import type { StoredReceipt } from './receipts';
import { useSession } from './session';
import { closedCheck, type BuildRead, type ReceiptChecks } from './state';

function ReceiptList(props: { receipts: readonly StoredReceipt[]; topics: Record<string, string>; open?: boolean }) {
  return (
    <details className="ss-receipts" open={props.open}>
      <summary>{props.open ? 'The receipts to quote' : 'Your receipts'}</summary>
      <Rows>
        {props.receipts.map((receipt) => (
          <Row key={receipt.questionHash} label={props.topics[receipt.questionHash] ?? 'Question'}>
            <Hash value={receipt.questionHash} label="receipt" />
          </Row>
        ))}
      </Rows>
    </details>
  );
}

/** Anything left in the writing area when the bank closed was not sealed, and the setter must hear that. */
function Unsealed(props: { text: string; unsure: boolean }) {
  if (props.text.trim() === '') return null;
  return (
    <div className="ss-unsealed">
      <Check status="not-checked">
        {props.unsure
          ? 'We couldn’t tell whether the question you were sending arrived, and there is no receipt for it.'
          : 'The question you were writing wasn’t sealed, because questions closed first.'}
      </Check>
      <details>
        <summary>See what you wrote</summary>
        <p className="ss-unsealed-text">{props.text}</p>
      </details>
    </div>
  );
}

/** After Lock. The receipt check needs no button: it runs itself as soon as the Build exists. */
export function Closed(props: {
  stage: ExamStage | null;
  receipts: readonly StoredReceipt[];
  checks: ReceiptChecks;
  topics: Record<string, string>;
  build: BuildRead;
  unsealed: string;
  unsure: boolean;
}) {
  const { credential } = useSession();
  const { stage, receipts, checks, topics, build } = props;
  const verdict = closedCheck({ receipts, checks, canVerify: credential !== null, build });
  const counted = receipts.filter((receipt) => checks[receipt.questionHash] === true).length;
  const sealedLine =
    counted === 1 ? 'One question sealed from this browser.' : `${counted.toLocaleString('en-GB')} questions sealed from this browser.`;
  const unsealed = <Unsealed text={props.unsealed} unsure={props.unsure} />;

  if (verdict.status === 'fail') {
    const different = verdict.cause === 'different-machine';
    return (
      <div role="alert" className="ss-alarm">
        <Stage
          title="Your questions may not be in this paper"
          lede={
            different
              ? 'The receipts in this browser do not match the paper that was built. Some of your questions may not be in it.'
              : 'A receipt in this browser could not be confirmed, so we can’t show that your question was sealed.'
          }
          next="Tell your exam board now, and give them the receipt codes below."
        >
          <Check status="fail">{different ? 'These receipts don’t match the paper' : 'A receipt could not be confirmed'}</Check>
          <ReceiptList receipts={verdict.affected} topics={topics} open />
          {unsealed}
        </Stage>
      </div>
    );
  }

  if (stage === 'failed') {
    return (
      <Stage
        title="This exam can’t go ahead"
        lede={`Questions have closed, but the questions sent did not meet the exam’s rules, so no paper could be built. ${counted > 0 ? sealedLine : ''}`}
        next="Nothing to do. Your exam board will tell you what happens next. It is safe to close this page."
      >
        <Check status="not-checked">No paper was built, so there is nothing to compare your receipts with</Check>
        {unsealed}
      </Stage>
    );
  }

  if (verdict.status === 'none') {
    return (
      <Stage
        title="Questions have closed"
        lede="You have not sealed any questions from this browser. If you sealed some on another computer, their receipts are there."
        next="Nothing more to do here. It is safe to close this page."
      >
        {unsealed}
      </Stage>
    );
  }

  const results: Record<typeof verdict.status, { check: ReactNode; next: string }> = {
    pass: {
      check: <Check status="pass">Your receipts match the paper that was built</Check>,
      next: 'Nothing more to do. Your exam board takes it from here. It is safe to close this page.',
    },
    pending: {
      check: <Check status="pending">Waiting for the paper to be built</Check>,
      next: 'Nothing to do. Your receipts are checked once the paper is built. It is safe to close this page and come back to this link any time.',
    },
    'not-checked': {
      check: <Check status="not-checked">Your receipts can’t be checked just now</Check>,
      next: 'This page keeps trying. It is safe to close it and come back to this link any time.',
    },
  };
  const result = results[verdict.status];

  return (
    <Stage title="Your questions are sealed" lede={sealedLine} next={result.next} seal="sealed">
      {result.check}
      <ReceiptList receipts={receipts} topics={topics} />
      {unsealed}
    </Stage>
  );
}
