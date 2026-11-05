import { roles, roundTimeSeconds, toHex, requireHardwareAttestation } from '@paperseal/protocol';
import { Check, Countdown, KeyTouch, Page, PrimaryAction, RoleHeader, Seal, Stage } from '@paperseal/ui';
import { useMemo, useState, type ReactNode } from 'react';

import type { ReleaseContext } from '../../release/flow';
import { Gate, TechnicalDetail } from '../../release/Gate';
import { useHolderProgress, type HolderProgress, type ProgressActions } from '../../release/progress';
import { ReleaseCount, ReleaseStage, releaseContext } from '../../release/ReleaseStage';
import { UnlockLog } from './Log';
import { PaperSheet } from './PaperSheet';
import { centreStage, sealFor, type CentreStage } from './stage';
import { useDownload, type Files } from './useDownload';
import { useOpenPaper, type OpenPaper } from './useOpenPaper';
import './paper.css';

/** The one line for the files. They look after themselves, so nobody has to ask. */
function FilesLine({ files }: { files: Files }) {
  switch (files.state) {
    case 'ready':
      return <Check status="pass">Sealed paper downloaded and checked</Check>;
    case 'unavailable':
      return <Check status="pending">The sealed paper can't be downloaded yet. This page keeps trying.</Check>;
    case 'refused':
      return <Check status="fail">Download check</Check>;
    case 'running':
      return <Check status="pending">Downloading and checking the sealed paper</Check>;
    case 'idle':
      return <Check status="not-checked">The sealed paper has not been downloaded yet</Check>;
  }
}

function OpenAction({ open }: { open: OpenPaper }) {
  const { phase, start } = open;
  const demo = !requireHardwareAttestation;
  switch (phase.name) {
    case 'idle':
      return <KeyTouch state="idle" purpose="to open the paper" actionLabel="Open the paper" onUse={start} demo={demo} />;
    case 'touch':
      return <KeyTouch state="waiting" onUse={start} demo={demo} />;
    case 'key-failed':
      return <KeyTouch state="failed" error={phase.error} onUse={start} demo={demo} />;
    default:
      return (
        <PrimaryAction status="busy" busyLabel={phase.name === 'opening' ? 'Opening and checking the paper' : 'Getting ready'}>
          Open the paper
        </PrimaryAction>
      );
  }
}

