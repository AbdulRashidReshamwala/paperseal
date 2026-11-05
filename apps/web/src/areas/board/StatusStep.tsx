import { roundTimeSeconds } from '@paperseal/protocol';
import { Check, Countdown, Row, Rows, Stage, type SealState } from '@paperseal/ui';
import { Link } from 'react-router';

import { useBoardForm } from './BoardForm';
import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { useNow } from './hooks';
import { formatTimeOnly, plainWords, verifierUrl } from './plan';

/** Time alone opens the seal, so the state follows the rounds' scheduled times. */
export function sealStateAt(nowMs: number, unlockMs: number, endMs: number): SealState {
  if (nowMs < unlockMs) return 'sealed';
  return nowMs < endMs ? 'opening' : 'open';
}

/** Step 7: the Build is posted. From here the board only watches. */
export function StatusStep(props: { eyebrow: string; snapshot: Snapshot }) {
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
  const verifier = verifierUrl();
  const justSealed = receipts.some((receipt) => receipt.kind === 'build' && receipt.outcome.matches);

  const copy: Record<SealState, { title: string; lede: string; next: string }> = {
    sealed: {
      title: `Sealed. Nothing to do until ${formatTimeOnly(unlockSeconds)}`,
      lede: 'The paper is sealed and its record is public. No one person can open it.',
      next: 'At that time, key holders release their parts of the key and centres can open the paper.',
    },
    opening: {
      title: 'Key holders are releasing the paper',
      lede: 'The time seal has opened. Centres can open the paper once enough key holders have released.',
      next: `The paper opens to the public at ${formatTimeOnly(endSeconds)}.`,
    },
    open: {
      title: 'The exam is over',
      lede: 'The end time has passed, so anyone can now open the paper and check it.',
      next: 'The public verifier shows the full proof for this exam.',
    },
  };

  return (
    <Stage eyebrow={props.eyebrow} title={copy[seal].title} lede={copy[seal].lede} next={copy[seal].next} seal={seal} stampSeal={justSealed}>
      {seal === 'sealed' ? <Countdown at={unlockSeconds * 1000} round={unlockRound} label="Paper released to centres" reached="Now" /> : null}
      {seal === 'opening' ? <Countdown at={endSeconds * 1000} round={endRound} label="Opens to the public" reached="Now" /> : null}
      <Rows>
        <Row label="Key holders released">
          {status ? (
            `${String(status.release.released.length)} of the ${String(status.release.required)} needed`
          ) : (
            <Check status="not-checked">{teeProblem ? plainWords(teeProblem) : 'The sealed machine has not answered yet.'}</Check>
          )}
        </Row>
        <Row label="Public verifier">
          {verifier ? (
            <a href={verifier} target="_blank" rel="noreferrer">
              Open the public verifier
            </a>
          ) : (
            <Check status="not-checked">Its address is not set. Set VITE_VERIFIER_URL to link it.</Check>
          )}
        </Row>
      </Rows>
      <ExamRecord snapshot={snapshot} />
      <p className="board-quiet">
        <Link to="/board/blueprint">Set up another exam</Link>
      </p>
    </Stage>
  );
}
