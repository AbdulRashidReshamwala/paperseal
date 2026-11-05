import { openPaperFile, quicknetClient, timelockDecrypt, verifyTeeSignature, xorCombine } from '@paperseal/crypto';
import {
  decodeApprovedList,
  encodeMessage,
  entriesHash,
  equalBytes,
  fromHex,
  parsePaper,
  releaseEntryFromWire,
  roles,
  roundTimeSeconds,
  saltedPaperHash,
  selectedCount,
  setterOwner,
  storageNames,
  threshold,
  toHex,
  type Criteria,
  type Hex,
  type Manifest,
  type Paper,
} from '@paperseal/protocol';
import type { ReleaseLogResponse } from '@paperseal/tee-client';

import { connectChain } from './chainio';
import { loadState } from './state';
import { fetchListedFile, fetchManifest, NotFoundError, sha256, storageFetcher, type VerifiedManifest } from './storage';
import { chainSettings, checkPublishedToken } from './tee';
import { errorText, poll, retryTransient, sleep } from './util';

/*
 * `proof`: the public proof for the exam in the state file, from public data alone: the chain,
 * storage and drand. No browser, no passkey and no TEE call. It needs no result from `run`, so it
 * also works for a run that stopped early, and it writes nothing: the run's state and report stay.
 * The h-proof step of `run` uses the same functions.
 */

/** Waits for a drand round. A future round answers 425, and a gateway can answer 404 or 5xx. */
export async function waitForRound(round: number, options: { timeoutMs: number; onWait?: (note: string) => void }): Promise<number> {
  const client = quicknetClient();
  return poll(
    `drand to publish round ${String(round)}`,
    async () => {
      try {
        return (await client.get(round)).round;
      } catch (error) {
        if (/ - got (404|425|5\d\d)$/.test(errorText(error))) return null;
        throw error;
      }
    },
    { ...options, intervalMs: 3_000 },
  );
}

export interface OpenInput {
  examId: Hex;
  saltedPaperHash: Hex;
  criteria: Pick<Criteria, 'topics'>;
  keyPubTlock: string;
  kPriv: Uint8Array;
  paperFile: Uint8Array;
}

/** K_pub from drand, XOR K_priv, then open the paper. Nothing counts until the salted hash equals the Build's. */
export async function openPaper(input: OpenInput): Promise<{ paperBytes: Uint8Array; paper: Paper }> {
  const kPub = await retryTransient(() => timelockDecrypt(input.keyPubTlock));
  const key = xorCombine(kPub, input.kPriv);
  try {
    const opened = await openPaperFile(key, fromHex(input.examId), input.paperFile);
    if (!equalBytes(saltedPaperHash(opened.seed, opened.paper), fromHex(input.saltedPaperHash))) {
      throw new Error('the paper does not match the salted paper hash in the Build');
    }
    const paper = parsePaper(opened.paper, input.criteria);
    if (paper.examId !== input.examId.toLowerCase()) throw new Error('the paper is for a different exam');
    return { paperBytes: opened.paper, paper };
  } finally {
    key.fill(0);
    kPub.fill(0);
  }
}

/** The log's own checks: its exam, entriesHash, and the signature under the instance key it names. */
export async function verifySignedLog(log: ReleaseLogResponse, examId: Hex): Promise<void> {
  if (log.examId.toLowerCase() !== examId.toLowerCase()) throw new Error('the log names a different exam');
  const entries = log.entries.map(releaseEntryFromWire);
  if (!equalBytes(entriesHash(entries), fromHex(log.entriesHash))) throw new Error('entriesHash is not the hash of the entries');
  const signed = await verifyTeeSignature(
    fromHex(log.instancePublicKey),
    fromHex(log.teeSignature),
    encodeMessage('releaseLog', { examId: fromHex(log.examId), entriesHash: fromHex(log.entriesHash) }),
  );
  if (!signed) throw new Error('the log signature does not verify under its instance key');
}

