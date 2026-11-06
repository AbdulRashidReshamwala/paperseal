import { Button } from '@paperseal/ui';
import { useState, type ReactNode } from 'react';

import { useBoardForm, useEvaluated } from './BoardForm';
import { DraftPage, type DraftRail } from './DraftFrame';
import { evaluatePublish, parseLocalTime, whenTyped } from './form';
import { Fold, Input, Problem } from './Parts';
import { bankNeeded, durationError, examLabel, formatWhen, isTight, plainWords, type PlanInput } from './plan';

/** A fold that stays open while it holds something the board must deal with. */
function Advanced(props: { needed: boolean; children: ReactNode }) {
  const [folded, setFolded] = useState(true);
  return (
    <div
      onToggle={(event) => {
        setFolded(!(event.target as HTMLDetailsElement).open);
      }}
    >
      <Fold summary="Advanced" open={props.needed || !folded}>
        {props.children}
      </Fold>
    </div>
  );
}

const stillNeeded = (missing: readonly (string | null)[]) => {
  const parts = missing.filter((part) => part !== null);
  return parts.length > 0 ? `Still needed: ${parts.join(', ')}.` : null;
};

/** The first page: what the exam is called and when it runs. */
export function DetailsStep(props: { rail: DraftRail; onContinue: () => void }) {
  const { plan, setPlan, publish, setPublish } = useBoardForm();
  const { blueprint, schedule, nowSeconds } = useEvaluated();
  const set = (patch: Partial<PlanInput>) => {
    setPlan({ ...plan, ...patch });
  };
  const hostError = evaluatePublish(publish, null).errors.rpcHost;
  const ready = Boolean(blueprint.examId && schedule.settings && !hostError);
  const lockAt = schedule.lock?.entered ?? null;
  const typed = plan.typedName || plan.name;
  return (
    <DraftPage
      rail={props.rail}
      form
      title="Create the exam"
      lede="Enter its name and when it runs. We work out the rest."
      ready={ready}
      blocked={ready ? null : stillNeeded([plan.name === '' ? 'the exam name' : null, parseLocalTime(plan.examStart) === null ? 'the date and time' : null])}
      onContinue={props.onContinue}
    >
      <div className="board-draft-name">
        <Input
          label="Exam name"
          hint="Type it however you like, such as JEE Main 2026. It cannot be changed once the exam is published, and each exam needs its own name."
          error={plan.name === '' && typed.trim() !== '' ? 'Use at least one letter or digit.' : whenTyped(plan.name, blueprint.nameError)}
          value={typed}
          onChange={(text) => {
            set({ typedName: text, name: examLabel(text) });
          }}
        />
        {plan.name !== '' ? (
          <p>
            Saved as <span className="ps-mono">{plan.name}</span>
          </p>
        ) : null}
      </div>
      <Input
        label="Date and time of the exam"
        type="datetime-local"
        value={plan.examStart}
        error={whenTyped(plan.examStart, schedule.errors.examStart)}
        onChange={(examStart) => {
          set({ examStart });
        }}
      />
      <div className="board-draft-pair">
        <Input
          label="Length, in minutes"
          hint="The paper opens to the public when the exam ends."
          numeric
          value={plan.durationMinutes}
          error={durationError(plan.durationMinutes)}
          onChange={(durationMinutes) => {
            set({ durationMinutes });
          }}
        />
        <label className="ps-field">
          <span>Release to centres, in minutes</span>
          <input
            className="ps-input"
            inputMode="numeric"
            aria-label="Minutes before the exam to release the paper to centres"
            value={plan.releaseMinutes}
            onChange={(event) => {
              set({ releaseMinutes: event.target.value.replace(/\D/g, '') });
            }}
          />
          {schedule.errors.deltaMinutes && plan.releaseMinutes.trim() !== '' ? (
            <span className="ps-field-error">{plainWords(schedule.errors.deltaMinutes)}</span>
          ) : null}
          <span className="ps-field-hint">How long before the exam starts.</span>
        </label>
      </div>
      {lockAt !== null ? (
        <p className="board-note" role="status">
          Questions close {formatWhen(lockAt)}.
          {isTight(lockAt, nowSeconds) ? ' That leaves under 30 minutes to bring everyone in, which is too short for most exams.' : ''}
        </p>
      ) : null}
      {schedule.scheduleError ? <Problem>{schedule.scheduleError}</Problem> : null}
      <Advanced needed={Boolean(hostError)}>
        <Input
          label="Questions close"
          type="datetime-local"
          hint="Leave this empty and we choose a time for you."
          error={whenTyped(plan.lockTime, schedule.errors.lockTime)}
          value={plan.lockTime}
          onChange={(lockTime) => {
            set({ lockTime });
          }}
        />
        <Input
          label="Public record address"
          hint="The internet address Paper Seal uses to read the public record, such as sepolia.example.org. Leave it as it is unless you were given another."
          error={whenTyped(publish.rpcHost, hostError)}
          value={publish.rpcHost}
          onChange={(rpcHost) => {
            setPublish({ ...publish, rpcHost });
          }}
        />
      </Advanced>
    </DraftPage>
  );
}

