import type { ExamRegistry } from '@paperseal/chain';
import { decodeCriteria, fromHex, selectedCount, type Criteria, type Hex } from '@paperseal/protocol';
import { Badge, Connected, EmptyState, Mono, Row, Rows, Screen } from '@paperseal/ui';

import { Area, type AreaScreen } from '../../shared/Area';
import { useExamLoader } from '../../shared/currentExam';
import { fromTee, notConnectedToTee } from '../../shared/tee';
import { TeeStatus } from '../../shared/TeeStatus';
import { Blueprint } from './Blueprint';
import { BoardFormProvider, useReader } from './BoardForm';
import { formatClock } from './form';
import { Publish } from './Publish';
import { Schedule } from './Schedule';
import type { PublishEnvironment } from './publishFlow';

const loadOutbox = fromTee((tee) => tee.outbox());
const readApprovedList = (registry: ExamRegistry, id: Hex) => registry.getApprovedList(id);

/** The exam and its full criteria, both from ExamRegistry. */
async function readExam(registry: ExamRegistry, id: Hex) {
  const exam = await registry.getExam(id);
  if (!exam) return null;
  const encoded = await registry.getCriteria(id);
  let criteria: Criteria | null = null;
  if (encoded) {
    try {
      criteria = decodeCriteria(fromHex(encoded));
    } catch {
      criteria = null;
    }
  }
  return { exam, criteria };
}

const notConnected =
  'Set VITE_RPC_URL and VITE_REGISTRY_ADDRESS to read ExamRegistry, then publish an exam or set VITE_EXAM_ID.';

function Overview() {
  const load = useExamLoader(readExam, useReader());
  return (
    <Screen title="Overview" lede="The exam's stage, from the TEE and ExamRegistry.">
      <TeeStatus />
      <Connected title="ExamRegistry" notConnected={notConnected} load={load}>
        {(found) =>
          found ? (
            <Rows>
              <Row label="Exam ID">
                <Mono>{found.exam.settings.examId}</Mono>
              </Row>
              <Row label="Commit">
                <Mono>{found.exam.commitHash}</Mono>
              </Row>
              <Row label="Image digest">
                <Mono>{found.exam.imageDigest}</Mono>
              </Row>
              <Row label="Exam start, T">{formatClock(Number(found.exam.settings.examStart))}</Row>
              <Row label="Δ">{Number(found.exam.settings.delta) / 60} minutes</Row>
              <Row label="Lock round">{String(found.exam.settings.lockRound)}</Row>
              <Row label="Unlock round">{String(found.exam.settings.unlockRound)}</Row>
              <Row label="End round">{String(found.exam.settings.endRound)}</Row>
              <Row label="RPC operator host">
                <Mono>{found.exam.settings.rpcHost}</Mono>
              </Row>
              <Row label="criteriaHash">
                <Mono>{found.exam.settings.criteriaHash}</Mono>
              </Row>
              {found.criteria ? (
                <>
                  <Row label="Selected">{selectedCount(found.criteria)} questions</Row>
                  <Row label="Setter limit">{found.criteria.maxSetterPercent}% of a topic</Row>
                  <Row label="Bank size">at least {found.criteria.minBankMultiple} times the questions per topic</Row>
                  {found.criteria.topics.map((topic) => (
                    <Row key={topic.name} label={`Topic: ${topic.name}`}>
                      {topic.questions} questions
                    </Row>
                  ))}
                </>
              ) : null}
            </Rows>
          ) : (
            'This exam has not been published. Use Publish to write it to ExamRegistry.'
          )
        }
      </Connected>
    </Screen>
  );
}

function Onboarding() {
  return (
    <Screen title="Onboarding" lede="Key holders and approved centres registered through the TEE.">
      <TeeStatus />
      <EmptyState title="No registrations">
        Centres and neutral parties register their own security keys in their areas.
      </EmptyState>
    </Screen>
  );
}

function ApprovedList() {
  const load = useExamLoader(readApprovedList, useReader());
  return (
    <Screen title="Approved list" lede="The final list, signed by the board and by the TEE.">
      <Connected title="On-chain list" notConnected={notConnected} load={load}>
        {(list) =>
          list ? (
            <Rows>
              <Row label="List hash">
                <Mono>{list.listHash}</Mono>
              </Row>
            </Rows>
          ) : (
            'No list has been posted.'
          )
        }
      </Connected>
    </Screen>
  );
}

function Outbox() {
  return (
    <Screen title="Outbox" lede="TEE-signed messages waiting for the board wallet to post.">
      <Connected title="Outbox" notConnected={notConnectedToTee} load={loadOutbox}>
        {({ messages }) =>
          messages.length === 0 ? (
            'Nothing waiting to post.'
          ) : (
            <Rows>
              {messages.map((message) => (
                <Row key={message.kind} label={message.kind}>
                  <Badge tone="warn">Waiting</Badge>
                </Row>
              ))}
            </Rows>
          )
        }
      </Connected>
      <EmptyState title="Posting">
        Wallet connection is not built, so nothing can be sent to ExamRegistry from here yet.
      </EmptyState>
    </Screen>
  );
}

export const screens: AreaScreen[] = [
  { path: '', label: 'Overview', element: <Overview /> },
  { path: 'blueprint', label: 'Blueprint', element: <Blueprint /> },
  { path: 'schedule', label: 'Schedule', element: <Schedule /> },
  { path: 'publish', label: 'Publish', element: <Publish /> },
  { path: 'onboarding', label: 'Onboarding', element: <Onboarding /> },
  { path: 'list', label: 'Approved list', element: <ApprovedList /> },
  { path: 'outbox', label: 'Outbox', element: <Outbox /> },
];

export default function BoardArea(props: { environment?: PublishEnvironment }) {
  return (
    <BoardFormProvider environment={props.environment}>
      <Area name="Board" base="/board" screens={screens} />
    </BoardFormProvider>
  );
}
