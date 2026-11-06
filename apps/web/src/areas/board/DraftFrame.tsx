import { Button, PrimaryAction } from '@paperseal/ui';
import type { ReactNode } from 'react';

import { draftSteps, type DraftStep } from './plan';

const LABELS: Record<DraftStep, string> = {
  create: 'Name, date and time',
  topics: 'Topics',
  centres: 'Centres',
  neutrals: 'Neutral parties',
  review: 'Preview and submit',
};

export interface DraftRail {
  step: DraftStep;
  furthest: DraftStep;
  onStep: (step: DraftStep) => void;
}

/** The pages of the form down the side, with where the board is. A page ahead of the furthest one stays closed. */
export function DraftShell(props: DraftRail & { children: ReactNode }) {
  const here = draftSteps.indexOf(props.step);
  const furthest = draftSteps.indexOf(props.furthest);
  return (
    <div className="board-draft">
      <nav aria-label="Pages of this form">
        <ol className="board-draft-rail">
          {draftSteps.map((step, index) => (
            <li key={step} data-state={index === here ? 'here' : index < here ? 'done' : 'ahead'}>
              <button
                type="button"
                disabled={index > furthest}
                aria-current={index === here ? 'step' : undefined}
                onClick={() => {
                  props.onStep(step);
                }}
              >
                <span aria-hidden="true">{index + 1}</span>
                {LABELS[step]}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="board-draft-main">{props.children}</div>
    </div>
  );
}

const EXAM_STAGES = [
  { stage: 'people', label: 'Bring everyone in' },
  { stage: 'wait', label: 'Collect questions' },
  { stage: 'post-build', label: 'Post the paper' },
  { stage: 'status', label: 'Exam day' },
] as const;

export type ExamStage = (typeof EXAM_STAGES)[number]['stage'];

/** Where a published exam stands, and what is still to come. State moves it on, so nothing here is pressed. */
export function ExamShell(props: { step: ExamStage; children: ReactNode }) {
  const here = EXAM_STAGES.findIndex(({ stage }) => stage === props.step);
  return (
    <div className="board-draft">
      <nav aria-label="Stages of this exam">
        <ol className="board-draft-rail">
          <li data-state="done">
            <div>
              <span aria-hidden="true">1</span>
              Exam created
            </div>
          </li>
          {EXAM_STAGES.map(({ stage, label }, index) => (
            <li key={stage} data-state={index === here ? 'here' : index < here ? 'done' : 'ahead'}>
              <div aria-current={index === here ? 'step' : undefined}>
                <span aria-hidden="true">{index + 2}</span>
                {label}
              </div>
            </li>
          ))}
        </ol>
      </nav>
      <div className="board-draft-main">{props.children}</div>
    </div>
  );
}

/**
 * One page of the form: what to do, the fields in one surface, then Back and Continue. A `form` page
 * also continues on Enter. A page that holds a form of its own cannot be one.
 */
export function DraftPage(props: {
  rail: DraftRail;
  title: string;
  lede: string;
  form?: boolean;
  ready: boolean;
  blocked?: string | null;
  onBack?: () => void;
  onContinue: () => void;
  children: ReactNode;
}) {
  const { ready, onContinue } = props;
  const body = (
    <>
      <div className="board-draft-card">{props.children}</div>
      <div className="board-draft-foot">
        {props.onBack ? <Button onClick={props.onBack}>Back</Button> : <span />}
        <div className="board-draft-next">
          {props.blocked ? <p className="board-blocked">{props.blocked}</p> : null}
          <PrimaryAction
            type={props.form ? 'submit' : 'button'}
            disabled={!ready}
            {...(props.form ? {} : { onClick: onContinue })}
          >
            Continue
          </PrimaryAction>
        </div>
      </div>
    </>
  );
  return (
    <DraftShell {...props.rail}>
      <h1 className="board-draft-title">{props.title}</h1>
      <p className="board-draft-lede">{props.lede}</p>
      {props.form ? (
        <form
          className="board-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) onContinue();
          }}
        >
          {body}
        </form>
      ) : (
        body
      )}
    </DraftShell>
  );
}
