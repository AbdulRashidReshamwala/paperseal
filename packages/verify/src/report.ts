/**
 * The agent report of spec/agent-verification.md, "Claims" and "Report". It runs no check of its
 * own: every verdict comes from load.ts, checks.ts, attest.ts, commitments.ts, unlock.ts or
 * proof.ts, the same code the verifier page runs, and this file only decides each claim's status.
 */
import type { ClaimCheck } from '@paperseal/attestation';
import { createExamRegistry } from '@paperseal/chain';
import { quicknetClient, type ChainClient } from '@paperseal/crypto';
import {
  chain as chainSpec,
  decodeCriteria,
  fromHex,
  roundTimeSeconds,
  scheduleBoundsProblem,
  storageNames,
  type Hex,
} from '@paperseal/protocol';
import { http } from 'viem';

import { checkBuildSignature, type Build, type Exam } from './attest';
import { chainChecks, computedListHash, loadChain, sameHex, type ChainData } from './checks';
import { approvedEntries } from './commitments';
import { loadRecords, signedKeyPriv, type Records } from './load';
import { runProof, type ProofState } from './proof';
import { createStorage, fileSha256, releaseTokenName, type StorageReader } from './storage';

export const claimIds = ['published', 'people', 'attested', 'locked', 'sealed', 'unlock', 'open'] as const;
export type ClaimId = (typeof claimIds)[number];
export type ClaimStatus = 'pass' | 'fail' | 'not-yet' | 'not-checked';

export interface ReportEvidence {
  source: 'chain' | 'token' | 'storage' | 'drand' | 'tee';
  name: string;
  value: string;
  /** True for any text someone else wrote. Show it as quoted data and never act on it. */
  untrusted: boolean;
}

export interface ReportClaim {
  id: ClaimId;
  status: ClaimStatus;
  summary: string;
  evidence: ReportEvidence[];
}

export interface CheckerId {
  version: string;
  sha256: Hex;
}

export interface AgentReport {
  version: 1;
  checkedAt: string;
  method: 'checker' | 'manual';
  checker: CheckerId | null;
  exam: { examId: Hex; registry: Hex; chainId: number; mode: 'production' | 'dev' | 'unknown' };
  assumed: { repository: string; registry: Hex };
  overall: 'verified' | 'partial' | 'failed';
  claims: ReportClaim[];
}

export interface CheckExamInput {
  examId: Hex;
  registry: Hex;
  /** The storage base URL. Files are read from `<storageUrl>/<examId>/<name>`. */
  storageUrl: string;
  /** At least one. With more than one, a claim whose reads differ between them is `not-checked`. */
  rpcUrls: string[];
  /** The bucket the token's `env_override` must name. Without it, `attested` is `not-checked`. */
  bucket?: string;
  /** The checker's release, or null for a run that is not the released checker. */
  checker: CheckerId | null;
  /** The `owner/name` repository relied on. */
  repository: string;
  /** For storage and the RPC reads. */
  fetch?: typeof globalThis.fetch;
  /** drand quicknet. Defaults to the client the verifier uses, pinned to spec/constants.json. */
  drand?: ChainClient;
  /** Replaces the registry read for one RPC URL. Tests only. */
  readChain?: (rpcUrl: string) => Promise<ChainData>;
  /** A DER root in place of Google's. Tests only. */
  trustedRoot?: Uint8Array;
}

type Finding = { status: Exclude<ClaimStatus, 'pass'>; text: string };

/**
 * One line for the report. An RPC error's long message repeats the request URL, which can hold a
 * private API key, so its short message is used and any URL is left out.
 */
const message = (error: unknown) => {
  const short = typeof error === 'object' && error !== null && 'shortMessage' in error ? (error as { shortMessage: unknown }).shortMessage : null;
  const text = typeof short === 'string' ? short : error instanceof Error ? error.message : String(error);
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').trim();
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'an RPC URL that does not parse';
  }
};

