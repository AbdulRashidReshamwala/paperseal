import { examIdFromName, roundTimeSeconds, type Hex } from '@paperseal/protocol';
import { Check, Countdown, CopyButton, Row, Rows, Stage, type SealState } from '@paperseal/ui';
import { Link } from 'react-router';

import { useCurrentExamId } from '../../shared/currentExam';

import { useBoardForm } from './BoardForm';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { useNow } from './hooks';
import { sayOf } from './details';
import { Fold } from './Parts';
import {
  ensRecords,
  examNamePlaceholder,
  formatTimeOnly,
  parentPlaceholder,
  plainWords,
  verifierNameUrl,
  verifierUrl,
} from './plan';

/** Time alone opens the seal, so the state follows the scheduled times. */
export function sealStateAt(nowMs: number, unlockMs: number, endMs: number): SealState {
  if (nowMs < unlockMs) return 'sealed';
  return nowMs < endMs ? 'opening' : 'open';
}

/** A value shown in full, with a button that copies it once it is known. */
function RecordValue(props: { what: string; known: boolean; value: string }) {
  return (
    <span className="board-link">
      <span className="ps-mono">{props.value}</span>
      {props.known ? (
        <CopyButton text={props.value} aria-label={`Copy ${props.what}`}>
          Copy
        </CopyButton>
      ) : null}
    </span>
  );
}

/**
 * The records to set for an optional ENS name, from "Exam Names" in spec/api.md. Nothing here reads
 * ENS: the board sets the name itself, and the verifier checks it. `examName` is null when this
 * session didn't publish the exam, because ExamRegistry stores only the name's hash.
 */
function EnsName(props: { examName: string | null; registryAddress: Hex | null; verifier: string | null }) {
  const label = props.examName ?? examNamePlaceholder;
  return (
    <Fold summary="Give this exam an ENS name (optional)">
      <p className="board-note">
        Anyone can then check this exam by its name on the public page. With the board wallet, set these records for{' '}
        <span className="ps-mono">{label}.&lt;your primary name&gt;</span> on your name's resolver. With ENS v2 there is
        nothing to create first. See docs/ens-setup.md.
      </p>
      <Rows>
        <Row label="Subname">
          <RecordValue what="subname" known={props.examName !== null} value={label} />
        </Row>
        {ensRecords(props.registryAddress).map((entry) => (
          <Row key={entry.record} label={entry.record}>
            {entry.value ? (
              <RecordValue what={entry.record} known value={entry.value} />
            ) : (
              <Check status="not-checked">{`Not set up yet. Ask whoever installed Paper Seal to set ${entry.setting}.`}</Check>
            )}
          </Row>
        ))}
        {props.verifier ? (
          <Row label="Public page by name">
            <span className="ps-mono">{verifierNameUrl(props.verifier, `${label}.${parentPlaceholder}`)}</span>
          </Row>
        ) : null}
      </Rows>
    </Fold>
  );
}

/** Step 7: the Build is posted. From here the board only watches. */
export function StatusStep(props: { eyebrow: string; snapshot: Snapshot }) {
  const { snapshot } = props;
  const { receipts, examName, environment } = useBoardForm();
  const now = useNow();
  const settings = snapshot.found?.exam.settings;
  const unlockRound = Number(settings?.unlockRound ?? 0);
  const endRound = Number(settings?.endRound ?? 0);
  const unlockSeconds = roundTimeSeconds(unlockRound);
  const endSeconds = roundTimeSeconds(endRound);
  const seal = sealStateAt(now, unlockSeconds * 1000, endSeconds * 1000);
  const { status, teeProblem } = snapshot;
  const examId = useCurrentExamId();
  const verifier = verifierUrl(undefined, examId);
  // The session's name only counts for the exam it hashes to, not one opened from a link.
  const named = examName && settings && examIdFromName(examName).toLowerCase() === settings.examId.toLowerCase() ? examName : null;
  const justSealed = receipts.some((receipt) => receipt.kind === 'build' && receipt.outcome.matches);

  const copy: Record<SealState, { title: string; lede: string; next: string }> = {
    sealed: {
      title: `Sealed. Nothing to do until ${formatTimeOnly(unlockSeconds)}`,
      lede: 'The paper is sealed and its record is public. No one person can open it before then.',
      next: 'At that time, key holders release their parts of the key, and centres can open the paper. You do not need to do anything, and you can close this page.',
    },
    opening: {
      title: 'Key holders are releasing their parts of the key',
      lede: 'The paper can now be opened. Centres open it once enough key holders have released their parts of the key.',
      next: `Nothing to do. The paper opens to everyone at ${formatTimeOnly(endSeconds)}.`,
    },
    open: {
      title: 'The exam is over',
      lede: 'The exam has ended, so the paper is now open to everyone.',
      next: 'The public page shows the full record for this exam.',
    },
  };

  return (
    <Stage eyebrow={props.eyebrow} title={copy[seal].title} lede={copy[seal].lede} next={copy[seal].next} seal={seal} stampSeal={justSealed}>
      {seal === 'sealed' ? <Countdown at={unlockSeconds * 1000} round={unlockRound} label="Paper released to centres" reached="Now" /> : null}
      {seal === 'opening' ? <Countdown at={endSeconds * 1000} round={endRound} label="Opens to the public" reached="Now" /> : null}
      <Rows>
        <Row label="Key holders released">
          {status ? (
            `${String(status.release.released.length)} of ${String(status.release.required)} needed`
          ) : (
            <Check status="not-checked">{teeProblem ? plainWords(sayOf(teeProblem)) : 'Paper Seal has not answered yet.'}</Check>
          )}
        </Row>
        <Row label="Public page">
          {verifier ? (
            <span className="board-link">
              <a href={verifier} target="_blank" rel="noreferrer">
                Open the public page
              </a>
              <CopyButton text={verifier}>Copy public link</CopyButton>
            </span>
          ) : (
            <Check status="not-checked">The link is not set up yet. Ask whoever installed Paper Seal to add it.</Check>
          )}
        </Row>
      </Rows>
      <EnsName examName={named} registryAddress={environment.registryAddress} verifier={verifierUrl()} />
      <ExamRecord snapshot={snapshot} />
      <p className="board-quiet">
        <Link to="/board/new">Set up another exam</Link>
      </p>
    </Stage>
  );
}
