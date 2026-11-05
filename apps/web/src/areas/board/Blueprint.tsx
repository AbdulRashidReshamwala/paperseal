import { Badge, Button, Field, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';

import { useBoardForm, useEvaluated } from './BoardForm';
import { whenTyped } from './form';

export function Blueprint() {
  const { blueprint, setBlueprint } = useBoardForm();
  const result = useEvaluated().blueprint;
  const { topics } = blueprint;

  const setTopic = (index: number, patch: Partial<(typeof topics)[number]>) => {
    setBlueprint({ ...blueprint, topics: topics.map((topic, i) => (i === index ? { ...topic, ...patch } : topic)) });
  };

  return (
    <Screen title="Blueprint" lede="Topics, questions per topic and setter limits. These become the selection criteria.">
      <Panel title="Exam">
        <Field
          label="Exam name"
          hint="The exam ID is the keccak256 of this name, exactly as typed."
          error={whenTyped(blueprint.name, result.nameError)}
          value={blueprint.name}
          onChange={(name) => {
            setBlueprint({ ...blueprint, name });
          }}
        />
        <Rows>
          <Row label="Exam ID">{result.examId ? <Mono>{result.examId}</Mono> : 'Not set yet.'}</Row>
        </Rows>
      </Panel>
      <Panel title="Topics">
        {topics.map((topic, index) => (
          <div key={index}>
            <Field
              label={`Topic ${String(index + 1)} name`}
              error={whenTyped(topic.name, result.topicErrors[index]?.name)}
              value={topic.name}
              onChange={(name) => {
                setTopic(index, { name });
              }}
            />
            <Field
              label={`Topic ${String(index + 1)} questions`}
              hint="How many questions the paper takes from this topic."
              error={whenTyped(topic.questions, result.topicErrors[index]?.questions)}
              value={topic.questions}
              onChange={(questions) => {
                setTopic(index, { questions });
              }}
            />
            <Button
              aria-label={`Remove topic ${String(index + 1)}`}
              onClick={() => {
                setBlueprint({ ...blueprint, topics: topics.filter((_, i) => i !== index) });
              }}
            >
              Remove topic
            </Button>
          </div>
        ))}
        <Button
          onClick={() => {
            setBlueprint({ ...blueprint, topics: [...topics, { name: '', questions: '' }] });
          }}
        >
          Add topic
        </Button>
      </Panel>
      <Panel title="Setter limits">
        <Field
          label="maxSetterPercent"
          hint="The most of a topic's bank one setter can hold, from 1 to 100."
          error={whenTyped(blueprint.maxSetterPercent, result.percentError)}
          value={blueprint.maxSetterPercent}
          onChange={(maxSetterPercent) => {
            setBlueprint({ ...blueprint, maxSetterPercent });
          }}
        />
        <Field
          label="minBankMultiple"
          hint="How many times larger than its question count each topic's bank must be, at least 2."
          error={whenTyped(blueprint.minBankMultiple, result.multipleError)}
          value={blueprint.minBankMultiple}
          onChange={(minBankMultiple) => {
            setBlueprint({ ...blueprint, minBankMultiple });
          }}
        />
      </Panel>
      <Panel title="Result">
        {result.criteriaError ? <Badge tone="bad">{result.criteriaError}</Badge> : null}
        <Rows>
          <Row label="selectedCount">{result.selectedCount === null ? 'Not valid yet.' : result.selectedCount}</Row>
          <Row label="criteriaHash">{result.criteriaHash ? <Mono>{result.criteriaHash}</Mono> : 'Not valid yet.'}</Row>
          <Row label="Status">
            {result.criteria ? <Badge tone="ok">Criteria accepted</Badge> : <Badge tone="warn">Incomplete</Badge>}
          </Row>
        </Rows>
        <p className="ps-field-hint">
          Checked by encodeCriteria and checkCriteria from @paperseal/protocol, the same rules ExamRegistry callers and the
          TEE apply. The full criteria go on-chain at publish, so anyone can recompute this hash.
        </p>
      </Panel>
    </Screen>
  );
}