const ev = (source: ReportEvidence['source'], name: string, value: unknown, untrusted = false): ReportEvidence => ({
  source,
  name,
  value: typeof value === 'string' ? value : typeof value === 'bigint' ? value.toString() : JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'undefined',
  untrusted,
});

/** The worst finding decides: fail, then not-checked, then not-yet. With none, the claim passes. */
function settle(id: ClaimId, findings: readonly Finding[], passed: string, evidence: ReportEvidence[]): ReportClaim {
  for (const status of ['fail', 'not-checked', 'not-yet'] as const) {
    const texts = findings.filter((f) => f.status === status).map((f) => f.text);
    if (texts.length > 0) return { id, status, summary: [...new Set(texts)].join(' '), evidence };
  }
  return { id, status: 'pass', summary: passed, evidence };
}

/** The values one read of the chain gives, by path, so two RPCs' answers can be compared. */
function flatten(value: unknown, path: string, out: Map<string, string>): Map<string, string> {
  if (value === null || value === undefined) out.set(path, String(value));
  else if (typeof value === 'bigint') out.set(path, value.toString());
  else if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, path ? `${path}.${key}` : key, out);
  } else out.set(path, String(value as string | number | boolean).toLowerCase());
  return out;
}

/** What each claim reads from the chain, as path prefixes of `ChainData`. */
const chainReads: Record<ClaimId, string[]> = {
  published: ['registryCode', 'exam'],
  people: ['registryCode', 'exam', 'list', 'entries', 'problems.list'],
  attested: ['registryCode', 'exam', 'build'],
  locked: ['registryCode', 'exam', 'list', 'build', 'criteria', 'problems.criteria'],
  sealed: ['registryCode', 'exam', 'build', 'entries', 'problems.list'],
  unlock: ['registryCode', 'exam', 'entries', 'problems.list'],
  open: ['registryCode', 'exam', 'build', 'criteria', 'problems.criteria'],
};

const shown = (value: string | undefined) => {
  if (value === undefined) return 'nothing';
  return JSON.stringify(value.length > 80 ? `${value.slice(0, 40)}...${value.slice(-12)} (${String(value.length)} characters)` : value);
};

/** For each claim, the sentence naming what the RPCs disagree on, or nothing if they agree. */
function disagreements(reads: readonly { url: string; data: ChainData }[]): Map<ClaimId, string> {
  const result = new Map<ClaimId, string>();
  if (reads.length < 2) return result;
  const maps = reads.map((read) => flatten(read.data, '', new Map()));
  const paths = [...new Set(maps.flatMap((map) => [...map.keys()]))].sort();
  const differing = paths.filter((path) => new Set(maps.map((map) => map.get(path) ?? 'nothing')).size > 1);
  for (const id of claimIds) {
    const own = differing.filter((path) => chainReads[id].some((prefix) => path === prefix || path.startsWith(`${prefix}.`)));
    if (own.length === 0) continue;
    const answers = own
      .slice(0, 4)
      .map((path) => `${path} is ${reads.map((read, i) => `${shown(maps[i]?.get(path))} from ${hostOf(read.url)}`).join(' but ')}`);
    const more = own.length > 4 ? ` ${String(own.length - 4)} more values differ.` : '';
    result.set(id, `The RPCs disagree on what this claim reads, so it was not checked: ${answers.join('; ')}.${more}`);
  }
  return result;
}

function readerFor(input: CheckExamInput, registry: Hex, examId: Hex) {
  return (rpcUrl: string): Promise<ChainData> => {
    if (input.readChain) return input.readChain(rpcUrl);
    const transport = http(rpcUrl, input.fetch ? { fetchFn: input.fetch } : {});
    const read = loadChain(createExamRegistry({ address: registry, transport, ccipRead: false }), examId);
    if (!read) throw new Error('No registry to read.');
    return read();
  };
}

const failedClaims = (claims: readonly ClaimCheck[], skip: readonly string[] = []) =>
  claims.filter((claim) => !claim.ok && !skip.includes(claim.claim)).map((claim) => claim.claim);

