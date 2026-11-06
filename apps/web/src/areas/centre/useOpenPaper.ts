import { timelockDecrypt } from '@paperseal/crypto';
import { fromHex, toHex, type Hex, type Paper } from '@paperseal/protocol';
import { useEffect, useRef, useState } from 'react';

import { storageUrl } from '../../shared/config';
import { useCurrentExamId } from '../../shared/currentExam';
import { listEntryFor } from '../../shared/holder';
import { browserKeys, describeError, type StoredCredential } from '../../shared/Register';
import { registry } from '../../shared/registry';
import { storageFetcher, StorageVerificationError } from '../../shared/storage';
import { downloadPaperFiles, type Downloaded } from './download';
import { chainReaders } from './readers';
import { PaperHashMismatchError, prepareUnlock, unlockPaper, UnlockError, type PreparedUnlock, type UnlockStep } from './unlock';

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

/** How long what was got ahead of the press stays good. After this the press gets it again. */
export const EARLY_TTL_MS = 120_000;

/** What needs no security key: the centre's entry, the Build and criteria, the time seal and its sealed key. */
interface Early {
  derivedPublicKey: Hex;
  build: NonNullable<Awaited<ReturnType<ReturnType<typeof chainReaders>['readBuild']>>>;
  criteria: Awaited<ReturnType<ReturnType<typeof chainReaders>['readCriteria']>>;
  prepared: PreparedUnlock;
  at: number;
}

export interface OpenPaper {
  /** Gets what needs no security key, ahead of the press. It never starts the touch. */
  prepare: () => void;
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
  const early = useRef<Promise<Early | null> | null>(null);

  const wipe = (held: Early | null) => {
    held?.prepared.kPub.fill(0);
  };
  const forget = () => {
    const held = early.current;
    early.current = null;
    void held?.then(wipe);
  };
  // Nothing is held once this page is gone.
  useEffect(() => forget, []);

  async function gather(): Promise<Early | null> {
    if (!registry || !examId || !storageUrl || !identity || !downloaded) return null;
    try {
      const own = await listEntryFor(registry, examId, identity.passkeyPublicKey);
      if (!own || own.derivedPublicKey.length === 0) return null;
      const readers = chainReaders(registry, examId);
      const build = await readers.readBuild();
      if (!build) return null;
      const derivedPublicKey = toHex(own.derivedPublicKey);
      const prepared = await prepareUnlock({
        derivedPublicKey,
        keyPubTlock: downloaded.keyPubTlock,
        timelockDecrypt: (ciphertext) => timelockDecrypt(ciphertext),
        fetchFile: storageFetcher(storageUrl, examId),
      });
      return { derivedPublicKey, build, criteria: await readers.readCriteria(), prepared, at: Date.now() };
    } catch {
      // Not an error to show: pressing the button gets everything again and says what went wrong.
      return null;
    }
  }

  async function run() {
    if (!registry || !examId || !storageUrl || !identity) return;
    let current: UnlockStep | null = null;
    setPhase({ name: 'checking' });
    const waiting = early.current;
    early.current = null;
    let ahead = waiting ? await waiting : null;
    if (ahead && Date.now() - ahead.at >= EARLY_TTL_MS) {
      wipe(ahead);
      ahead = null;
    }
    try {
      if (ahead && downloaded) {
        const held = ahead;
        ahead = null;
        const shown = await unlockPaper({
          examId,
          credentialId: fromHex(identity.credentialId),
          derivedPublicKey: held.derivedPublicKey,
          keys: browserKeys(),
          build: held.build,
          criteria: held.criteria,
          paperFile: downloaded.paper,
          keyPubTlock: downloaded.keyPubTlock,
          timelockDecrypt: (ciphertext) => timelockDecrypt(ciphertext),
          fetchFile: storageFetcher(storageUrl, examId),
          prepared: held.prepared,
          onStep: (step) => {
            current = step;
            setPhase(step === 'touch' ? { name: 'touch' } : step === 'decrypt' || step === 'check' ? { name: 'opening' } : { name: 'checking' });
          },
        });
        setPaper(shown);
        setPhase({ name: 'idle' });
        return;
      }
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
    } finally {
      wipe(ahead);
    }
  }

  return {
    prepare: () => {
      if (early.current || paper) return;
      early.current = gather();
    },
    phase,
    paper,
    start: () => {
      void run();
    },
  };
}
