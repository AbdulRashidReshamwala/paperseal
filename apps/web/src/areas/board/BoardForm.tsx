import type { ExamRegistry } from '@paperseal/chain';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import {
  emptyBlueprint,
  emptyPublish,
  emptySchedule,
  evaluateBlueprint,
  evaluateSchedule,
  type BlueprintInput,
  type PublishInput,
  type ScheduleInput,
} from './form';
import { defaultEnvironment, type PublishEnvironment } from './publishFlow';

/*
 * The form lives here, in the board route area, so moving between Blueprint,
 * Schedule and Publish keeps what was typed. Nothing is stored anywhere else.
 */

interface BoardForm {
  blueprint: BlueprintInput;
  setBlueprint: (next: BlueprintInput) => void;
  schedule: ScheduleInput;
  setSchedule: (next: ScheduleInput) => void;
  publish: PublishInput;
  setPublish: (next: PublishInput) => void;
  environment: PublishEnvironment;
}

const BoardFormContext = createContext<BoardForm | null>(null);

export function BoardFormProvider(props: { environment?: PublishEnvironment | undefined; children: ReactNode }) {
  const [blueprint, setBlueprint] = useState(emptyBlueprint);
  const [schedule, setSchedule] = useState(emptySchedule);
  const [publish, setPublish] = useState(emptyPublish);
  const { environment: given } = props;
  const environment = useMemo(() => given ?? defaultEnvironment(), [given]);
  const value = useMemo(
    () => ({ blueprint, setBlueprint, schedule, setSchedule, publish, setPublish, environment }),
    [blueprint, schedule, publish, environment],
  );
  return <BoardFormContext.Provider value={value}>{props.children}</BoardFormContext.Provider>;
}

export function useBoardForm(): BoardForm {
  const form = useContext(BoardFormContext);
  if (!form) throw new Error('useBoardForm needs BoardFormProvider');
  return form;
}

/** The blueprint and schedule, each evaluated by @paperseal/protocol. */
export function useEvaluated() {
  const { blueprint, schedule } = useBoardForm();
  return {
    blueprint: useMemo(() => evaluateBlueprint(blueprint), [blueprint]),
    schedule: useMemo(() => evaluateSchedule(schedule), [schedule]),
  };
}

/** A read-only registry for the board area, from the same environment that publishing uses. */
export function useReader(): ExamRegistry | null {
  const { environment } = useBoardForm();
  return useMemo(() => environment.createRegistry?.() ?? null, [environment]);
}