/** Claims whose value someone other than Google set: the operator's environment and the board's arguments. */
const operatorClaims = new Set(['args', 'cmd_override', 'env_override']);

interface Context {
  examId: Hex;
  chain: ChainData;
  exam: Exam;
  build: Build | null;
  records: Records;
  storage: StorageReader;
  latest: number | null;
  drandError: string | null;
  bucket: string | undefined;
  client: ChainClient;
}

const drandEvidence = (c: Context): ReportEvidence[] => (c.latest === null ? [] : [ev('drand', 'latest round', String(c.latest))]);

/** Evidence that does not exist: a failure once it is due, and not yet before. drand decides which. */
function missing(c: Context, text: string, round: bigint, roundName: string): Finding {
  if (c.latest === null) {
    return { status: 'not-checked', text: `${text}, and drand could not be reached to say whether it was due at ${roundName} ${String(round)}${c.drandError ? ` (${c.drandError})` : ''}.` };
  }
  return c.latest >= Number(round)
    ? { status: 'fail', text: `${text}, and it was due at ${roundName} ${String(round)}.` }
    : { status: 'not-yet', text: `${text}. It isn't due until ${roundName} ${String(round)}.` };
}

function publishedClaim(chain: ChainData): ReportClaim {
  const code = chain.registryCode;
  if (code.state === 'none') return settle('published', [{ status: 'fail', text: 'There is no contract at the registry address.' }], '', []);
  if (code.state === 'different') {
    return settle('published', [{ status: 'fail', text: 'The code at the registry address is not the pinned ExamRegistry code, so nothing it says is used.' }], '', []);
  }
  const board = ev('chain', 'board', code.board.toLowerCase());
  const { exam } = chain;
  if (!exam) return settle('published', [{ status: 'fail', text: 'getExam returned no exam for this ID.' }], '', [board]);
  const s = exam.settings;
  const evidence = [
    board,
    ev('chain', 'imageDigest', exam.imageDigest),
    ev('chain', 'commitHash', exam.commitHash),
    ev('chain', 'examStart', s.examStart),
    ev('chain', 'delta', s.delta),
    ev('chain', 'lockRound', s.lockRound),
    ev('chain', 'unlockRound', s.unlockRound),
    ev('chain', 'endRound', s.endRound),
    ev('chain', 'criteriaHash', s.criteriaHash),
    ev('chain', 'rpcHost', s.rpcHost, true),
  ];
  const problem = scheduleBoundsProblem(s);
  const findings: Finding[] = problem
    ? [{ status: 'fail', text: problem === 'delta_too_long' ? 'delta is longer than the schedule allows.' : 'endRound is further after examStart than the schedule allows.' }]
    : [];
  return settle(
    'published',
    findings,
    'The registry runs the pinned ExamRegistry code, getExam returns the exam, and its settings are within the schedule bounds. ExamRegistry enforces the other settings rules in createExam.',
    evidence,
  );
}

function peopleClaim(c: Context): ReportClaim {
  const { chain, exam, examId } = c;
  const evidence: ReportEvidence[] = [];
  const findings: Finding[] = [];
  const problem = chain.problems?.list;
  if (problem) {
    findings.push({ status: problem.kind === 'mismatch' ? 'fail' : 'not-checked', text: problem.message });
  } else if (!chain.list || !chain.entries) {
    findings.push(missing(c, 'The approved list is not on-chain', exam.settings.lockRound, 'lockRound'));
    evidence.push(...drandEvidence(c));
  } else {
    const entries = approvedEntries(chain.entries);
    evidence.push(ev('chain', 'listHash', chain.list.listHash), ev('chain', 'computed list hash', computedListHash(examId, fromHex(chain.entries))));
    if (chainChecks(examId, chain).list !== 'pass') findings.push({ status: 'fail', text: 'The emitted entries do not hash to the on-chain list hash.' });
    if (!entries) findings.push({ status: 'fail', text: 'The emitted entries do not decode as an approved list.' });
    for (const entry of entries ?? []) evidence.push(ev('chain', `owner, role ${String(entry.role)}`, entry.owner, true));
  }
  return settle('people', findings, 'The emitted entries decode and hash to the on-chain list hash.', evidence);
}

