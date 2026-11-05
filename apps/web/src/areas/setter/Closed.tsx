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
              ? 'The sealed system that built the paper is not the one that gave you these receipts. You may have been routed to a different sealed system, so your questions may never have reached the real one.'
              : 'A receipt in this browser doesn’t carry a valid signature from the sealed system, so we can’t show that your question was sealed.'
          }
          next="Tell your exam board now, and quote the receipts below."
        >
          <Check status="fail">{different ? 'These receipts don’t match the paper' : 'A receipt doesn’t check out'}</Check>
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
        lede={`Questions closed, but the question bank didn’t meet the exam’s rules. ${counted > 0 ? sealedLine : ''}`}
        next="Your exam board will tell you what happens next."
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
        lede="This browser has no sealed questions for this exam. If you sealed some on another computer, their receipts are there."
        next="There’s nothing more to do here."
      >
        {unsealed}
      </Stage>
    );
  }

  const results: Record<typeof verdict.status, { check: ReactNode; next: string }> = {
    pass: {
      check: <Check status="pass">Your questions went to the sealed system that built the paper</Check>,
      next: 'There’s nothing more to do. Your exam board will take it from here.',
    },
    pending: {
      check: <Check status="pending">Waiting for the paper to be built</Check>,
      next: 'Your receipts are checked by themselves once the paper is built. You can come back to this link any time.',
    },
    'not-checked': {
      check: <Check status="not-checked">Your receipts can’t be checked just now</Check>,
      next: 'This page keeps trying by itself, and you can come back to this link any time.',
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