/** The second page: what the paper covers. */
export function TopicsStep(props: { rail: DraftRail; onBack: () => void; onContinue: () => void }) {
  const { plan, setPlan } = useBoardForm();
  const { blueprint } = useEvaluated();
  const set = (patch: Partial<PlanInput>) => {
    setPlan({ ...plan, ...patch });
  };
  const setTopic = (index: number, patch: Partial<PlanInput['topics'][number]>) => {
    set({ topics: plan.topics.map((topic, i) => (i === index ? { ...topic, ...patch } : topic)) });
  };
  const ready = Boolean(blueprint.criteria);
  const needs = blueprint.criteria ? bankNeeded(blueprint.criteria) : null;
  return (
    <DraftPage
      rail={props.rail}
      form
      title="Add the topics"
      lede="List what the paper covers and how many questions each topic has."
      ready={ready}
      blocked={ready ? null : stillNeeded([plan.topics.some((topic) => topic.name === '' || topic.questions === '') ? 'the topics and their question counts' : null])}
      onBack={props.onBack}
      onContinue={props.onContinue}
    >
      {plan.topics.map((topic, index) => (
        <div className="board-topic" key={index}>
          <Input
            label="Topic name"
            ariaLabel={`Topic ${String(index + 1)} name`}
            error={whenTyped(topic.name, blueprint.topicErrors[index]?.name)}
            value={topic.name}
            onChange={(name) => {
              setTopic(index, { name });
            }}
          />
          <Input
            label="Question count"
            ariaLabel={`Topic ${String(index + 1)} questions`}
            numeric
            error={whenTyped(topic.questions, blueprint.topicErrors[index]?.questions)}
            value={topic.questions}
            onChange={(questions) => {
              setTopic(index, { questions });
            }}
          />
          {plan.topics.length > 1 ? (
            <Button
              aria-label={`Remove topic ${String(index + 1)}`}
              onClick={() => {
                set({ topics: plan.topics.filter((_, i) => i !== index) });
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      ))}
      <div>
        <Button
          onClick={() => {
            set({ topics: [...plan.topics, { name: '', questions: '' }] });
          }}
        >
          Add topic
        </Button>
      </div>
      {needs ? (
        <p className="board-note" role="status">
          You will need at least {needs.questions} questions from at least {needs.setters} setters.
        </p>
      ) : null}
      {blueprint.criteriaError ? <Problem>{blueprint.criteriaError}</Problem> : null}
      <Advanced needed={Boolean(blueprint.percentError ?? blueprint.multipleError)}>
        <Input
          label="Most of a topic one setter can write, in percent"
          hint="A percentage, from 1 to 100."
          numeric
          error={whenTyped(plan.maxSetterPercent, blueprint.percentError)}
          value={plan.maxSetterPercent}
          onChange={(maxSetterPercent) => {
            set({ maxSetterPercent });
          }}
        />
        <Input
          label="How many questions to collect, compared with the questions used"
          hint="For each topic, setters send this many times the questions the paper uses. Enter 2 or more."
          numeric
          error={whenTyped(plan.minBankMultiple, blueprint.multipleError)}
          value={plan.minBankMultiple}
          onChange={(minBankMultiple) => {
            set({ minBankMultiple });
          }}
        />
      </Advanced>
    </DraftPage>
  );
}