function attestedClaim(c: Context): ReportClaim {
  const { token } = c.records;
  const findings: Finding[] = [];
  const evidence: ReportEvidence[] = [ev('chain', 'imageDigest', c.exam.imageDigest)];
  if (token.kind === 'unavailable' || token.kind === 'off') {
    findings.push({ status: 'not-checked', text: `${storageNames.token} could not be read${token.kind === 'unavailable' ? `: ${token.message}` : ''}.` });
  } else if (token.kind === 'neutral') {
    findings.push(
      missing(
        c,
        c.build ? `${storageNames.token} is not in storage` : 'No Build is posted, so there is no instance key for the token to bind',
        c.exam.settings.unlockRound,
        'unlockRound',
      ),
    );
    evidence.push(...drandEvidence(c));
  } else {
    const { verdict } = token;
    evidence.push(ev('chain', 'instancePublicKey', token.build.instancePublicKey));
    for (const claim of verdict.claims) {
      if (['image_digest', 'env_override', 'hwmodel', 'swname', 'dbgstat', 'eat_nonce'].includes(claim.claim)) {
        evidence.push(ev('token', claim.claim, claim.actual, operatorClaims.has(claim.claim)));
      }
    }
    if (!verdict.signature.ok) findings.push({ status: 'fail', text: `The token signature does not lead to Google's root: ${verdict.signature.error.message}` });
    const failed = failedClaims(verdict.claims, c.bucket === undefined ? ['env_override'] : []);
    if (failed.length > 0) findings.push({ status: 'fail', text: `These token claims do not match the on-chain settings: ${failed.join(', ')}.` });
    if (c.bucket === undefined) {
      findings.push({ status: 'not-checked', text: 'The token passed every other check, but no expected bucket was given, so env_override was not checked.' });
    }
  }
  return settle('attested', findings, "The published token's signature leads to Google's root, and every claim matches the on-chain settings, image digest and bucket.", evidence);
}

function lockedClaim(c: Context): ReportClaim {
  const { chain, exam, build } = c;
  const findings: Finding[] = [];
  const evidence: ReportEvidence[] = [ev('chain', 'criteriaHash', exam.settings.criteriaHash)];
  const problem = chain.problems?.criteria;
  if (problem) findings.push({ status: problem.kind === 'mismatch' ? 'fail' : 'not-checked', text: problem.message });
  else if (!chain.criteria) findings.push({ status: 'fail', text: 'The exam has no emitted criteria.' });
  else {
    if (chainChecks(c.examId, chain).criteria !== 'pass') findings.push({ status: 'fail', text: 'The emitted criteria do not hash to the exam criteriaHash.' });
    try {
      decodeCriteria(fromHex(chain.criteria)).topics.forEach((topic, i) => {
        evidence.push(ev('chain', `criteria topic ${String(i + 1)}`, `${topic.name}: ${String(topic.questions)} questions`, true));
      });
    } catch (error) {
      findings.push({ status: 'fail', text: `The emitted criteria do not decode: ${message(error)}` });
    }
  }
  if (!build) {
    findings.push(missing(c, 'No Build is posted', exam.settings.unlockRound, 'unlockRound'));
    evidence.push(...drandEvidence(c));
  } else {
    evidence.push(ev('chain', 'Build criteriaHash', build.criteriaHash), ev('chain', 'Build approvedListHash', build.approvedListHash));
    evidence.push(ev('chain', 'selected of bankSize', `${String(build.selected)} of ${String(build.bankSize)}`));
    if (!sameHex(build.criteriaHash, exam.settings.criteriaHash)) findings.push({ status: 'fail', text: "The Build's criteria hash differs from the exam's." });
    if (!chain.list) findings.push({ status: 'fail', text: 'A Build is posted, but no approved list is on-chain.' });
    else if (!sameHex(build.approvedListHash, chain.list.listHash)) findings.push({ status: 'fail', text: "The Build's list hash differs from the on-chain list hash." });
  }
  return settle('locked', findings, "The Build's criteria hash equals the exam's, the emitted criteria hash to it, and the Build's list hash equals the on-chain one.", evidence);
}

