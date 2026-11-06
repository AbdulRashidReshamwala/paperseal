import { roundTimeSeconds } from '@paperseal/protocol';
import { Hash, Row, Rows } from '@paperseal/ui';
import type { ReactNode } from 'react';

import type { Snapshot } from './examState';
import { formatClock } from './form';
import { splitDetails } from './details';
import { EntryRows, Fold, Problem, ReceiptRows } from './Parts';
import { formatWhen } from './plan';

/** The thin fold at the foot of every screen, for the detail an expert or an auditor asks for. */
export function ExamRecord(props: { snapshot: Snapshot; children?: ReactNode }) {
  const { found, list, build, status, teeProblem } = props.snapshot;
  const at = (round: bigint | number | string) => `${formatWhen(roundTimeSeconds(Number(round)))} (round ${String(round)})`;
  return (
    <Fold summary="Exam record">
      <Rows>
        {found ? (
          <>
            <Row label="Exam ID">
              <Hash value={found.exam.settings.examId} label="exam ID" />
            </Row>
            <Row label="Commit">
              <Hash value={found.exam.commitHash} label="commit" />
            </Row>
            <Row label="Image digest">
              <Hash value={found.exam.imageDigest} label="image digest" />
            </Row>
            <Row label="Exam start">{formatClock(Number(found.exam.settings.examStart))}</Row>
            <Row label="Released to centres">{Number(found.exam.settings.delta) / 60} minutes before</Row>
            <Row label="Questions close">{at(found.exam.settings.lockRound)}</Row>
            <Row label="Paper released to centres">{at(found.exam.settings.unlockRound)}</Row>
            <Row label="Paper opens to everyone">{at(found.exam.settings.endRound)}</Row>
            <Row label="Public record address">
              <span className="ps-mono">{found.exam.settings.rpcHost}</span>
            </Row>
            <Row label="Topics fingerprint">
              <Hash value={found.exam.settings.criteriaHash} label="criteria hash" />
            </Row>
            {found.criteriaProblem ? (
              <Row label="Topics">
                <Problem>{found.criteriaProblem}</Problem>
              </Row>
            ) : null}
            {found.criteria?.topics.map((topic) => (
              <Row key={topic.name} label={`Topic: ${topic.name}`}>
                {topic.questions} questions
              </Row>
            ))}
          </>
        ) : null}
        {status ? <Row label="Paper Seal stage">{status.stage}</Row> : null}
        {teeProblem && splitDetails(teeProblem).detail ? <Row label="Paper Seal says">{splitDetails(teeProblem).detail}</Row> : null}
        {list ? (
          <Row label="List fingerprint">
            <Hash value={list.list.listHash} label="list fingerprint" />
          </Row>
        ) : null}
        {build ? (
          <>
            <Row label="Paper fingerprint">
              <Hash value={build.paperHash} label="paper fingerprint" />
            </Row>
            <Row label="File list fingerprint">
              <Hash value={build.storageManifestHash} label="storage manifest" />
            </Row>
            <Row label="Paper Seal key">
              <Hash value={build.instancePublicKey} label="instance key" />
            </Row>
          </>
        ) : null}
        {props.children}
        <ReceiptRows />
      </Rows>
      {list?.problem ? <Problem>{list.problem}</Problem> : null}
      {list && !list.problem ? <EntryRows entries={list.entries} /> : null}
    </Fold>
  );
}
