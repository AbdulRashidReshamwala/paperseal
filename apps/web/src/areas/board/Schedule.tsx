import { Badge, Field, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';

import { useBoardForm, useEvaluated } from './BoardForm';
import { formatClock, localTimeZone, whenTyped, type RoundAtTime } from './form';

function RoundRow(props: { label: string; value: RoundAtTime | null }) {
  const { value } = props;
  return (
    <Row label={props.label}>
      {value ? (
        <>
          <Mono>round {value.round}</Mono>, produced {formatClock(value.producedAt)}
        </>
      ) : (
        'Not set yet.'
      )}
    </Row>
  );
}

export function Schedule() {
  const { schedule, setSchedule } = useBoardForm();
  const result = useEvaluated().schedule;
  const zone = localTimeZone();
  const hint = `Local time in ${zone}, as YYYY-MM-DD HH:mm.`;
  return (
    <Screen title="Schedule" lede="Exam start, Δ, lock and end, as clock times. drand rounds are derived from them.">
      <Panel title="Times">
        <Field
          label="Exam start, T"
          hint={hint}
          error={whenTyped(schedule.examStart, result.errors.examStart)}
          value={schedule.examStart}
          onChange={(examStart) => {
            setSchedule({ ...schedule, examStart });
          }}
        />
        <Field
          label="Δ, minutes before T that the paper unlocks"
          error={whenTyped(schedule.deltaMinutes, result.errors.deltaMinutes)}
          value={schedule.deltaMinutes}
          onChange={(deltaMinutes) => {
            setSchedule({ ...schedule, deltaMinutes });
          }}
        />
        <Field
          label="Lock time"
          hint={`${hint} The bank locks at the first round at or after this time.`}
          error={whenTyped(schedule.lockTime, result.errors.lockTime)}
          value={schedule.lockTime}
          onChange={(lockTime) => {
            setSchedule({ ...schedule, lockTime });
          }}
        />
        <Field
          label="End time"
          hint={`${hint} The paper opens to everyone at the first round at or after this time.`}
          error={whenTyped(schedule.endTime, result.errors.endTime)}
          value={schedule.endTime}
          onChange={(endTime) => {
            setSchedule({ ...schedule, endTime });
          }}
        />
      </Panel>
      <Panel title="Resulting drand rounds">
        <Rows>
          <RoundRow label="Lock round" value={result.lock} />
          <RoundRow label="Unlock round, at T − Δ" value={result.unlock} />
          <RoundRow label="End round" value={result.end} />
        </Rows>
        {result.scheduleError ? <Badge tone="bad">{result.scheduleError}</Badge> : null}
        {result.settings ? <Badge tone="ok">Schedule accepted</Badge> : null}
        <p className="ps-field-hint">
          Rounds are the first quicknet rounds at or after each clock time, so the paper can never open early by
          rounding. Checked by checkSchedule from @paperseal/protocol.
        </p>
      </Panel>
      <Panel title="This cannot be changed">
        <p>
          T, Δ and the rounds are written once to ExamRegistry when you publish. They cannot be changed afterwards, not
          even by the board. Check them before you publish.
        </p>
      </Panel>
    </Screen>
  );
}