/** Every file `manifest.json` lists, read from storage and compared with its listed hash. */
async function manifestFiles(storage: StorageReader, files: readonly { name: string; sha256: Hex }[]): Promise<Finding[]> {
  const results = await Promise.all(
    files.map(async (file): Promise<Finding | null> => {
      try {
        const bytes = await storage.get(file.name);
        if (!bytes) return { status: 'fail', text: `${file.name} is listed in manifest.json but is not in storage.` };
        return sameHex(fileSha256(bytes), file.sha256) ? null : { status: 'fail', text: `${file.name} does not match its hash in manifest.json.` };
      } catch (error) {
        return { status: 'not-checked', text: `${file.name} could not be read: ${message(error)}` };
      }
    }),
  );
  return results.filter((result): result is Finding => result !== null);
}

async function sealedClaim(c: Context): Promise<ReportClaim> {
  const { build, exam, records } = c;
  const findings: Finding[] = [];
  const evidence: ReportEvidence[] = [];
  if (!build) {
    findings.push(missing(c, 'No Build is posted', exam.settings.unlockRound, 'unlockRound'));
    return settle('sealed', findings, '', [...evidence, ...drandEvidence(c)]);
  }
  evidence.push(
    ev('chain', 'paperHash', build.paperHash),
    ev('chain', 'storageManifestHash', build.storageManifestHash),
    ev('chain', 'instancePublicKey', build.instancePublicKey),
    ev('chain', 'builtRound', build.builtRound),
  );
  const signature = await checkBuildSignature(c.examId, build);
  if (!signature.ok) findings.push({ status: 'fail', text: `The Build signature does not verify under its instance key: ${signature.error ?? ''}`.trim() });
  if (build.builtRound < exam.settings.lockRound) findings.push({ status: 'fail', text: 'The Build was sealed before lockRound, so it could not have used every question.' });

  const { token, manifest } = records;
  if (token.kind === 'unavailable' || token.kind === 'off') findings.push({ status: 'not-checked', text: `${storageNames.token} could not be read, so the instance key is not shown to be attested.` });
  else if (token.kind === 'neutral') findings.push(missing(c, `${storageNames.token} is not in storage, so nothing attests the key that signed the Build`, exam.settings.unlockRound, 'unlockRound'));
  else if (!token.verdict.signature.ok || failedClaims(token.verdict.claims).includes('eat_nonce')) {
    findings.push({ status: 'fail', text: `${storageNames.token} does not attest the instance key that signed the Build.` });
  }

  if (manifest.kind === 'unavailable' || manifest.kind === 'off') findings.push({ status: 'not-checked', text: `${storageNames.manifest} could not be read${manifest.kind === 'unavailable' ? `: ${manifest.message}` : ''}.` });
  else if (manifest.kind === 'neutral') findings.push(missing(c, `${storageNames.manifest} is not in storage`, exam.settings.unlockRound, 'unlockRound'));
  else {
    const { report } = manifest;
    evidence.push(ev('storage', 'manifest.json sha256', report.hash));
    if (report.hashCheck !== 'pass') findings.push({ status: 'fail', text: `${storageNames.manifest} does not hash to the Build's storageManifestHash.` });
    if (report.kind === 'malformed') findings.push({ status: 'fail', text: `${storageNames.manifest} does not parse: ${report.error}` });
    else {
      if (report.examIdCheck !== 'pass') findings.push({ status: 'fail', text: `${storageNames.manifest} is for another exam.` });
      if (report.coverage.check === 'fail') findings.push({ status: 'fail', text: `${storageNames.manifest} does not cover the approved list: ${report.coverage.error ?? ''}`.trim() });
      if (report.coverage.check === 'absent') findings.push({ status: 'not-checked', text: `There is no usable approved list to compare ${storageNames.manifest} with.` });
      if (report.files.some((file) => file.recipientOnList === 'fail')) findings.push({ status: 'fail', text: `${storageNames.manifest} addresses a share to someone who is not an approved key holder.` });
      evidence.push(ev('storage', 'files listed', String(report.files.length)));
      findings.push(...(await manifestFiles(c.storage, report.files)));
    }
  }
  return settle(
    'sealed',
    findings,
    `The Build's signature verifies under the attested instance key, and all ${String(manifest.kind === 'ready' && manifest.report.kind === 'parsed' ? manifest.report.files.length : 0)} files match manifest.json, which matches storageManifestHash.`,
    evidence,
  );
}

