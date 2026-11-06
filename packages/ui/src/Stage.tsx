import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';

import { CheckIcon } from './icons';
import { HomeMark } from './Logo';
import { Seal, type SealState } from './Seal';

/** One quiet line naming who this is for and which exam. There are no tabs: state picks the screen. */
export function RoleHeader(props: {
  /** The person's role in plain words, such as "Exam centre". */
  role: string;
  /** The exam's name. Left out until one is known. */
  exam?: ReactNode;
  /** One short quiet note at the far end, such as a centre's name. */
  note?: ReactNode;
}) {
  return (
    <header className="ps-role">
      <HomeMark />
      <span className="ps-role-name">{props.role}</span>
      {props.exam ? <span className="ps-role-exam">{props.exam}</span> : null}
      {props.note ? <span className="ps-role-note">{props.note}</span> : null}
    </header>
  );
}

/** A role's page: its header, then one `Stage`. Without a header it still carries the wordmark. */
export function Page(props: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="ps-shell">
      {props.header ?? (
        <header className="ps-role">
          <HomeMark />
        </header>
      )}
      <main>{props.children}</main>
    </div>
  );
}

/**
 * The core pattern: one screen, the next thing to do, and one sentence on what happens after it.
 * `action` takes exactly one control. Leave it out on a screen where the person only waits;
 * `next` is still required, because they need to know what they are waiting for.
 */
export function Stage(props: {
  /** Small line above the title, such as the step's place in the flow. */
  eyebrow?: ReactNode;
  /** The next thing to do, or the state now, as a plain sentence. */
  title: string;
  /** At most a sentence or two of context. */
  lede?: ReactNode;
  /** The one primary action: a `PrimaryAction` or a `KeyTouch`. */
  action?: ReactNode;
  /** One sentence saying what happens next. */
  next: ReactNode;
  /** Shows the seal in this state beside the content. */
  seal?: SealState;
  /** Press the seal down as the screen appears, for the moment something was sealed. */
  stampSeal?: boolean;
  /** Supporting content below the sentence: a `Countdown`, a `Stepper`, a few `Rows`. */
  children?: ReactNode;
}) {
  return (
    <section className="ps-stage" data-sealed={props.seal ? 'true' : undefined}>
      <div className="ps-stage-main">
        {props.eyebrow ? <p className="ps-eyebrow">{props.eyebrow}</p> : null}
        <h1 className="ps-stage-title">{props.title}</h1>
        {props.lede ? <div className="ps-stage-lede">{props.lede}</div> : null}
        {props.action ? <div className="ps-stage-action">{props.action}</div> : null}
        <p className="ps-stage-next">
          <span className="ps-stage-next-label">What happens next</span>
          <span>{props.next}</span>
        </p>
      </div>
      {props.seal ? (
        <div className="ps-stage-seal">
          <Seal state={props.seal} caption {...(props.stampSeal ? { stamp: true } : {})} />
        </div>
      ) : null}
      {props.children ? <div className="ps-stage-detail">{props.children}</div> : null}
    </section>
  );
}

export type ActionStatus = 'idle' | 'busy' | 'done';

/**
 * The one wax-coloured control on a screen. While busy or done it stays focusable and ignores
 * presses, because a natively disabled button would drop keyboard focus mid-flow.
 */
export function PrimaryAction(
  props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & {
    children: ReactNode;
    status?: ActionStatus;
    busyLabel?: string;
    doneLabel?: string;
  },
) {
  const { children, status = 'idle', busyLabel = 'Working', doneLabel = 'Done', onClick, disabled, ...rest } = props;
  const inert = status !== 'idle';
  const guarded = (event: MouseEvent<HTMLButtonElement>) => {
    if (inert) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <>
      <button
        type="button"
        {...rest}
        className="ps-primary"
        data-status={status}
        disabled={disabled}
        aria-disabled={inert || undefined}
        aria-busy={status === 'busy' || undefined}
        onClick={guarded}
      >
        {status === 'busy' ? <span className="ps-primary-tick" aria-hidden="true" /> : null}
        {status === 'done' ? <CheckIcon /> : null}
        <span>{status === 'busy' ? busyLabel : status === 'done' ? doneLabel : children}</span>
      </button>
      <span className="ps-sr" role="status">
        {status === 'busy' ? busyLabel : status === 'done' ? doneLabel : ''}
      </span>
    </>
  );
}
