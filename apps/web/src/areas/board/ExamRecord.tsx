import { Check, Hash, Row, Rows } from '@paperseal/ui';
import type { ReactNode } from 'react';

import type { Snapshot } from './examState';
import { formatClock } from './form';
import { EntryRows, Fold, ReceiptRows } from './Parts';
import { plainWords } from './plan';

/** The thin fold at the foot of every screen, for the detail an expert or an auditor asks for. */
export function ExamRecord(props: { snapshot: Snapshot; children?: ReactNode }) {
  const { found, list, build, status } = props.snapshot;
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
            <Row label="Lock round">{String(found.exam.settings.lockRound)}</Row>
            <Row label="Unlock round">{String(found.exam.settings.unlockRound)}</Row>
            <Row label="End round">{String(found.exam.settings.endRound)}</Row>
            <Row label="Public record provider">
              <span className="ps-mono">{found.exam.settings.rpcHost}</span>
            </Row>
            <Row label="Criteria hash">
              <Hash value={found.exam.settings.criteriaHash} label="criteria hash" />
            </Row>
            {found.criteriaProblem ? (
              <Row label="Criteria">
                <Check status="fail">{plainWords(found.criteriaProblem)}</Check>
              </Row>
            ) : null}
            {found.criteria?.topics.map((topic) => (
              <Row key={topic.name} label={`Topic: ${topic.name}`}>
                {topic.questions} questions
              </Row>
            ))}
          </>
        ) : null}
        {status ? <Row label="Sealed machine stage">{status.stage}</Row> : null}
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
            <Row label="Storage manifest">
              <Hash value={build.storageManifestHash} label="storage manifest" />
            </Row>
            <Row label="Instance key">
              <Hash value={build.instancePublicKey} label="instance key" />
            </Row>
          </>
        ) : null}
        {props.children}
        <ReceiptRows />
      </Rows>
      {list?.problem ? <Check status="fail">{plainWords(list.problem)}</Check> : null}
      {list && !list.problem ? <EntryRows entries={list.entries} /> : null}
    </Fold>
  );
}