/** One page: the exam's state decides what shows, and the seal stays mounted so it breaks in place. */
export function CentreView(props: {
  progress: HolderProgress;
  actions: ProgressActions;
  context: ReleaseContext | null;
  files: Files;
  retryFiles: () => void;
  open: OpenPaper;
  justReleased: boolean;
  onReleased: () => void;
  /** The checked unlock log. A prop so the page can be shown without a sealed machine. */
  log?: ReactNode;
}) {
  const { progress, actions, context, files, open, justReleased } = props;
  const refusal = open.phase.name === 'failed' ? open.phase.refusal : null;
  const stage: CentreStage = centreStage(progress, {
    filesReady: files.state === 'ready',
    filesRefused: files.state === 'refused',
    paper: open.paper,
    openFailed: refusal !== null,
    justReleased,
  });
  const seal = sealFor(stage);
  const status = progress.status.value;
  const round = progress.chain.value?.unlockRound ?? null;
  const holdsShare = progress.chain.value?.entry?.role === roles.centreKeyHolder;
  const released = status?.stage === 'released';

  function body() {
    switch (stage) {
      case 'awaiting-build':
        return (
          <Stage
            title="The paper has not been sealed yet"
            next="Once it is, this page downloads it and checks it by itself. You can leave this page open."
          />
        );
      case 'waiting':
        return (
          <Stage
            title={files.state === 'ready' ? 'The sealed paper is here. Nothing to do yet.' : 'Getting the sealed paper'}
            {...(holdsShare ? { lede: 'Your centre holds a share. You will release it here at unlock.' } : {})}
            next="At unlock, this page asks for one touch of your security key to open the paper."
          >
            <FilesLine files={files} />
            {round !== null ? <Countdown at={roundTimeSeconds(round) * 1000} round={round} label="Paper unlocks in" /> : null}
          </Stage>
        );
      case 'files-refused':
        return (
          <Stage
            title="The sealed paper failed its check"
            lede="The download does not match the public record, so it will not be used. Contact your exam board now and tell them the download check failed at your centre."
            action={<PrimaryAction onClick={props.retryFiles}>Download and check again</PrimaryAction>}
            next="The paper can't be opened from this computer until this check passes."
          >
            <FilesLine files={files} />
            {files.state === 'refused' ? <TechnicalDetail>{files.detail}</TechnicalDetail> : null}
          </Stage>
        );
      case 'release':
        return (
          <ReleaseStage
            context={context}
            onReleased={props.onReleased}
            next="Once enough key holders have released, this page lets you open the paper."
          >
            <ReleaseCount status={status} />
          </ReleaseStage>
        );
      case 'holders':
        return (
          <Stage title="Waiting for key holders" next="Once enough have released, this page lets you open the paper. You don't need to do anything.">
            <ReleaseCount status={status} />
          </Stage>
        );
      case 'files-pending':
        return (
          <Stage title="Getting the sealed paper" next="This page lets you open the paper as soon as it has been downloaded and checked.">
            <FilesLine files={files} />
          </Stage>
        );
      case 'open':
        return (
          <Stage
            title="Open the paper"
            lede="It shows only after it has passed its check."
            action={<OpenAction open={open} />}
            next="The paper appears on this page, ready to print."
          />
        );
      case 'open-failed':
        return (
          <Stage
            title={refusal?.title ?? 'The paper could not be opened'}
            lede={
              <>
                <p>{refusal?.why}</p>
                <p>{refusal?.contact}</p>
              </>
            }
            {...(refusal?.canRetry ? { action: <PrimaryAction onClick={open.start}>Try again</PrimaryAction> } : {})}
            next="The paper stays hidden unless it passes its check."
          >
            {refusal ? <TechnicalDetail>{refusal.detail}</TechnicalDetail> : null}
          </Stage>
        );
      case 'paper-open':
        return (
          <Stage
            title="The paper is open"
            lede="It passed its check against the public record."
            action={
              <PrimaryAction
                onClick={() => {
                  globalThis.print();
                }}
              >
                Print the paper
              </PrimaryAction>
            }
            next="It is held on this page only. If you reload, one more touch of your security key opens it again."
          />
        );
      case 'machine-waiting':
        return (
          <Stage
            title="Waiting for the sealed machine"
            lede="The unlock time has come, but the sealed machine is not ready yet."
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
            lede="It reported a failure, so the paper can't be delivered. Contact your exam board now and tell them your centre can't open the paper."
            next="The paper stays sealed. Your exam board decides what happens next."
          />
        );
      default:
        return <Gate stage={stage} role="centre" progress={progress} actions={actions} />;
    }
  }

  return (
    <Page header={<RoleHeader role="Exam centre" {...(progress.credential ? { note: progress.credential.owner } : {})} />}>
      <div className="centre-noprint">
        {seal ? (
          <div className="centre-seal">
            <Seal state={seal} size={stage === 'paper-open' ? 112 : 168} caption />
          </div>
        ) : null}
        <div className="centre-stage">{body()}</div>
      </div>
      {open.paper ? <PaperSheet paper={open.paper} /> : null}
      {released ? <div className="centre-noprint">{props.log ?? <UnlockLog />}</div> : null}
    </Page>
  );
}

export default function CentreArea() {
  const { progress, actions } = useHolderProgress('centre');
  const { files, retry } = useDownload(progress.chain.value?.buildPosted ?? false);
  const open = useOpenPaper(files.state === 'ready' ? files.downloaded : null, progress.credential);
  const [justReleased, setJustReleased] = useState(false);
  const entry = progress.chain.value?.entry;
  const derivedPublicKey = entry && entry.derivedPublicKey.length > 0 ? toHex(entry.derivedPublicKey) : null;
  const context = useMemo(
    () => releaseContext(progress.examId, progress.credential, derivedPublicKey),
    [progress.examId, progress.credential, derivedPublicKey],
  );
  return (
    <CentreView
      progress={progress}
      actions={actions}
      context={context}
      files={files}
      retryFiles={retry}
      open={open}
      justReleased={justReleased}
      onReleased={() => {
        setJustReleased(true);
        actions.refresh();
      }}
    />
  );
}
