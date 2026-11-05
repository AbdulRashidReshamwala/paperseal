import { Badge, Button, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useState } from 'react';

import { releaseStepLabels, releaseSteps, runRelease, type ReleaseContext, type ReleaseStep } from './flow';

export interface Prerequisite {
  label: string;
  met: boolean;
}

type Progress =
  | { state: 'idle' }
  | { state: 'running'; step: ReleaseStep }
  | { state: 'done' }
  | { state: 'failed'; step: ReleaseStep | null; message: string };

/** Shared by the centre and keyholder apps. `context` is null until every prerequisite is met. */
export function ReleaseScreen(props: {
  prerequisites: readonly Prerequisite[];
  context: ReleaseContext | null;
}) {
  const { context } = props;
  const [progress, setProgress] = useState<Progress>({ state: 'idle' });

  async function start() {
    if (!context) return;
    let current: ReleaseStep | null = null;
    try {
      await runRelease({
        ...context,
        onStep: (step) => {
          current = step;
          setProgress({ state: 'running', step });
        },
      });
      setProgress({ state: 'done' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProgress({ state: 'failed', step: current, message });
    }
  }

  const activeStep = progress.state === 'running' ? progress.step : null;
  const running = progress.state === 'running';

  return (
    <Screen title="Release your share" lede="Available once the time seal opens at the unlock round.">
      <Panel title="Before you start">
        <Rows>
          {props.prerequisites.map(({ label, met }) => (
            <Row key={label} label={label}>
              <Badge tone={met ? 'ok' : 'bad'}>{met ? 'Ready' : 'Not ready'}</Badge>
            </Row>
          ))}
        </Rows>
      </Panel>
      <Panel title="Steps">
        <Rows>
          {releaseSteps.map((step) => (
            <Row key={step} label={releaseStepLabels[step]}>
              {step === activeStep ? <Badge tone="warn">In progress</Badge> : null}
              {progress.state === 'failed' && step === progress.step ? (
                <Badge tone="bad">Failed</Badge>
              ) : null}
            </Row>
          ))}
        </Rows>
      </Panel>
      {progress.state === 'failed' ? <Panel title="Release failed">{progress.message}</Panel> : null}
      {progress.state === 'done' ? <Panel title="Share released">The TEE accepted your share.</Panel> : null}
      <Button disabled={!context || running || progress.state === 'done'} onClick={() => void start()}>
        Release share
      </Button>
    </Screen>
  );
}
