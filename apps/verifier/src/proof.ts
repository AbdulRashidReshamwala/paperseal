import { openPaperFile, timelockDecrypt, xorCombine, type ChainClient } from '@paperseal/crypto';
import {
  decodeCriteria,
  encryptedPaperHash,
  fromHex,
  parsePaper,
  roundTimeSeconds,
  saltedPaperHash,
  selectedCount,
  storageNames,
  toHex,
  type Criteria,
  type Hex,
  type Paper,
} from '@paperseal/protocol';

import type { Build, Exam } from './attest';
import { criteriaMatches, sameHex, type CheckResult } from './checks';
import { utf8Text, type StorageReader } from './storage';

export interface ProofChecks {
  /** `paper.bin` is the file the Build's `paperHash` covers. */
  paperFile: CheckResult;
  /** The seed and paper hash to the Build's `saltedPaperHash`. */
  saltedHash: CheckResult;
  /** The paper's own `examId`. */
  examId: CheckResult;
  /** The paper's question count against the Build's `selected`. */
  selectedCount: CheckResult;
  /** The Build's `selected` against the sum of the published criteria's topic counts. */
  criteriaCount: CheckResult;
  /** Each topic holds exactly the questions the criteria ask for. */
  topics: CheckResult;
  /** The criteria bytes on chain against the exam's `criteriaHash`. */
  criteriaHash: CheckResult;
}

export type ProofState =
  /** Something the proof needs is missing: connection settings, the exam or the Build. */
  | { state: 'not-ready'; reason: string }
  /** The end round has not been published. */
  | { state: 'waiting'; endRound: number; opensAt: number }
  /** The end round passed and storage has no `key-priv.tlock`, so no unlock happened. */
  | { state: 'sealed' }
  /** A file is missing, or the paper would not open. */
  | { state: 'failed'; step: 'files' | 'timelock' | 'decrypt'; message: string }
  /** The paper opened. `paper` is set only when its salted hash matched the Build. */
  | { state: 'opened'; checks: ProofChecks; paper: Paper | null; parseError?: string };

export interface ProofInput {
  storage: StorageReader | null;
  examId: Hex | null;
  exam: Exam | null;
  build: Build | null;
  /** `abi.encode(Criteria)` from the chain. */
  criteria: Hex | null;
  /** The latest drand round, or null if drand has not answered. The clock stands in then. */
  currentRound: number | null;
  /** Unix seconds. */
  now: number;
  client: ChainClient;
}

const verdict = (ok: boolean): CheckResult => (ok ? 'pass' : 'fail');

export async function runProof(input: ProofInput): Promise<ProofState> {
  const { storage, examId, exam, build, criteria, client } = input;
  if (!examId || !exam) return { state: 'not-ready', reason: 'The exam is not published on the chain yet.' };

  const endRound = Number(exam.settings.endRound);
  const reached =
    input.currentRound !== null ? input.currentRound >= endRound : input.now >= roundTimeSeconds(endRound);
  if (!reached) return { state: 'waiting', endRound, opensAt: roundTimeSeconds(endRound) };

  if (!storage) return { state: 'not-ready', reason: 'Set the storage URL under Connection.' };
  if (!build) return { state: 'not-ready', reason: 'There is no Build on the chain to compare the paper with.' };

  const keyPrivFile = await storage.get(storageNames.keyPriv);
  if (!keyPrivFile) return { state: 'sealed' };
  const [keyPubFile, paperFile] = await Promise.all([
    storage.get(storageNames.keyPub),
    storage.get(storageNames.paper),
  ]);
  if (!keyPubFile || !paperFile) {
    const missing = [!keyPubFile && storageNames.keyPub, !paperFile && storageNames.paper].filter(Boolean);
    return { state: 'failed', step: 'files', message: `Storage has no ${missing.join(' or ')}.` };
  }

  let key: Uint8Array;
  try {
    const [keyPub, keyPriv] = await Promise.all([
      timelockDecrypt(utf8Text(keyPubFile), client),
      timelockDecrypt(utf8Text(keyPrivFile), client),
    ]);
    key = xorCombine(keyPub, keyPriv);
  } catch (error) {
    return { state: 'failed', step: 'timelock', message: (error as Error).message };
  }

  let opened: { seed: Uint8Array; paper: Uint8Array };
  try {
    opened = await openPaperFile(key, fromHex(examId), paperFile);
  } catch (error) {
    return { state: 'failed', step: 'decrypt', message: (error as Error).message };
  } finally {
    key.fill(0);
  }

  let decoded: Criteria | null = null;
  let criteriaHashCheck: CheckResult = 'absent';
  if (criteria) {
    criteriaHashCheck = verdict(criteriaMatches(fromHex(criteria), exam.settings.criteriaHash));
    try {
      decoded = decodeCriteria(fromHex(criteria));
    } catch {
      criteriaHashCheck = 'fail';
    }
  }

  let paper: Paper | null = null;
  let parseError: string | undefined;
  try {
    paper = parsePaper(opened.paper);
  } catch (error) {
    parseError = (error as Error).message;
  }

  let topics: CheckResult = 'absent';
  if (decoded && paper) {
    try {
      parsePaper(opened.paper, decoded);
      topics = 'pass';
    } catch (error) {
      topics = 'fail';
      parseError ??= (error as Error).message;
    }
  }

  const saltedHash = verdict(sameHex(toHex(saltedPaperHash(opened.seed, opened.paper)), build.saltedPaperHash));
  const checks: ProofChecks = {
    paperFile: verdict(sameHex(toHex(encryptedPaperHash(paperFile)), build.paperHash)),
    saltedHash,
    examId: paper ? verdict(sameHex(paper.examId, examId)) : 'fail',
    selectedCount: paper ? verdict(paper.questions.length === Number(build.selected)) : 'fail',
    criteriaCount: decoded ? verdict(selectedCount(decoded) === Number(build.selected)) : 'absent',
    topics,
    criteriaHash: criteriaHashCheck,
  };
  // The paper stays hidden unless it is the one the Build committed to.
  return {
    state: 'opened',
    checks,
    paper: saltedHash === 'pass' && paper && checks.examId === 'pass' ? paper : null,
    ...(parseError ? { parseError } : {}),
  };
}