/** Exactly the threshold of different holders on the on-chain list, each with its manifest share hash, none before unlock. */
export function checkLogHolders(log: ReleaseLogResponse, listEntries: Hex, manifest: Manifest, unlockRound: string): void {
  if (log.entries.length !== threshold.required) throw new Error(`the log has ${String(log.entries.length)} entries, not ${String(threshold.required)}`);
  const list = decodeApprovedList(fromHex(listEntries));
  const seen = new Set<string>();
  for (const entry of log.entries) {
    if (seen.has(entry.passkeyPublicKey)) throw new Error(`${entry.passkeyPublicKey} is logged twice`);
    seen.add(entry.passkeyPublicKey);
    const holder = list.find((e) => toHex(e.passkeyPublicKey) === entry.passkeyPublicKey);
    if (!holder || (holder.role !== roles.neutral && holder.role !== roles.centreKeyHolder)) throw new Error(`${entry.passkeyPublicKey} is not a key holder on the approved list`);
    const file = manifest.files.find((f) => f.name === storageNames.share(holder.derivedPublicKey));
    if (file?.shareHash !== entry.shareHash) throw new Error(`the logged share hash for ${holder.owner} differs from the manifest`);
    if (BigInt(entry.round) < BigInt(unlockRound)) throw new Error(`the log has round ${entry.round} before the unlock round`);
  }
}

