import { chain } from '@paperseal/protocol';
import { Button, Hash, PrimaryAction, Row, Rows, Stage } from '@paperseal/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { setCurrentExamId } from '../../shared/currentExam';
import { useBoardForm, useEvaluated } from './BoardForm';
import { evaluatePublish, evaluateSchedule, formatClock } from './form';
import { useBoardWallet, walletStageLabels, type WalletStage } from './hooks';
import { Fold, Problem, WalletProblem } from './Parts';
import { bankNeeded, formatWhen } from './plan';
import { explainError, publishExam, type PublishRequest } from './publishFlow';
import type { Releases } from './releases';
import { versionSummary, VersionEvidence, VersionPicker, VersionProblems } from './VersionChoice';

type Progress = { state: 'idle' } | { state: 'running'; stage: WalletStage } | { state: 'failed'; message: string };

/**
 * Step 2: one summary, with the Paper Seal version already chosen, and one action that connects the
 * wallet if it must and asks it to confirm. A version that can't be used is explained here and blocks it.
 */
export function ReviewStep(props: { eyebrow: string; releases: Releases; onBack: () => void }) {
  const { plan, publish, setPublish, environment, addReceipt, resetDraft } = useBoardForm();
  const navigate = useNavigate();
  const { blueprint, schedule, scheduleInput } = useEvaluated();
  const boardWallet = useBoardWallet();
  const { wallet, ensureAccount } = boardWallet;
  const [progress, setProgress] = useState<Progress>({ state: 'idle' });

  const { fields } = evaluatePublish(publish, props.releases.verified);
  const request: PublishRequest | null =
    blueprint.examId && blueprint.encoded && blueprint.criteriaHash && schedule.settings && fields
      ? {
          examId: blueprint.examId,
          fields,
          schedule: schedule.settings,
          criteria: { encoded: blueprint.encoded, hash: blueprint.criteriaHash },
        }
      : null;

  async function confirm() {
    if (!request) return;
    // The lock time may have passed while this page was open.
    if (!evaluateSchedule(scheduleInput).settings) {
      setProgress({ state: 'failed', message: 'These times are no longer possible. Go back and choose new times.' });
      return;
    }
    setProgress({ state: 'running', stage: 'checking' });
    try {
      await ensureAccount();
      const outcome = await publishExam(environment, request, (stage) => {
        setProgress({ state: 'running', stage });
      });
      // The pointer follows the exam only when ExamRegistry returns what was sent. A mismatch leaves it where it was.
      if (outcome.matches) setCurrentExamId(request.examId);
      addReceipt({ kind: 'publish', outcome, version: request.fields.version, name: plan.name });
      setProgress({ state: 'idle' });
      // A correct read-back goes straight on to the invites. Only a mismatch stops on a receipt.
      if (outcome.matches) {
        resetDraft();
        void navigate('/board');
      }
    } catch (error) {
      setProgress({ state: 'failed', message: explainError(error) });
    }
  }

  const { criteria } = blueprint;
  const needs = criteria ? bankNeeded(criteria) : null;
  const running = progress.state === 'running';
  return (
    <Stage
      eyebrow={props.eyebrow}
      title="Review and publish"
      lede={
        <strong>Once you publish, nothing here can be changed, not even by the exam board.</strong>
      }
      action={
        <>
          <div className="board-section">
            <Rows>
              <Row label="Exam">{plan.name}</Row>
              {schedule.examStart !== null ? <Row label="Starts">{formatWhen(schedule.examStart)}</Row> : null}
              <Row label="Length">{plan.durationMinutes} minutes</Row>
              <Row label="Released to centres">{plan.releaseMinutes} minutes before</Row>
              {schedule.lock ? <Row label="Questions close">{formatWhen(schedule.lock.entered)}</Row> : null}
              {schedule.end ? <Row label="Opens to the public">{formatWhen(schedule.end.entered)}</Row> : null}
              {criteria?.topics.map((topic) => (
                <Row key={topic.name} label={`Topic: ${topic.name}`}>
                  {topic.questions} questions
                </Row>
              ))}
              {criteria && needs ? (
                <Row label="Question bank">
                  At least {needs.questions} questions in total, and no setter writes more than {criteria.maxSetterPercent}% of a topic
                </Row>
              ) : null}
              <Row label="Paper Seal version">{versionSummary(props.releases, publish.version)}</Row>
            </Rows>
          </div>
          <VersionProblems releases={props.releases} />
          <WalletProblem wallet={boardWallet} />
          {progress.state === 'failed' ? <Problem>{progress.message}</Problem> : null}
          <PrimaryAction
            disabled={!request}
            status={running ? 'busy' : 'idle'}
            busyLabel={progress.state === 'running' ? walletStageLabels[progress.stage] : ''}
            onClick={() => void confirm()}
          >
            Publish the exam
          </PrimaryAction>
        </>
      }
      next="Your wallet asks you to confirm once. Then you invite the people who take part."
    >
      <VersionPicker
        releases={props.releases}
        chosen={publish.version}
        onChoose={(version) => {
          setPublish({ ...publish, version });
        }}
      />
      {request ? (
        <Fold summary="Exam record">
          <Rows>
            <Row label="Network">Sepolia, chain {chain.chainId}</Row>
            <Row label="Public record contract">
              {environment.registryAddress ? <Hash value={environment.registryAddress} label="contract" /> : 'Not set.'}
            </Row>
            <Row label="Sent from">{wallet.account ? <Hash value={wallet.account} label="wallet account" /> : 'Your wallet, once connected.'}</Row>
            <Row label="Exam ID">
              <Hash value={request.examId} label="exam ID" />
            </Row>
            <Row label="Version">{request.fields.version}</Row>
            <VersionEvidence releases={props.releases} />
            <Row label="Commit">
              <Hash value={request.fields.commitHash} label="commit" />
            </Row>
            <Row label="Software image">
              <Hash value={request.fields.imageDigest} label="software image" />
            </Row>
            <Row label="Public record address">
              <span className="ps-mono">{request.fields.rpcHost}</span>
            </Row>
            <Row label="Exam start">
              {formatClock(request.schedule.examStart)} ({request.schedule.examStart})
            </Row>
            <Row label="Released before the start">{request.schedule.delta} seconds</Row>
            <Row label="Lock round">{request.schedule.lockRound}</Row>
            <Row label="Unlock round">{request.schedule.unlockRound}</Row>
            <Row label="End round">{request.schedule.endRound}</Row>
            <Row label="Topics">
              <Hash value={request.criteria.hash} label="criteria hash" />
            </Row>
          </Rows>
        </Fold>
      ) : null}
      <p className="board-quiet">
        <Button disabled={running} onClick={props.onBack}>
          Change the details
        </Button>
      </p>
    </Stage>
  );
}
