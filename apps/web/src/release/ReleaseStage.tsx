import { fromHex, requireHardwareAttestation, type Hex } from '@paperseal/protocol';
import { RELEASE_NOT_OPEN_MESSAGE } from '@paperseal/tee-client';
import { KeyTouch, PrimaryAction, Stage, type SealState } from '@paperseal/ui';
import { useState, type ReactNode } from 'react';

import { attestationChecker } from '../shared/attest';
import { storageUrl } from '../shared/config';
import { browserKeys, describeError, type StoredCredential } from '../shared/Register';
import { registry } from '../shared/registry';
import { storageFetcher } from '../shared/storage';
import { tee } from '../shared/tee';
import { ReleaseAbortedError, runRelease, type ReleaseContext, type ReleaseStep } from './flow';
import { TechnicalDetail } from './Gate';
import './holder.css';

/** Everything the release flow needs, or null until it all exists. The derived key comes from the on-chain list. */
export function releaseContext(examId: Hex | null, credential: StoredCredential | null, derivedPublicKey: Hex | null): ReleaseContext | null {
  if (!tee || !registry || !examId || !storageUrl || !credential || !derivedPublicKey) return null;
  const reader = registry;
  return {
    examId,
    credentialId: fromHex(credential.credentialId),
    passkeyPublicKey: credential.passkeyPublicKey,
    derivedPublicKey,
    keys: browserKeys(),
    tee,
    checkAttestation: attestationChecker({ registry: reader, examId }),
    readOnChainListHash: async () => {
      const list = await reader.getApprovedList(examId);
      if (!list) throw new Error('No approved list has been posted on-chain.');
      return list.listHash;
    },
    readBuild: async () => {
      const build = await reader.getBuild(examId);
      if (!build) throw new Error('No paper has been committed on-chain yet.');
      return build;
    },
    fetchFile: storageFetcher(storageUrl, examId),
  };
}

type Phase =
  | { name: 'idle' }
  /** Checking the sealed machine and the share file. The key is not used yet. */
  | { name: 'checking' }
  | { name: 'touch' }
  | { name: 'sending' }
  /** The security key itself did not answer. */
  | { name: 'key-failed'; error: unknown }
  /** The sealed machine says the unlock round is not published yet. */
  | { name: 'not-open' }
  | { name: 'failed'; step: ReleaseStep | null; detail: string };

const WHY: Record<ReleaseStep, string> = {
  attest: 'We could not confirm that this page is talking to the real Paper Seal, so nothing was sent.',
  listHash: 'The list of people did not match the public record, so nothing was sent.',
  fetch: 'Your part of the key could not be downloaded, or it did not match the public record. Nothing was sent.',
  challenge: 'Paper Seal did not answer. Nothing was sent.',
  release: 'Your part of the key did not match the public record, so it was not sent.',
  submit: 'Your part of the key did not reach Paper Seal.',
};

/**
 * The one release action for a key holder or a centre that holds a share. Pressing it runs the
 * whole release flow, and the security key is touched once, in the middle of it. `context` is null
 * if the page has lost what the flow needs, which shows as a failure and not as a working button.
 */
export function ReleaseStage(props: {
  context: ReleaseContext | null;
  onReleased: () => void;
  seal?: SealState;
  next: ReactNode;
  children?: ReactNode;
}) {
  const { context } = props;
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });

  async function start() {
    if (!context) return;
    let current: ReleaseStep | null = null;
    setPhase({ name: 'checking' });
    try {
      await runRelease({
        ...context,
        onStep: (step) => {
          current = step;
          setPhase(step === 'release' ? { name: 'touch' } : step === 'submit' ? { name: 'sending' } : { name: 'checking' });
        },
      });
      props.onReleased();
    } catch (error) {
      if (current === 'release' && !(error instanceof ReleaseAbortedError)) {
        setPhase({ name: 'key-failed', error });
      } else if (error instanceof ReleaseAbortedError && error.message === RELEASE_NOT_OPEN_MESSAGE) {
        setPhase({ name: 'not-open' });
      } else {
        setPhase({ name: 'failed', step: current, detail: describeError(error) });
      }
    }
  }
  const go = () => void start();
  const demo = !requireHardwareAttestation;

  const stage = { next: props.next, ...(props.seal ? { seal: props.seal } : {}) };
  if (!context) {
    return (
      <Stage
        {...stage}
        title="You can't release your part of the key from this page"
        lede="This page is missing something it needs. Reload it. If this stays, contact your exam board."
      >
        {props.children}
      </Stage>
    );
  }
  if (phase.name === 'not-open') {
    return (
      <Stage
        {...stage}
        title="Release is not open yet"
        lede="It is not quite time. Wait a minute, then press the button."
        action={<PrimaryAction onClick={go}>Try again</PrimaryAction>}
      >
        {props.children}
      </Stage>
    );
  }
  if (phase.name === 'failed') {
    return (
      <Stage
        {...stage}
        title="Your part of the key was not sent"
        lede={`${phase.step ? WHY[phase.step] : 'The release could not start.'} Try again. If it fails again, contact your exam board.`}
        action={<PrimaryAction onClick={go}>Try again</PrimaryAction>}
      >
        <TechnicalDetail>{phase.detail}</TechnicalDetail>
        {props.children}
      </Stage>
    );
  }
  return (
    <Stage
      {...stage}
      title="Release your part of the key"
      lede="Touch your security key once. That sends your part of the key."
      action={
        phase.name === 'idle' ? (
          <KeyTouch state="idle" purpose="to release your part of the key" actionLabel="Release my part of the key" onUse={go} demo={demo} />
        ) : phase.name === 'touch' ? (
          <KeyTouch state="waiting" onUse={go} demo={demo} />
        ) : phase.name === 'key-failed' ? (
          <KeyTouch state="failed" error={phase.error} onUse={go} demo={demo} />
        ) : (
          <PrimaryAction status="busy" busyLabel={phase.name === 'sending' ? 'Sending your part of the key' : 'Checking before your security key is used'}>
            Release my part of the key
          </PrimaryAction>
        )
      }
    >
      {props.children}
    </Stage>
  );
}

/** The live count, such as "6 of 8 released". It says so when the count can't be read, and never guesses. */
export function ReleaseCount(props: { status: { release: { released: readonly unknown[]; required: number } } | null }) {
  const { status } = props;
  return status ? (
    <p className="holder-count" role="status">
      {status.release.released.length} of {status.release.required} parts of the key released
    </p>
  ) : (
    <p className="holder-count-note">We can't see how many parts of the key are released right now. This page keeps trying.</p>
  );
}
