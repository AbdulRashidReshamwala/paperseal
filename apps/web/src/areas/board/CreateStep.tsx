import { Button, Panel, PrimaryAction, Stage } from '@paperseal/ui';
import { useState } from 'react';

import { useBoardForm, useEvaluated } from './BoardForm';
import { evaluatePublish, parseLocalTime, whenTyped } from './form';
import { Fold, Input, Problem } from './Parts';
import { bankNeeded, durationError, formatWhen, isTight, plainWords, type PlanInput } from './plan';

/** Everything the exam needs, on one page. Rounds and hashes are worked out, and shown only in the review's record. */
export function CreateStep(props: { eyebrow: string; onContinue: () => void }) {
  const { plan, setPlan, publish, setPublish } = useBoardForm();
  const { blueprint, schedule, nowSeconds } = useEvaluated();
  const [folded, setFolded] = useState(true);
  const set = (patch: Partial<PlanInput>) => {
    setPlan({ ...plan, ...patch });
  };
  const setTopic = (index: number, patch: Partial<PlanInput['topics'][number]>) => {
    set({ topics: plan.topics.map((topic, i) => (i === index ? { ...topic, ...patch } : topic)) });
  };

  const hostError = evaluatePublish(publish, null).errors.rpcHost;
  const ready = Boolean(blueprint.criteria && blueprint.examId && schedule.settings && !hostError);
  // Advanced is folded only while it has nothing the board must deal with.
  const advancedNeeded = Boolean(blueprint.percentError ?? blueprint.multipleError ?? hostError ?? false);
  const lockAt = schedule.lock?.entered ?? null;
  const missing = [
    plan.name === '' ? 'the exam name' : null,
    parseLocalTime(plan.examStart) === null ? 'the date and time' : null,
    plan.topics.some((topic) => topic.name === '' || topic.questions === '') ? 'the topics and their question counts' : null,
  ].filter((part) => part !== null);
  const needs = blueprint.criteria ? bankNeeded(blueprint.criteria) : null;

  return (
    <Stage
      eyebrow={props.eyebrow}
      title="Create the exam"
      lede="Say when the exam is and what the paper covers. We work out the rest."
      action={
        <form
          className="board-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) props.onContinue();
          }}
        >
          <Panel title="The exam">
            <Input
              label="Exam name"
              hint="Published names are final, and each exam needs its own."
              error={whenTyped(plan.name, blueprint.nameError)}
              value={plan.name}
              onChange={(name) => {
                set({ name });
              }}
            />
            <Input
              label="Date and time of the exam"
              type="datetime-local"
              value={plan.examStart}
              error={whenTyped(plan.examStart, schedule.errors.examStart)}
              onChange={(examStart) => {
                set({ examStart });
              }}
            />
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
              <span className="board-sentence">
                Release to centres
                <input
                  className="ps-input"
                  inputMode="numeric"
                  aria-label="Minutes before the exam to release the paper to centres"
                  value={plan.releaseMinutes}
                  onChange={(event) => {
                    set({ releaseMinutes: event.target.value });
                  }}
                />
                minutes before
              </span>
              {schedule.errors.deltaMinutes && plan.releaseMinutes.trim() !== '' ? (
                <span className="ps-field-error">{plainWords(schedule.errors.deltaMinutes)}</span>
              ) : null}
            </label>
          </Panel>
          <Panel title="Topics">
            {plan.topics.map((topic, index) => (
              <div className="board-topic" key={index}>
                <Input
                  label={`Topic ${String(index + 1)} name`}
                  error={whenTyped(topic.name, blueprint.topicErrors[index]?.name)}
                  value={topic.name}
                  onChange={(name) => {
                    setTopic(index, { name });
                  }}
                />
                <Input
                  label={`Topic ${String(index + 1)} questions`}
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
            <Button
              onClick={() => {
                set({ topics: [...plan.topics, { name: '', questions: '' }] });
              }}
            >
              Add topic
            </Button>
          </Panel>
          {lockAt !== null ? (
            <p className="board-note" role="status">
              Questions close {formatWhen(lockAt)}.
              {isTight(lockAt, nowSeconds) ? ' That leaves under 30 minutes to register everyone, which is too short for most exams.' : ''}
              {needs ? ` You will need at least ${String(needs.questions)} questions from at least ${String(needs.setters)} setters.` : ''}
            </p>
          ) : null}
          {blueprint.criteriaError ? <Problem>{blueprint.criteriaError}</Problem> : null}
          {schedule.scheduleError ? <Problem>{schedule.scheduleError}</Problem> : null}
          <div
            onToggle={(event) => {
              setFolded(!(event.target as HTMLDetailsElement).open);
            }}
          >
            <Fold summary="Advanced" open={advancedNeeded || !folded}>
              <Input
                label="Most of a topic one setter can write, in percent"
                hint="From 1 to 100."
                numeric
                error={whenTyped(plan.maxSetterPercent, blueprint.percentError)}
                value={plan.maxSetterPercent}
                onChange={(maxSetterPercent) => {
                  set({ maxSetterPercent });
                }}
              />
              <Input
                label="Question bank size, as a multiple of the questions used"
                hint="Each topic's bank must be this many times its question count, at least 2."
                numeric
                error={whenTyped(plan.minBankMultiple, blueprint.multipleError)}
                value={plan.minBankMultiple}
                onChange={(minBankMultiple) => {
                  set({ minBankMultiple });
                }}
              />
              <Input
                label="Questions close"
                type="datetime-local"
                hint="Leave empty to use the time above."
                error={whenTyped(plan.lockTime, schedule.errors.lockTime)}
                value={plan.lockTime}
                onChange={(lockTime) => {
                  set({ lockTime });
                }}
              />
              <Input
                label="Public record provider"
                hint="The host name the sealed machine reads the public record from, such as sepolia.example.org."
                error={whenTyped(publish.rpcHost, hostError)}
                value={publish.rpcHost}
                onChange={(rpcHost) => {
                  setPublish({ ...publish, rpcHost });
                }}
              />
            </Fold>
          </div>
          {!ready && missing.length > 0 ? <p className="board-blocked">Still needed: {missing.join(', ')}.</p> : null}
          <div>
            <PrimaryAction type="submit" disabled={!ready}>
              Continue
            </PrimaryAction>
          </div>
        </form>
      }
      next="You choose the version of the sealed machine, then review everything before it is published."
    />
  );
}