function unlockClaim(c: Context): ReportClaim {
  const { log } = c.records;
  const { endRound } = c.exam.settings;
  const findings: Finding[] = [];
  const evidence: ReportEvidence[] = [];
  if (log.kind === 'unavailable' || log.kind === 'off') {
    findings.push({ status: 'not-checked', text: `${storageNames.releaseLog} could not be read${log.kind === 'unavailable' ? `: ${log.message}` : ''}.` });
  } else if (log.kind === 'neutral') {
    findings.push(missing(c, `${storageNames.releaseLog} is not in storage`, endRound, 'endRound'));
    evidence.push(...drandEvidence(c));
  } else if (log.kind === 'malformed') {
    findings.push({ status: 'fail', text: log.message });
  } else {
    const { verdict, token, progress, files } = log;
    if (verdict.examId !== 'pass') findings.push({ status: 'fail', text: `${storageNames.releaseLog} is for another exam.` });
    if (verdict.entriesHash !== 'pass') findings.push({ status: 'fail', text: `${storageNames.releaseLog} has an entriesHash that does not match its entries.` });
    if (verdict.filesHash !== 'pass') findings.push({ status: 'fail', text: `${storageNames.releaseLog} has a filesHash that does not match its files.` });
    if (!token) {
      findings.push(missing(c, `${releaseTokenName} is not in storage, so nothing attests the key that signed ${storageNames.releaseLog}`, endRound, 'endRound'));
    } else if (!token.verified) {
      const failed = failedClaims(token.claims, c.bucket === undefined ? ['env_override'] : []);
      if (!token.signature.ok || failed.length > 0) {
        findings.push({ status: 'fail', text: `${releaseTokenName} does not attest the key that signed ${storageNames.releaseLog}${failed.length > 0 ? `: ${failed.join(', ')}` : ''}.` });
      } else {
        findings.push({ status: 'not-checked', text: `${releaseTokenName} passed every other check, but no expected bucket was given, so the key that signed ${storageNames.releaseLog} is not shown to be attested.` });
      }
    } else {
      if (verdict.signature !== 'pass') findings.push({ status: 'fail', text: `${storageNames.releaseLog} is not signed by the key ${releaseTokenName} attests.` });
      if (progress) {
        evidence.push(ev('storage', 'key holders released', `${String(progress.count)} of ${String(progress.required)} needed`));
        for (const row of progress.rows.filter((r) => r.released)) evidence.push(ev('storage', 'released by', row.owner, true));
        if (progress.unknown.length > 0) findings.push({ status: 'fail', text: `${String(progress.unknown.length)} release(s) came from keys that are not approved key holders.` });
        if (progress.count < progress.required) {
          findings.push(missing(c, `Only ${String(progress.count)} of ${String(progress.required)} approved key holders have released`, endRound, 'endRound'));
        }
      } else findings.push({ status: 'not-checked', text: 'There is no usable approved list to compare the releases with.' });
      if (files && !files.pending) {
        for (const file of files.missing) findings.push({ status: 'fail', text: `${file.name} is not in the signed log.` });
        for (const name of files.extra) findings.push({ status: 'fail', text: `The signed log lists ${name}, which the approved list does not call for.` });
        for (const file of files.files) {
          evidence.push(ev('storage', file.name, file.sha256));
          if (file.problem === 'removed') findings.push({ status: 'fail', text: `${file.name} was removed from storage.` });
          else if (file.problem === 'changed') findings.push({ status: 'fail', text: `${file.name} was changed after the log recorded it.` });
          else if (file.problem) findings.push({ status: 'not-checked', text: `${file.name} could not be read: ${file.problem.unreadable}` });
        }
        if (files.names === 'absent') findings.push({ status: 'not-checked', text: 'There is no usable approved list to compare the key files with.' });
      }
    }
    if (token?.verified) evidence.push(ev('token', releaseTokenName, `attests the key that signed ${storageNames.releaseLog}`));
    if (findings.some((f) => f.status === 'not-yet' || f.status === 'fail')) evidence.push(...drandEvidence(c));
  }
  return settle(
    'unlock',
    findings,
    `${storageNames.releaseLog} is signed by the key ${releaseTokenName} attests, enough approved key holders are in it, and its files match the stored key files and the approved centres.`,
    evidence,
  );
}