/** No names are published: the list shows only the hash of each setter's passkey, and anyone recomputes it. */
export function checkSetterOwners(listEntries: Hex): number {
  const setters = decodeApprovedList(fromHex(listEntries)).filter((e) => e.role === roles.setter);
  const bad = setters.filter((e) => e.owner !== setterOwner(e.passkeyPublicKey));
  if (bad.length > 0) throw new Error(`${String(bad.length)} setter owner(s) are not the setterOwner hash of their passkey`);
  return setters.length;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

let failures = 0;
async function check(label: string, run: () => Promise<string> | string): Promise<boolean> {
  try {
    console.log(`PASS  ${label}: ${await run()}`);
    return true;
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label}: ${errorText(error)}`);
    return false;
  }
}

export async function proof(): Promise<void> {
  const { exam, run } = loadState();
  if (!exam) throw new Error('no published exam in e2e/.live/state.json: run `publish` first');
  const { examId } = exam;
  const io = connectChain();
  const env = { io, examId };
  const fetchFile = storageFetcher(examId);
  console.log(`Public proof for "${exam.name}"\nexamId ${examId}\n`);

  const proofChecks = async (): Promise<void> => {
    let bound: Awaited<ReturnType<typeof chainSettings>> | undefined;
    const loaded = await check('the exam is on-chain with the rounds in the state file, and its criteria match the criteria hash', async () => {
      bound = await chainSettings(env);
      const { lockRound, unlockRound, endRound } = bound.settings;
      const want = exam.schedule;
      if (lockRound !== want.lockRound || unlockRound !== want.unlockRound || endRound !== want.endRound) throw new Error('the on-chain rounds differ from the state file');
      return `unlock round ${unlockRound}, end round ${endRound}`;
    });
    if (!loaded || !bound) return;
    const { settings, criteria } = bound;

    const endRound = Number(settings.endRound);
    const dueInMs = roundTimeSeconds(endRound) * 1000 - Date.now();
    if (dueInMs > 0) {
      console.log(`....  the paper opens at the end round, ${String(Math.ceil(dueInMs / 1000))}s from now`);
      await sleep(dueInMs);
    }
    if (!(await check('the end round is published by drand', async () => `round ${String(await waitForRound(endRound, { timeoutMs: 10 * 60_000 }))}`))) return;

    const build = await io.read(() => io.registry.getBuild(examId));
    if (!(await check('the Build is on-chain and names the exam criteria', () => {
      if (!build) throw new Error('no Build is posted for this exam');
      if (build.criteriaHash !== settings.criteriaHash) throw new Error(`Build criteria hash ${build.criteriaHash} differs from ${settings.criteriaHash}`);
      return `selected ${String(build.selected)} of ${String(build.bankSize)}, instance key ${build.instancePublicKey}`;
    })) || !build) return;

    let manifest: VerifiedManifest | undefined;
    let paperFile: Uint8Array = new Uint8Array();
    let keyPubTlock = '';
    if (!(await check('manifest.json, paper.bin and key-pub.tlock match the Build through their hashes', async () => {
      manifest = await fetchManifest(fetchFile, build, examId);
      paperFile = await fetchListedFile(fetchFile, manifest, build, storageNames.paper);
      keyPubTlock = text(await fetchListedFile(fetchFile, manifest, build, storageNames.keyPub));
      return `${String(manifest.manifest.files.length)} files, paper.bin ${String(paperFile.length)} bytes`;
    })) || !manifest) return;
    const listed = manifest.manifest;

    let opened: Awaited<ReturnType<typeof openPaper>> | undefined;
    await check('key-pub.tlock and key-priv.tlock open with drand alone, the paper opens, parses against the criteria, and its salted hash equals the Build', async () => {
      const keyPrivFile = await fetchFile(storageNames.keyPriv).catch((error: unknown) => {
        throw error instanceof NotFoundError ? new Error('storage has no key-priv.tlock, so the unlock never happened and the paper stays sealed') : error;
      });
      const kPriv = await retryTransient(() => timelockDecrypt(text(keyPrivFile)));
      try {
        opened = await openPaper({ examId, saltedPaperHash: build.saltedPaperHash, criteria, keyPubTlock, kPriv, paperFile });
      } finally {
        kPriv.fill(0);
      }
      return `salted paper hash ${build.saltedPaperHash}, paper sha256 ${toHex(await sha256(opened.paperBytes))}`;
    });

    await check('selected: the paper has as many questions as the Build says, and as the criteria ask', () => {
      if (!opened) throw new Error('no paper was opened');
      const count = opened.paper.questions.length;
      if (count !== build.selected) throw new Error(`the paper has ${String(count)} questions, the Build says ${String(build.selected)}`);
      if (build.selected !== selectedCount(criteria)) throw new Error(`the Build says ${String(build.selected)}, the criteria ask for ${String(selectedCount(criteria))}`);
      return `${String(count)} questions`;
    });

    await check('bank size: the Build meets the criteria, and equals the receipts this machine holds, if any', () => {
      const least = selectedCount(criteria) * criteria.minBankMultiple;
      if (build.bankSize < least) throw new Error(`bank size ${String(build.bankSize)} is below the ${String(least)} the criteria need`);
      const receipts = run?.receipts.length ?? 0;
      if (receipts > 0 && receipts !== build.bankSize) throw new Error(`bank size ${String(build.bankSize)}, but ${String(receipts)} receipts are in the state file`);
      return `${String(build.bankSize)} questions, at least ${String(least)} needed${receipts > 0 ? `, ${String(receipts)} receipts` : ', no receipts to compare'}`;
    });

    const listEntries = await io.read(() => io.registry.getApprovedListEntries(examId));
    await check('release-log.json is signed, and names the threshold of holders from the on-chain list with their manifest share hashes', async () => {
      if (!listEntries) throw new Error('the approved list is not readable from the chain');
      const log = JSON.parse(text(await fetchFile(storageNames.releaseLog))) as ReleaseLogResponse;
      await verifySignedLog(log, examId);
      checkLogHolders(log, listEntries, listed, settings.unlockRound);
      const released = run?.released ?? [];
      if (released.length > 0 && JSON.stringify(log.entries.map((e) => e.passkeyPublicKey)) !== JSON.stringify(released.map((r) => r.passkeyPublicKey))) {
        throw new Error('the log differs from the releases in the state file');
      }
      const token = text(await fetchFile('release-token.jwt'));
      const tokenFailures = await checkPublishedToken(env, token, log.instancePublicKey);
      if (tokenFailures.length > 0) throw new Error(`release-token.jwt: ${tokenFailures.join('; ')}`);
      return `${String(log.entries.length)} entries, signature, entriesHash, share hashes and release-token.jwt verified, signer ${log.instancePublicKey}`;
    });

    await check('each setter on the on-chain list is only the hash of its own passkey', () => {
      if (!listEntries) throw new Error('the approved list is not readable from the chain');
      return `${String(checkSetterOwners(listEntries))} setters`;
    });

    if (!opened) return;
    console.log(`\nThe paper, ${String(opened.paper.questions.length)} questions:\n`);
    opened.paper.questions.forEach((question, index) => {
      console.log(`${String(index + 1)}. [${question.topic}] ${question.text}`);
    });
    console.log(`\nThe paper as published:\n${text(opened.paperBytes)}`);
  };

  await proofChecks();
  console.log(failures === 0 ? '\nproof: all checks passed, from public data alone.' : `\nproof: ${String(failures)} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}
