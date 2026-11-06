import type { ReactNode } from 'react';

import { CheckIcon, CrossIcon, DashIcon } from './icons';

export type StepState = 'done' | 'current' | 'waiting' | 'failed' | 'not-applicable';

const WORDS: Record<StepState, string> = {
  done: 'Done',
  current: 'In progress',
  waiting: 'Waiting',
  failed: 'Failed',
  'not-applicable': 'Not applicable',
};

export interface Step {
  /** Stable key for the step. */
  id: string;
  label: ReactNode;
  state: StepState;
  /** A timestamp or a public clock round. */
  when?: ReactNode;
  /** One plain sentence under the label. */
  note?: ReactNode;
  /** The proof for this step. Folded away until someone asks for it. */
  evidence?: ReactNode;
}

function Marker({ state }: { state: StepState }) {
  return (
    <span className="ps-step-marker" aria-hidden="true">
      {state === 'done' ? <CheckIcon /> : state === 'failed' ? <CrossIcon /> : state === 'not-applicable' ? <DashIcon /> : null}
    </span>
  );
}

/**
 * The chain of custody, read like a ledger: when, the rail, then what happened. Each state has its
 * own marker shape and its own word, so nothing depends on colour. It stays a single column at
 * every width, with `when` folding under the label on phones, because evidence opens downwards.
 */
export function Stepper(props: {
  steps: readonly Step[];
  /** The list's accessible name. */
  label?: string;
  /** The words on the fold that opens a step's evidence. */
  evidenceLabel?: string;
}) {
  return (
    <ol className="ps-stepper" aria-label={props.label ?? 'Steps for this exam'}>
      {props.steps.map((step) => (
        <li key={step.id} className="ps-step" data-state={step.state} aria-current={step.state === 'current' ? 'step' : undefined}>
          <div className="ps-step-when">{step.when}</div>
          <div className="ps-step-rail">
            <Marker state={step.state} />
          </div>
          <div className="ps-step-body">
            <div className="ps-step-head">
              <span className="ps-step-label">{step.label}</span>
              <span className="ps-step-state">{WORDS[step.state]}</span>
            </div>
            {step.note ? <p className="ps-step-note">{step.note}</p> : null}
            {step.evidence ? (
              <details className="ps-step-evidence">
                <summary>{props.evidenceLabel ?? 'Show the details'}</summary>
                <div className="ps-step-proof">{step.evidence}</div>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