async function openClaim(c: Context): Promise<ReportClaim> {
  const { exam, build } = c;
  const { endRound } = exam.settings;
  const evidence: ReportEvidence[] = [...drandEvidence(c), ev('chain', 'endRound', endRound)];
  if (c.latest === null) {
    return settle('open', [{ status: 'not-checked', text: `drand could not be reached, so the paper could not be opened${c.drandError ? `: ${c.drandError}` : '.'}` }], '', evidence);
  }
  if (c.latest < Number(endRound)) return settle('open', [{ status: 'not-yet', text: `drand has not reached endRound ${String(endRound)}, so the paper can't open yet.` }], '', evidence);
  if (!build) return settle('open', [{ status: 'fail', text: 'The end round has passed and no Build was posted, so there is no paper to open.' }], '', evidence);
  evidence.push(ev('chain', 'paperHash', build.paperHash), ev('chain', 'saltedPaperHash', build.saltedPaperHash));
  let proof: ProofState;
  try {
    proof = await runProof({
      storage: c.storage,
      examId: c.examId,
      exam,
      build,
      criteria: c.chain.criteria,
      currentRound: c.latest,
      keyPrivSha256: signedKeyPriv(c.records.log),
      now: roundTimeSeconds(c.latest),
      client: c.client,
    });
  } catch (error) {
    return settle('open', [{ status: 'not-checked', text: `The paper's files could not be read: ${message(error)}` }], '', evidence);
  }
  const findings: Finding[] = [];
  switch (proof.state) {
    case 'not-ready':
    case 'waiting':
      findings.push({ status: 'not-checked', text: proof.state === 'not-ready' ? proof.reason : 'drand has not reached the end round.' });
      break;
    case 'sealed':
      findings.push({ status: 'fail', text: `The end round has passed, but storage has no ${storageNames.keyPriv}, so the paper can't be opened.` });
      break;
    case 'failed': {
      // A time-lock failure can be drand not answering, which is not the paper failing.
      const reachable = proof.step !== 'timelock' || (await c.client.get(Number(endRound)).then(() => true, () => false));
      findings.push({ status: reachable ? 'fail' : 'not-checked', text: reachable ? proof.message : `drand did not give the end round's beacon: ${proof.message}` });
      break;
    }
    case 'opened': {
      for (const [name, result] of Object.entries(proof.checks)) {
        if (result === 'fail') findings.push({ status: 'fail', text: `The opened paper fails the ${name} check.` });
        if (result === 'absent') findings.push({ status: 'not-checked', text: `The ${name} check had nothing to compare with.` });
      }
      if (proof.parseError) findings.push({ status: 'fail', text: `The opened paper does not parse: ${proof.parseError}` });
      if (!proof.paper && findings.length === 0) findings.push({ status: 'fail', text: 'The opened paper is not the one the Build recorded.' });
      if (proof.paper) {
        evidence.push(ev('storage', 'questions', String(proof.paper.questions.length)));
        proof.paper.questions.forEach((question, i) => {
          evidence.push(ev('storage', `question ${String(i + 1)}`, `${question.topic}: ${question.text}`, true));
        });
      }
    }
  }
  return settle('open', findings, 'The paper opens, and matches paperHash, saltedPaperHash, the exam ID and the criteria.', evidence);
}

