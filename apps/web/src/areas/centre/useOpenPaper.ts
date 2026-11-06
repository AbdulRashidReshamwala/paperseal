import { timelockDecrypt } from '@paperseal/crypto';
import { fromHex, toHex, type Paper } from '@paperseal/protocol';
import { useState } from 'react';

import { storageUrl } from '../../shared/config';
import { useCurrentExamId } from '../../shared/currentExam';
import { listEntryFor } from '../../shared/holder';
import { browserKeys, describeError, type StoredCredential } from '../../shared/Register';
import { registry } from '../../shared/registry';
import { storageFetcher, StorageVerificationError } from '../../shared/storage';
import { downloadPaperFiles, type Downloaded } from './download';
import { chainReaders } from './readers';
import { PaperHashMismatchError, unlockPaper, UnlockError, type UnlockStep } from './unlock';

export type OpenPhase =
  | { name: 'idle' }
  /** Getting the time seal and the centre's key. The security key is not used yet. */
  | { name: 'checking' }
  | { name: 'touch' }
  /** Opening the paper and checking it against the public record. */
  | { name: 'opening' }
  /** The security key itself did not answer. */
  | { name: 'key-failed'; error: unknown }
  | { name: 'failed'; refusal: Refusal };

/** Why the paper is not on screen, and who to tell. */
export interface Refusal {
  title: string;
  why: string;
  contact: string;
  /** Trying again can help. A paper that failed its check is never offered again. */
  canRetry: boolean;
  detail: string;
}

const TELL_THE_BOARD = 'Do not use any other copy. Contact your exam board now and tell them this check failed at your centre.';
const RETRY_THEN_BOARD = 'Try again. If it fails again, contact your exam board.';

/** Plain words for a failed unlock. The paper is never available by this point. */
export function refusalFor(step: UnlockStep | null, error: unknown): Refusal {
  const detail = describeError(error);
  if (error instanceof PaperHashMismatchError) {
    return {
      title: 'This paper failed its check and is not shown',
      why: 'It does not match the published record, so it may not be the paper that was sealed.',
      contact: TELL_THE_BOARD,
      canRetry: false,
      detail,
    };
  }
  if (error instanceof UnlockError) {
    switch (error.step) {
      case 'check':
        return {
          title: 'This paper failed its check and is not shown',
          why: 'It is not in the form this exam requires, or it belongs to a different exam.',
          contact: TELL_THE_BOARD,
          canRetry: false,
          detail,
        };
      case 'decrypt':
        return {
          title: 'The paper could not be opened',
          why: 'The key your centre received does not open this paper.',
          contact: TELL_THE_BOARD,
          canRetry: false,
          detail,
        };
      case 'timelock':
        return {
          title: 'The paper is not ready to open yet',
          why: 'This computer could not get what it needs to open the paper. It may be a network problem.',
          contact: RETRY_THEN_BOARD,
          canRetry: true,
          detail,
        };
      case 'keyPriv':
        return {
          title: 'Your centre’s part of the key has not arrived',
          why: 'Your centre’s part of the key could not be downloaded.',
          contact: RETRY_THEN_BOARD,
          canRetry: true,
          detail,
        };
      default:
        break;
    }
  }
  return {
    title: 'The paper could not be opened',
    why:
      error instanceof StorageVerificationError
        ? 'The files on this computer do not match the public record.'
        : step
          ? 'Something went wrong while opening it.'
          : 'Something stopped it before your security key was used.',
    contact: RETRY_THEN_BOARD,
    canRetry: true,
    detail,
  };
}

export interface OpenPaper {
  phase: OpenPhase;
  /** Set only after `unlockPaper` returns, which is after every check has passed. */
  paper: Paper | null;
  start: () => void;
}

/** "Open the paper". Held in memory only: a reload closes it, and it needs one more touch to open. */
export function useOpenPaper(downloaded: Downloaded | null, identity: StoredCredential | null): OpenPaper {
  const examId = useCurrentExamId();
  const [phase, setPhase] = useState<OpenPhase>({ name: 'idle' });
  const [paper, setPaper] = useState<Paper | null>(null);

  async function run() {
    if (!registry || !examId || !storageUrl || !identity) return;
    let current: UnlockStep | null = null;
    setPhase({ name: 'checking' });
    try {
      const own = await listEntryFor(registry, examId, identity.passkeyPublicKey);
      if (!own || own.derivedPublicKey.length === 0) throw new Error('Your security key is not an approved centre on the on-chain list.');
      const fetchFile = storageFetcher(storageUrl, examId);
      const readers = chainReaders(registry, examId);
      const build = await readers.readBuild();
      if (!build) throw new Error('No paper has been committed on-chain yet.');
      const files =
        downloaded ??
        (await downloadPaperFiles({ examId, fetchFile, readBuild: readers.readBuild, readListEntries: readers.readListEntries }));
      const shown = await unlockPaper({
        examId,
        credentialId: fromHex(identity.credentialId),
        derivedPublicKey: toHex(own.derivedPublicKey),
        keys: browserKeys(),
        build,
        criteria: await readers.readCriteria(),
        paperFile: files.paper,
        keyPubTlock: files.keyPubTlock,
        timelockDecrypt: (ciphertext) => timelockDecrypt(ciphertext),
        fetchFile,
        onStep: (step) => {
          current = step;
          setPhase(step === 'touch' ? { name: 'touch' } : step === 'decrypt' || step === 'check' ? { name: 'opening' } : { name: 'checking' });
        },
      });
      setPaper(shown);
      setPhase({ name: 'idle' });
    } catch (error) {
      setPaper(null);
      if (current === 'touch' && !(error instanceof UnlockError)) setPhase({ name: 'key-failed', error });
      else setPhase({ name: 'failed', refusal: refusalFor(current, error) });
    }
  }

  return {
    phase,
    paper,
    start: () => {
      void run();
    },
  };
}
