import { Button, Stage } from '@paperseal/ui';

import type { Receipt } from './BoardForm';
import { Fold, ReadBackRows } from './Parts';

/**
 * Shown only when what was written does not read back the same. A correct write moves straight
 * on, so there is no receipt to confirm.
 */
export function ReceiptStep(props: { eyebrow: string; receipt: Receipt; onContinue: () => void }) {
  const { receipt } = props;
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
        <ReadBackRows rows={receipt.outcome.rows} />
      </Fold>
    </Stage>
  );
}
