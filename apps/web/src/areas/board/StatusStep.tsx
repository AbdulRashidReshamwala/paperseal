import { roundTimeSeconds, type Hex } from '@paperseal/protocol';
import { Check, Countdown, CopyButton, Stage, type SealState } from '@paperseal/ui';
import { Link } from 'react-router';

import { useBoardForm } from './BoardForm';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { useNow } from './hooks';
import { sayOf } from './details';
import { formatTimeOnly, plainWords, verifierUrl } from './plan';

/** Time alone opens the seal, so the state follows the scheduled times. */
export function sealStateAt(nowMs: number, unlockMs: number, endMs: number): Exclude<SealState, 'broken'> {
  if (nowMs < unlockMs) return 'sealed';
  return nowMs < endMs ? 'opening' : 'open';
}

/** Step 7: the Build is posted. From here the board only watches. */
export function StatusStep(props: { examId: Hex; snapshot: Snapshot }) {
  const { snapshot } = props;
  const { receipts } = useBoardForm();
  const now = useNow();
  const settings = snapshot.found?.exam.settings;
  const unlockRound = Number(settings?.unlockRound ?? 0);
  const endRound = Number(settings?.endRound ?? 0);
  const unlockSeconds = roundTimeSeconds(unlockRound);
  const endSeconds = roundTimeSeconds(endRound);
  const seal = sealStateAt(now, unlockSeconds * 1000, endSeconds * 1000);
  const { status, teeProblem } = snapshot;
  const { examId } = props;
  const verifier = verifierUrl(undefined, examId);
  const justSealed = receipts.some((receipt) => receipt.kind === 'build' && receipt.outcome.matches);

  const copy: Record<ReturnType<typeof sealStateAt>, { title: string; lede: string; next: string }> = {
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

  // Once the exam is over the public page is what is left, so it joins the summary.
  const publicPage = (
    <div className="board-public">
      <p className="ps-eyebrow">Public page</p>
      {verifier ? (
        <span className="board-public-links">
          <a href={verifier} target="_blank" rel="noreferrer">
            Open the public page
          </a>
          <CopyButton text={verifier}>Copy public link</CopyButton>
        </span>
      ) : (
        <Check status="not-checked">The link is not set up yet. Ask whoever installed Paper Seal to add it.</Check>
      )}
    </div>
  );

  return (
    <Stage title={copy[seal].title} lede={copy[seal].lede} next={copy[seal].next} seal={seal} stampSeal={justSealed}>
      <div className="board-summary">
        {seal === 'sealed' ? <Countdown at={unlockSeconds * 1000} round={unlockRound} label="Paper released to centres" reached="Now" /> : null}
        {seal === 'opening' ? <Countdown at={endSeconds * 1000} round={endRound} label="Opens to the public" reached="Now" /> : null}
        <div>
          <p className="ps-eyebrow">Key holders released</p>
          {status ? (
            <>
              <p className="board-figure">
                <strong>{status.release.released.length}</strong>
                <span> of {status.release.required} needed</span>
              </p>
              <progress className="board-progress" aria-label="Key holders released" max={status.release.required} value={Math.min(status.release.released.length, status.release.required)} />
            </>
          ) : (
            <Check status="not-checked">{teeProblem ? plainWords(sayOf(teeProblem)) : 'Paper Seal has not answered yet.'}</Check>
          )}
        </div>
        {seal === 'open' ? publicPage : null}
      </div>
      {seal === 'open' ? null : publicPage}
      <ExamRecord snapshot={snapshot} />
      <p className="board-quiet">
        <Link to="/board/new">Set up another exam</Link>
      </p>
    </Stage>
  );
}
