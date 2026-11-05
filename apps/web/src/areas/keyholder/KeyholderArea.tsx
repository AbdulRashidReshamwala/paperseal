import { toHex, roundTimeSeconds } from '@paperseal/protocol';
import { Countdown, Page, RoleHeader, Stage, Stamp } from '@paperseal/ui';
import { useMemo, useState } from 'react';

import type { ReleaseContext } from '../../release/flow';
import { Gate } from '../../release/Gate';
import { useHolderProgress, type HolderProgress, type ProgressActions } from '../../release/progress';
import { ReleaseCount, ReleaseStage, releaseContext } from '../../release/ReleaseStage';
import { keyholderStage } from './stage';

const AFTER_RELEASE = 'The paper reaches exam centres once enough key holders have released.';

/** One page: the exam's state decides what shows, and only one thing ever needs doing. */
export function KeyholderView(props: {
  progress: HolderProgress;
  actions: ProgressActions;
  context: ReleaseContext | null;
  /** The share went through in this visit, so the stamp presses down. */
  justReleased: boolean;
  onReleased: () => void;
}) {
  const { progress, actions, context, justReleased } = props;
  const stage = keyholderStage(progress, justReleased);
  const status = progress.status.value;
  const round = progress.chain.value?.unlockRound ?? null;

  function body() {
    switch (stage) {
      case 'waiting':
        return (
          <Stage
            title={progress.chain.value?.buildPosted ? 'Nothing to do yet. Your share is safe.' : 'Nothing to do yet.'}
            {...(progress.chain.value?.buildPosted ? {} : { lede: 'The paper has not been sealed, so there is no share to release yet.' })}
            next="At unlock, this page asks you to release your share with one touch of your security key. Keep it with you."
          >
            {round !== null ? <Countdown at={roundTimeSeconds(round) * 1000} round={round} label="Release opens in" /> : null}
          </Stage>
        );
      case 'release':
        return (
          <ReleaseStage context={context} onReleased={props.onReleased} seal="opening" next={AFTER_RELEASE}>
            <ReleaseCount status={status} />
          </ReleaseStage>
        );
      case 'done':
        return (
          <Stage
            title="Done. You can close this tab."
            lede={
              <div className="holder-stamp">
                <Stamp {...(justReleased ? { press: true } : {})}>Released</Stamp>
              </div>
            }
            next={AFTER_RELEASE}
          >
            <ReleaseCount status={status} />
          </Stage>
        );
      case 'not-needed':
        return (
          <Stage
            title="Done. You can close this tab."
            lede="Enough key holders released before you, so your share was not needed."
            next="Nothing more is needed from you."
          >
            <ReleaseCount status={status} />
          </Stage>
        );
      case 'machine-waiting':
        return (
          <Stage
            title="Waiting for the sealed machine"
            lede="The unlock time has come, but the sealed machine is not ready to take shares yet."
            next="This page moves on by itself. If nothing changes within a few minutes, contact your exam board."
          />
        );
      case 'machine-unreachable':
        return (
          <Stage
            title="The sealed machine can't be reached"
            lede="Check this computer's internet connection. This page keeps trying by itself."
            next="If this stays for more than a few minutes, contact your exam board."
          />
        );
      case 'machine-failed':
        return (
          <Stage
            title="The sealed machine has stopped"
            lede="It reported a failure, so it can't take your share. Contact your exam board now."
            next="Your share stays safe and has not been sent. Your exam board decides what happens next."
          />
        );
      default:
        return <Gate stage={stage} role="keyholder" progress={progress} actions={actions} />;
    }
  }

  return <Page header={<RoleHeader role="Key holder" />}>{body()}</Page>;
}

export default function KeyholderArea() {
  const { progress, actions } = useHolderProgress('keyholder');
  const [justReleased, setJustReleased] = useState(false);
  const entry = progress.chain.value?.entry;
  const derivedPublicKey = entry && entry.derivedPublicKey.length > 0 ? toHex(entry.derivedPublicKey) : null;
  const context = useMemo(
    () => releaseContext(progress.examId, progress.credential, derivedPublicKey),
    [progress.examId, progress.credential, derivedPublicKey],
  );
  return (
    <KeyholderView
      progress={progress}
      actions={actions}
      context={context}
      justReleased={justReleased}
      onReleased={() => {
        setJustReleased(true);
        actions.refresh();
      }}
    />
  );
}
