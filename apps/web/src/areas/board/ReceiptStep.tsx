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
        lede="Your exam is saved on the public record, and it matches what you entered."
        action={
          <>
            <p className="board-stamp">
              <Stamp press>Published</Stamp>
            </p>
            <PrimaryAction onClick={props.onContinue}>Invite people</PrimaryAction>
          </>
        }
        next="Next you send each person their link. Then you post the list of who takes part."
      >
        <Fold summary="Details">
          <ReadBackRows rows={outcome.rows} />
        </Fold>
      </Stage>
    );
  }
  const what = receipt.kind === 'publish' ? 'The exam was published' : 'It was saved';
  return (
    <Stage
      eyebrow={props.eyebrow}
      title={`${what}, but it does not match`}
      lede={
        receipt.kind === 'publish'
          ? 'The public record shows different details from the ones you entered. Do not use this exam.'
          : 'The public record shows something different from what was sent. Look at what differs before you go on.'
      }
      action={<Button onClick={props.onContinue}>{receipt.kind === 'publish' ? 'Start again' : 'Continue'}</Button>}
      next={receipt.kind === 'publish' ? 'A published exam cannot be replaced. To fix it, set up a new exam with a different name.' : 'The exam carries on with what the public record shows.'}
    >
      <Fold summary="Show what differs">
        <ReadBackRows rows={outcome.rows} />
      </Fold>
    </Stage>
  );
}