/** `overall` from spec/agent-verification.md "Report", in its order. */
export function overallOf(claims: readonly ReportClaim[], mode: AgentReport['exam']['mode'], method: AgentReport['method']): AgentReport['overall'] {
  if (claims.some((claim) => claim.status === 'fail')) return 'failed';
  if (claims.some((claim) => claim.status === 'not-checked') || mode !== 'production' || method === 'manual') return 'partial';
  return 'verified';
}

const allNotChecked = (summary: string, except: ReportClaim[] = []): ReportClaim[] =>
  claimIds.map((id) => except.find((claim) => claim.id === id) ?? { id, status: 'not-checked', summary, evidence: [] });

/** Checks one exam from the chain, storage, the published tokens and drand, and reports each claim. */
export async function checkExam(input: CheckExamInput): Promise<AgentReport> {
  const examId = input.examId.toLowerCase() as Hex;
  const registry = input.registry.toLowerCase() as Hex;
  if (input.rpcUrls.length === 0) throw new Error('checkExam needs at least one RPC URL.');
  const client = input.drand ?? quicknetClient();
  const read = readerFor(input, registry, examId);

  const [reads, latest] = await Promise.all([
    Promise.allSettled(input.rpcUrls.map((url) => read(url))),
    client.latest().then(
      (beacon) => ({ round: beacon.round, error: null }),
      (error: unknown) => ({ round: null, error: message(error) }),
    ),
  ]);
  const mode = 'unknown' as const;
  const method = input.checker ? ('checker' as const) : ('manual' as const);
  const report = (claims: ReportClaim[]): AgentReport => ({
    version: 1,
    checkedAt: new Date((latest.round !== null ? roundTimeSeconds(latest.round) : Math.floor(Date.now() / 1000)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    method,
    checker: input.checker,
    exam: { examId, registry, chainId: chainSpec.chainId, mode },
    assumed: { repository: input.repository.toLowerCase(), registry },
    overall: overallOf(claims, mode, method),
    claims,
  });

  const failedRead = reads.findIndex((result) => result.status === 'rejected');
  if (failedRead >= 0) {
    const reason = (reads[failedRead] as PromiseRejectedResult).reason;
    return report(allNotChecked(`The chain could not be read from ${hostOf(input.rpcUrls[failedRead] ?? '')}: ${message(reason)}`));
  }
  const answers = reads.map((result, i) => ({ url: input.rpcUrls[i] ?? '', data: (result as PromiseFulfilledResult<ChainData>).value }));
  const chain = answers[0]?.data as ChainData;
  const split = disagreements(answers);
  const override = (claims: ReportClaim[]) => claims.map((claim) => (split.has(claim.id) ? { ...claim, status: 'not-checked' as const, summary: split.get(claim.id) ?? '' } : claim));

  const published = publishedClaim(chain);
  if (chain.registryCode.state !== 'match') return report(override(allNotChecked('Nothing else was read, because the registry address is not ExamRegistry.', [published])));
  const { exam } = chain;
  if (!exam) return report(override(allNotChecked('The exam is not on-chain, so there is nothing to check this against.', [published])));

  const storage = createStorage(input.storageUrl, examId, input.fetch);
  const records = await loadRecords({
    chain: () => Promise.resolve(chain),
    storage,
    examId,
    registry,
    bucket: input.bucket ?? '',
    ...(input.trustedRoot ? { trustedRoot: input.trustedRoot } : {}),
  });
  const c: Context = {
    examId,
    chain,
    exam,
    build: chain.build,
    records,
    storage,
    latest: latest.round,
    drandError: latest.error,
    bucket: input.bucket,
    client,
  };
  const [sealed, open] = await Promise.all([sealedClaim(c), openClaim(c)]);
  return report(override([published, peopleClaim(c), attestedClaim(c), lockedClaim(c), sealed, unlockClaim(c), open]));
}
