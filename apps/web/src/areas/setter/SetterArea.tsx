import { useMemo } from 'react';

import { defaultEnv, SessionProvider, useSession, type SetterEnv } from './session';
import { SetterFlow } from './SetterFlow';

/** A new exam starts clean, so one exam's draft or topic can never carry into another. */
function CurrentFlow() {
  const { examId } = useSession();
  return <SetterFlow key={examId ?? 'none'} />;
}

/**
 * One page at every path under `/setter`: the exam's state picks what shows, so an old link to a
 * former tab lands in the right place. Tests pass `env` with stubs.
 */
export default function SetterArea(props: { env?: SetterEnv }) {
  const env = useMemo(() => props.env ?? defaultEnv(), [props.env]);
  return (
    <SessionProvider env={env}>
      <CurrentFlow />
    </SessionProvider>
  );
}
