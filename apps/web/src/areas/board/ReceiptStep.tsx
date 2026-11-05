import { Button, PrimaryAction, Stage, Stamp } from '@paperseal/ui';

import type { Receipt } from './BoardForm';
import { Fold, ReadBackRows } from './Parts';

/** The moment after something is written: a stamp if it read back true, and the differences if not. */
export function ReceiptStep(props: { eyebrow: string; receipt: Receipt; onContinue: () => void }) {
  const { receipt } = props;
  const { outcome } = receipt;
  if (outcome.matches && receipt.kind === 'publish') {
    return (
      <Stage
        eyebrow={props.eyebrow}
        title="The exam is published"
        lede="Every value read back from the public record matches what you entered."
        action={
          <>
            <p className="board-stamp">
              <Stamp press>Published</Stamp>
            </p>
            <PrimaryAction onClick={props.onContinue}>Bring people in</PrimaryAction>
          </>
        }
        next="You share a link with each person, then post the list of who takes part."
      >
        <Fold summary="Exam record">
          <ReadBackRows rows={outcome.rows} />
        </Fold>
      </Stage>
    );
  }
  const what = receipt.kind === 'publish' ? 'Published' : 'Posted';
  return (
    <Stage
      eyebrow={props.eyebrow}
      title={`${what}, but the read-back differs`}
      lede={
        receipt.kind === 'publish'
          ? 'The public record does not return what you entered, so this exam was not selected. Do not use it.'
          : 'The public record does not return what was sent. Compare the rows below before going on.'
      }
      action={<Button onClick={props.onContinue}>{receipt.kind === 'publish' ? 'Start again' : 'Continue'}</Button>}
      next={receipt.kind === 'publish' ? 'Published exams cannot be replaced, so a corrected exam needs a new name.' : 'The exam carries on from what the public record holds.'}
    >
      <ReadBackRows rows={outcome.rows} />
    </Stage>
  );
}
