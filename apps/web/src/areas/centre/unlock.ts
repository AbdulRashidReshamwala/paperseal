import { openPaperFile, xorCombine } from '@paperseal/crypto';
import type { Keys } from '@paperseal/keys';
import {
  equalBytes,
  fromHex,
  parsePaper,
  saltedPaperHash,
  storageNames,
  type Criteria,
  type Hex,
  type Paper,
} from '@paperseal/protocol';
import type { ReleaseLogResponse } from '@paperseal/tee-client';

import { sha256, type FetchFile } from '../../shared/storage';

export const unlockSteps = ['timelock', 'keyPriv', 'touch', 'decrypt', 'check'] as const;
export type UnlockStep = (typeof unlockSteps)[number];

export const unlockStepLabels: Record<UnlockStep, string> = {
  timelock: 'Open the time seal with drand',
  keyPriv: 'Download your encrypted K_priv',
  touch: 'Touch your security key to open K_priv',
  decrypt: 'Combine the two halves and decrypt the paper',
  check: 'Check the paper against the Build',
};

export class UnlockError extends Error {
  readonly step: UnlockStep;

  constructor(step: UnlockStep, message: string) {
    super(message);
    this.name = 'UnlockError';
    this.step = step;
  }
}

/** The paper decrypted, but it is not the one the Build committed to. It must not be shown. */
export class PaperHashMismatchError extends UnlockError {
  constructor() {
    super('check', 'The paper does not match the salted paper hash in the Build, so it is not shown.');
    this.name = 'PaperHashMismatchError';
  }
}

/** The centre's sealed key is not the file the signed release log lists. It must not reach the security key. */
export class KeyFileChangedError extends UnlockError {
  constructor(reason: string) {
    super('keyPriv', `Your encrypted K_priv was changed after the TEE wrote it: ${reason} Your security key was not used.`);
    this.name = 'KeyFileChangedError';
  }
}

export interface UnlockContext {
  examId: Hex;
  credentialId: Uint8Array;
  /** The centre's own derived public key, which names its `key-priv/<derivedPublicKey>.bin`. */
  derivedPublicKey: Hex;
  keys: Pick<Keys, 'openKeyPriv'>;
  /** From the posted Build. */
  build: { saltedPaperHash: Hex };
  /** The criteria from ExamRegistry. With them, `parsePaper` also checks topics and counts. */
  criteria: Pick<Criteria, 'topics'> | null;
  /** `paper.bin`, already checked against the manifest and the Build. */
  paperFile: Uint8Array;
  /** `key-pub.tlock`, already checked against the manifest. */
  keyPubTlock: string;
  /** Opens a tlock ciphertext from drand. Fails until the unlock round is published. */
  timelockDecrypt: (ciphertext: string) => Promise<Uint8Array>;
  fetchFile: FetchFile;
  /**
   * The release log, only if it has verified. Without one the unlock goes on, because the paper's
   * own hash check still stops a false paper. This log only gives a clearer, earlier refusal.
   */
  verifiedLog?: Pick<ReleaseLogResponse, 'files'> | null;
  /** The time seal and the centre's sealed key, got ahead of the press. Used up, and wiped, by `unlockPaper`. */
  prepared?: PreparedUnlock;
  onStep?: (step: UnlockStep) => void;
}

/** What can be got before the security key is touched. The half-key `kPub` is wiped by whoever ends up holding it. */
export interface PreparedUnlock {
  kPub: Uint8Array;
  sealedKeyPriv: Uint8Array;
  /** When it was got, in milliseconds. */
  preparedAt: number;
}

/** Opens the time seal and downloads this centre's sealed key. Neither needs the security key. */
export async function prepareUnlock(
  context: Pick<UnlockContext, 'keyPubTlock' | 'timelockDecrypt' | 'fetchFile' | 'derivedPublicKey' | 'onStep'>,
): Promise<PreparedUnlock> {
  const step = (name: UnlockStep) => context.onStep?.(name);
  step('timelock');
  let kPub: Uint8Array;
  try {
    kPub = await context.timelockDecrypt(context.keyPubTlock);
  } catch (error) {
    throw new UnlockError('timelock', `The time seal has not opened: ${(error as Error).message}`);
  }
  step('keyPriv');
  try {
    const sealedKeyPriv = await context.fetchFile(storageNames.centreKeyPriv(fromHex(context.derivedPublicKey)));
    return { kPub, sealedKeyPriv, preparedAt: Date.now() };
  } catch (error) {
    kPub.fill(0);
    throw new UnlockError('keyPriv', `Your encrypted K_priv is not available: ${(error as Error).message}`);
  }
}

/** Stops if a verified log disagrees with this centre's sealed key. A log with no files predates the threshold, so it says nothing. */
async function checkKeyPrivAgainstLog(
  log: Pick<ReleaseLogResponse, 'files'>,
  derivedPublicKey: Hex,
  sealedKeyPriv: Uint8Array,
): Promise<void> {
  if (log.files.length === 0) return;
  const name = storageNames.centreKeyPriv(fromHex(derivedPublicKey));
  const listed = log.files.find((file) => file.name === name);
  if (!listed) throw new KeyFileChangedError('the signed release log does not list it.');
  if (!equalBytes(await sha256(sealedKeyPriv), fromHex(listed.sha256))) {
    throw new KeyFileChangedError('it does not match the signed release log.');
  }
}

/**
 * The README's Decrypt step, for centres only. K_pub comes from drand and K_priv from this
 * centre's own HPKE copy, opened with the derived key. K = K_pub XOR K_priv opens the paper file,
 * then the paper is parsed and `saltedPaperHash(seed, paper)` is recomputed. If that differs from
 * the Build, nothing is returned. Every key is wiped after use.
 */
export async function unlockPaper(context: UnlockContext): Promise<Paper> {
  const { examId, keys } = context;
  const step = (name: UnlockStep) => context.onStep?.(name);
  const id = fromHex(examId);

  const prepared = context.prepared ?? (await prepareUnlock(context));
  const { kPub, sealedKeyPriv } = prepared;

  try {
    if (context.verifiedLog) await checkKeyPrivAgainstLog(context.verifiedLog, context.derivedPublicKey, sealedKeyPriv);
    step('touch');
    const kPriv = await keys.openKeyPriv(context.credentialId, id, sealedKeyPriv);
    try {
      step('decrypt');
      const key = xorCombine(kPub, kPriv);
      let opened: { seed: Uint8Array; paper: Uint8Array };
      try {
        opened = await openPaperFile(key, id, context.paperFile);
      } catch (error) {
        throw new UnlockError('decrypt', `The paper could not be decrypted: ${(error as Error).message}`);
      } finally {
        key.fill(0);
      }
      try {
        step('check');
        if (!equalBytes(saltedPaperHash(opened.seed, opened.paper), fromHex(context.build.saltedPaperHash))) {
          throw new PaperHashMismatchError();
        }
        let paper: Paper;
        try {
          paper = parsePaper(opened.paper, context.criteria ?? undefined);
        } catch (error) {
          throw new UnlockError('check', `The paper is malformed: ${(error as Error).message}`);
        }
        if (paper.examId !== examId.toLowerCase()) {
          throw new UnlockError('check', 'The paper is for a different exam.');
        }
        return paper;
      } finally {
        opened.seed.fill(0);
      }
    } finally {
      kPriv.fill(0);
    }
  } finally {
    kPub.fill(0);
  }
}
