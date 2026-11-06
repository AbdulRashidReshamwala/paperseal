import { sealQuestion, sealRelease, timelockDecrypt, verifyTeeSignature } from '@paperseal/crypto';
import {
  approvedListHash,
  decodeApprovedList,
  encodeApprovedList,
  encodeMessage,
  equalBytes,
  fromHex,
  hashMessage,
  inviteTag as computeInviteTag,
  newInviteSecret,
  questionHash as hashQuestion,
  selectedCount,
  setterOwner,
  storageNames,
  toHex,
  type ApprovedListEntry,
  type Hex,
  type Question,
} from '@paperseal/protocol';
import { isReleaseNotOpen, TeeApiError, type TeeClient } from '@paperseal/tee-client';

import { boardSend, checkDeployment, connectChain } from './chainio';
import { buildArgs, verifyOutboxBuild, type BuildPost } from './build';
import { addParticipant, call, startLab, type Lab, type Participant } from './browser';
import { composeFromInvites, issueInvites, openLink } from './invites';
import { gaps } from './config';
import { checkLogFiles, checkLogHolders, checkSetterOwners, openPaper, verifySignedLog, waitForRound } from './proof';
import { releaseOrder, roster, type Kind } from './roster';
import { liveCriteria, liveQuestion, questionsPerSetterPerTopic } from './schedule';
import {
  Reporter,
  RunStopped,
  loadState,
  saveState,
  updateRun,
  type PublishedExam,
  type RunState,
} from './state';
import { checkCoverage, fetchListedFile, fetchManifest, holdersFromChainList, NotFoundError, sha256, storageFetcher, type FetchFile } from './storage';
import { attest, checkPublishedToken, confirm, connectTee, teeRead, UntrustedTeeError, type Env } from './tee';
import { errorText, poll, retryTransient, short, sleep, stamp } from './util';

/*
 * `run`: one full real exam against the deployed system. Real TEE, real Sepolia, real drand, the
 * real package code, and real Chrome with one virtual authenticator per participant. Nothing is
 * stubbed and no check is skipped: a failed check is recorded as Fail and stops the run.
 *
 * Virtual passkeys live only as long as their browser, so this process must stay up from the first
 * registration to the end proof, and a run cannot be resumed after it dies.
 */

const unixNow = () => Math.floor(Date.now() / 1000);
const iso = (unix: number) => new Date(unix * 1000).toISOString();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sleeps until a Unix time, logging about once a minute. */
async function waitUntil(rep: Reporter, unix: number, what: string): Promise<void> {
  let last = 0;
  while (unixNow() < unix) {
    if (Date.now() - last >= 60_000) {
      last = Date.now();
      rep.note(`waiting for ${what}, ${String(unix - unixNow())}s to go (${iso(unix)})`);
    }
    await sleep(Math.min(5_000, Math.max(250, (unix - unixNow()) * 1000)));
  }
}

function throttled(rep: Reporter): (note: string) => void {
  let last = 0;
  return (note) => {
    if (Date.now() - last >= 60_000) {
      last = Date.now();
      rep.note(note);
    }
  };
}

export async function run(): Promise<void> {
  const state = loadState();
  const exam = state.exam;
  if (!exam) throw new Error('no published exam in e2e/.live/state.json: run `publish` first');
  if (state.run?.status === 'running' && pidAlive(state.run.pid)) throw new Error(`a run is already in progress (pid ${String(state.run.pid)})`);

  const io = connectChain();
  const tee = connectTee();
  const env: Env = { io, examId: exam.examId, tee };
  const rep = new Reporter({ examName: exam.name, examId: exam.examId });
  const fetchFile = storageFetcher(exam.examId);

  const fresh: RunState = {
    pid: process.pid,
    startedAt: stamp(),
    updatedAt: stamp(),
    phase: 'starting',
    status: 'running',
    participants: [],
    receipts: [],
    released: [],
  };
  saveState({ ...state, run: fresh });

  let lab: Awaited<ReturnType<typeof startLab>> | undefined;
  const people: Participant[] = [];
  const shutdown = async () => {
    for (const p of people) await p.context.close().catch(() => undefined);
    await lab?.browser.close().catch(() => undefined);
    await lab?.server.close().catch(() => undefined);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      rep.note(`received ${signal}, closing the browser and stopping`);
      updateRun((r) => {
        r.status = 'interrupted';
        r.finishedAt = stamp();
        r.stopReason = `received ${signal}`;
      });
      void shutdown().finally(() => process.exit(130));
    });
  }

  const phase = (name: string) => updateRun((r) => (r.phase = name));
  let failed = false;
  try {
    const ctx: Ctx = { exam, env, rep, fetchFile, people, io, tee };
    phase('setup');
    lab = await setup(ctx);
    ctx.lab = lab;
    phase('a-attestation');
    await attestation(ctx);
    phase('b-register');
    const posted = await register(ctx);
    phase('c-setters');
    const receipts = await setters(ctx, posted.listHash);
    phase('d-build');
    const build = await buildStep(ctx, posted.listHash, receipts);
    phase('e-download');
    const downloads = await downloadStep(ctx, build);
    phase('f-release');
    await releaseStep(ctx, build);
    phase('g-unlock');
    const paperHash = await unlockStep(ctx, build, downloads);
    phase('h-proof');
    await proofStep(ctx, build, paperHash);
  } catch (error) {
    failed = true;
    const message = error instanceof RunStopped ? error.message : errorText(error);
    if (!(error instanceof RunStopped)) rep.record('run', 'unexpected error', 'Fail', message);
    updateRun((r) => {
      r.status = 'failed';
      r.stopReason = message;
      r.finishedAt = stamp();
    });
    rep.note(`stopped: ${message}`);
  }
  const fails = rep.entries.filter((e) => e.result === 'Fail').length;
  if (!failed) {
    updateRun((r) => {
      r.status = fails === 0 ? 'passed' : 'failed';
      r.phase = 'done';
      r.finishedAt = stamp();
    });
  }
  rep.note(`finished: ${String(rep.entries.length - fails)} Pass, ${String(fails)} Fail. See e2e/.live/report.json`);
  await shutdown();
  process.exitCode = fails === 0 && !failed ? 0 : 1;
}

interface Ctx {
  exam: PublishedExam;
  env: Env;
  rep: Reporter;
  fetchFile: FetchFile;
  people: Participant[];
  io: ReturnType<typeof connectChain>;
  tee: TeeClient;
  /** The browser lab, once `setup` has started it. */
  lab?: Lab;
  /** A registration made under an invited name without that invite's secret. It must never reach the list. */
  intruder?: Hex;
}

const person = (ctx: Ctx, name: string): Participant => {
  const found = ctx.people.find((p) => p.name === name);
  if (!found) throw new Error(`no participant ${name}`);
  return found;
};
const ofKind = (ctx: Ctx, ...kinds: Kind[]) => ctx.people.filter((p) => kinds.includes(p.kind));

/* ------------------------------------------------------------------- Setup */

async function setup(ctx: Ctx) {
  const { rep, exam } = ctx;
  return rep.step('setup', async () => {
    await rep.check('setup', 'Sepolia and ExamRegistry reachable', () => checkDeployment(ctx.io));
    await rep.check('setup', 'the exam in the state file is on-chain with the published settings', async () => {
      const onChain = await ctx.io.read(() => ctx.io.registry.getExam(exam.examId));
      if (!onChain) throw new Error('getExam returns nothing');
      const s = onChain.settings;
      const want = exam.schedule;
      const got = [String(s.examStart), String(s.delta), s.lockRound.toString(), s.unlockRound.toString(), s.endRound.toString(), s.criteriaHash];
      const exp = [String(want.examStart), String(want.delta), want.lockRound, want.unlockRound, want.endRound, exam.criteriaHash];
      if (JSON.stringify(got) !== JSON.stringify(exp)) throw new Error(`chain ${JSON.stringify(got)} differs from state ${JSON.stringify(exp)}`);
      return `${exam.name}, ${exam.examId}`;
    });
    await rep.check('setup', 'enough time is left before Lock to register, post, finalise and submit', () => {
      const left = exam.schedule.lockAtUnix - unixNow();
      if (left < gaps.minLeadBeforeLock) throw new Error(`only ${String(left)}s until Lock at ${iso(exam.schedule.lockAtUnix)}; the TEE sees the list ${gaps.listDelay}. Publish a new exam`);
      return `${String(Math.round(left / 60))} minutes until Lock`;
    });
    const started = await startLab();
    rep.record('setup', 'real Chrome started, with a vite page of the real packages/keys code', 'Pass', started.origin);
    for (const spec of roster) {
      ctx.people.push(await addParticipant(started, spec));
    }
    // A setter has no name on the list: its owner is made from its passkey when it registers.
    for (const p of ctx.people) if (p.kind !== 'setter') p.owner ??= p.name;
    rep.record(
      'setup',
      'one isolated browser context and one virtual authenticator per participant',
      ctx.people.length === roster.length ? 'Pass' : 'Fail',
      `${String(ctx.people.length)} contexts: 2 setters, 3 neutrals, 7 centre key holders, 1 centre without a share`,
    );
    return started;
  });
}

/* ------------------------------------------------------------- a. Attestation */

async function attestation(ctx: Ctx): Promise<void> {
  const { rep, env } = ctx;
  await rep.step('a-attestation', async () => {
    const result = await poll('the TEE to answer GET /v1/attestation', () => attest(env), { timeoutMs: 20 * 60_000, intervalMs: 15_000, onWait: throttled(rep) });
    if (!result.verdict.trusted) {
      // Every failing claim, with its actual value, and then stop. Nothing continues past an untrusted TEE.
      const lines = result.claimLines.length > 0 ? result.claimLines : ['not trusted, but no individual claim failed'];
      console.error(`\nThe TEE is NOT trusted. Failing checks:\n${lines.map((l) => `  - ${l}`).join('\n')}\n`);
      for (const line of lines) rep.record('a-attestation', 'attestation check', 'Fail', line);
      throw new RunStopped('the TEE attestation is not trusted');
    }
    rep.record(
      'a-attestation',
      'checkToken(trusted): Google signature, instance key, and every claim against the on-chain exam',
      'Pass',
      `${String(result.verdict.claims.length)} claims, instance key ${short(result.attestation.instancePublicKey)}`,
    );
  });
}

/* --------------------------------------------------------------- b. Register */

async function register(ctx: Ctx): Promise<{ listHash: Hex; entries: Hex }> {
  const { rep, exam, tee } = ctx;
  return rep.step('b-register', async () => {
    // The board makes one invite per person. Each is a link, and everything in it is in the URL fragment.
    await rep.check('b-register', 'the board creates one invite per participant: a random 32-byte secret each, in a link whose fragment holds the role, owner and secret', () => {
      const issued = issueInvites(exam.examId, roster);
      issued.forEach((invite, i) => {
        (ctx.people[i] as Participant).invite = invite;
      });
      if (new Set(issued.map((i) => i.inviteSecret)).size !== issued.length) throw new Error('two invites share a secret');
      for (const invite of issued) {
        const url = new URL(invite.link);
        if (url.search !== '' || url.pathname !== '/' || !url.hash.includes(invite.inviteSecret)) throw new Error(`${invite.name}: the invite is not held only in the URL fragment`);
        if (invite.role === 'setter' && (url.hash.includes('owner') || url.hash.includes(invite.name))) throw new Error(`${invite.name}: a setter invite carries a name`);
      }
      return `${String(issued.length)} invites, ${String(issued.filter((i) => i.role === 'setter').length)} of them setter invites with no owner`;
    });
    if (ctx.people.some((p) => !p.invite)) throw new RunStopped('the invites could not be made');

    for (const p of ctx.people) {
      await rep.check('b-register', `register ${p.name} (${p.kind}) from its invite link, with the TEE through tee-client`, async () => {
        const invite = p.invite;
        if (!invite) throw new Error('no invite');
        // The registrant's app reads the invite from the link alone, strictly.
        const opened = openLink(invite.link);
        if (opened.role !== invite.role || opened.owner !== invite.owner || opened.inviteSecret !== invite.inviteSecret || opened.examId !== exam.examId) {
          throw new Error(`${p.name}: the link reads back as a different invite`);
        }
        const { challenge } = await teeRead(() => tee.registerChallenge());
        const { credentialId, owner, request } = await call(p, 'register', opened.owner ?? null, opened.role === 'setter' ? 'setter' : 'holder', challenge, opened.inviteSecret);
        p.credentialId = credentialId as Hex;
        p.owner = owner;
        p.passkeyPublicKey = request.passkeyPublicKey;
        if (p.kind === 'setter' && owner !== setterOwner(fromHex(request.passkeyPublicKey))) throw new Error(`${p.name}: the owner is not the setterOwner hash of its passkey`);
        if (p.kind !== 'setter' && owner !== p.name) throw new Error(`${p.name}: registered under ${owner}, not the name in the invite`);
        const expectedTag = toHex(computeInviteTag(fromHex(opened.inviteSecret), fromHex(request.passkeyPublicKey)));
        if (request.inviteTag !== expectedTag) throw new Error(`${p.name}: the request tag is not HMAC-SHA-256(inviteSecret, passkeyPublicKey)`);
        if (JSON.stringify(request).includes(opened.inviteSecret.slice(2))) throw new Error(`${p.name}: the invite secret is in the request`);
        p.inviteTag = request.inviteTag;
        p.derivedPublicKey = request.derivedPublicKey;
        // A POST that changes TEE state is sent once, never retried.
        await tee.register(request);
        return `passkey ${short(request.passkeyPublicKey)}, tag ${short(request.inviteTag)}${request.derivedPublicKey === '0x' ? ', no derived key' : `, derived ${short(request.derivedPublicKey)}`}`;
      });
    }
    updateRun((r) => {
      r.participants = ctx.people.map((p) => ({
        name: p.name,
        kind: p.kind,
        role: p.role,
        owner: p.owner ?? p.name,
        passkeyPublicKey: (p.passkeyPublicKey ?? '0x') as Hex,
        derivedPublicKey: (p.derivedPublicKey ?? '0x') as Hex,
      }));
    });
    if (ctx.people.some((p) => !p.passkeyPublicKey)) throw new RunStopped('a registration failed, so there is no complete list to post');

    // Someone who knows an invited name, but not that invite's secret. This is the problem invites fix.
    const victim = ofKind(ctx, 'neutral')[0] as Participant;
    const asIntruder = async <T>(use: (intruder: Participant) => Promise<T>): Promise<T> => {
      if (!ctx.lab) throw new Error('the browser lab is not running');
      const intruder = await addParticipant(ctx.lab, { name: 'intruder', kind: 'neutral', role: 2 });
      try {
        return await use(intruder);
      } finally {
        await intruder.context.close().catch(() => undefined);
      }
    };
    await rep.check('b-register', `a registration signed with a tag the passkey did not sign is refused by the TEE (a copy of ${victim.name}'s tag)`, async () => {
      await asIntruder(async (intruder) => {
        const { challenge } = await teeRead(() => tee.registerChallenge());
        const { request } = await call(intruder, 'register', victim.owner as string, 'holder', challenge, newInviteSecret());
        try {
          await tee.register({ ...request, inviteTag: victim.inviteTag as Hex });
        } catch (error) {
          if (error instanceof TeeApiError && error.status === 400) return;
          throw error;
        }
        throw new Error('the TEE accepted a registration whose inviteTag differs from the one the passkey signed');
      });
      return 'refused with 400, so a tag cannot be changed in transit';
    });
    await rep.check('b-register', `a registration under the invited name ${String(victim.owner)}, with a secret the board never issued, is accepted by the TEE but is not on the list`, async () => {
      ctx.intruder = await asIntruder(async (intruder) => {
        const { challenge } = await teeRead(() => tee.registerChallenge());
        const { request } = await call(intruder, 'register', victim.owner as string, 'holder', challenge, newInviteSecret());
        await tee.register(request);
        return request.passkeyPublicKey;
      });
      return `registered ${short(ctx.intruder)}; the composed list below must leave it out`;
    });

    let registered: Awaited<ReturnType<typeof tee.registrations>>['registrations'] = [];
    await rep.check('b-register', 'GET /v1/registrations lists every participant, with the same keys, owners and invite tags', async () => {
      registered = (await teeRead(() => tee.registrations())).registrations;
      for (const p of ctx.people) {
        const found = registered.find((r) => r.passkeyPublicKey === p.passkeyPublicKey);
        if (!found) throw new Error(`${p.name} is not in the registrations`);
        if (found.owner !== p.owner) throw new Error(`${p.name}: owner ${found.owner} differs from ${String(p.owner)}`);
        if (found.derivedPublicKey !== p.derivedPublicKey) throw new Error(`${p.name}: derived key differs`);
        if (found.inviteTag !== p.inviteTag) throw new Error(`${p.name}: invite tag ${String(found.inviteTag)} differs from ${String(p.inviteTag)}`);
      }
      const setterRegistrations = registered.filter((r) => r.derivedPublicKey === '0x');
      if (setterRegistrations.some((r) => r.owner !== setterOwner(fromHex(r.passkeyPublicKey)))) throw new Error('a setter is registered under something other than the setterOwner hash of its passkey');
      return `${String(registered.length)} registrations, ${String(ctx.people.length)} of them invited; setters appear only as the hash of their passkey`;
    });

    // Compose the approved list from the invites, exactly as the board app does: recompute each tag
    // from the secret, keep a registration only if its tag and owner match, and refuse a doubled invite.
    let entries: ApprovedListEntry[] = [];
    let encoded: Hex = '0x';
    let listHash: Hex = '0x';
    await rep.check('b-register', 'compose the approved list by matching the registrations to the invites (checkApprovedList, canonical encoding, 3 neutrals and 7 centre key holders)', () => {
      const invites = ctx.people.map((p) => p.invite as NonNullable<Participant['invite']>);
      const composed = composeFromInvites(invites, registered);
      const unmatched = composed.matching.rows.filter((row) => row.state.kind !== 'matched').map((row) => `${row.invite.name} is ${row.state.kind}`);
      if (unmatched.length > 0) throw new Error(unmatched.join('; '));
      if (!ctx.intruder || !composed.matching.unmatched.some((r) => r.passkeyPublicKey === ctx.intruder)) throw new Error('the registration without an issued secret was not left unmatched');
      if (composed.entries.some((e) => toHex(e.passkeyPublicKey) === ctx.intruder)) throw new Error('the registration without an issued secret is on the list');
      if (composed.matching.unmatched.length !== 1) throw new Error(`${String(composed.matching.unmatched.length)} registrations are unmatched, expected only the intruder`);
      entries = composed.entries;
      if (entries.length !== ctx.people.length) throw new Error(`${String(entries.length)} entries for ${String(ctx.people.length)} participants`);
      for (const p of ctx.people) {
        const entry = entries.find((e) => toHex(e.passkeyPublicKey) === p.passkeyPublicKey);
        if (!entry) throw new Error(`${p.name} is not on the composed list`);
        if (entry.role !== p.role || entry.owner !== p.owner) throw new Error(`${p.name}: composed as role ${String(entry.role)} owner ${entry.owner}, expected role ${String(p.role)} owner ${String(p.owner)}`);
      }
      const bytes = encodeApprovedList(entries);
      encoded = toHex(bytes);
      listHash = toHex(approvedListHash(fromHex(exam.examId), bytes));
      decodeApprovedList(bytes);
      const setters = decodeApprovedList(bytes).filter((e) => e.role === 1);
      if (setters.some((e) => e.owner !== setterOwner(e.passkeyPublicKey))) throw new Error('a setter entry is not the setterOwner hash of its passkey');
      return `${String(entries.length)} matched, 1 unmatched, list hash ${listHash}, ${String(bytes.length)} bytes`;
    });
    if (encoded === '0x') throw new RunStopped('the approved list could not be composed');

    await rep.check('b-register', 'post the approved list with cast send (board keystore), then read it back from ExamRegistry', async () => {
      const existing = await ctx.io.read(() => ctx.io.registry.getApprovedList(exam.examId));
      if (existing) throw new Error('an approved list is already posted for this exam. It is write-once, and these passkeys are new, so start from a new exam');
      const sent = await boardSend(ctx.io, 'postApprovedList', [exam.examId, encoded]);
      const back = await poll('ExamRegistry to return the list', () => ctx.io.read(() => ctx.io.registry.getApprovedList(exam.examId)), { timeoutMs: 120_000, intervalMs: 3_000 });
      const emitted = await poll('ApprovedListPosted event bytes', () => ctx.io.read(() => ctx.io.registry.getApprovedListEntries(exam.examId)), { timeoutMs: 120_000, intervalMs: 3_000 });
      if (back.listHash.toLowerCase() !== listHash) throw new Error(`stored hash ${back.listHash} differs from ${listHash}`);
      if (emitted.toLowerCase() !== encoded) throw new Error('the emitted entries differ from the bytes posted');
      if (decodeApprovedList(fromHex(emitted)).some((e) => toHex(e.passkeyPublicKey) === ctx.intruder)) throw new Error('the registration without an issued secret is on the posted list');
      updateRun((r) => (r.approvedList = { hash: listHash, transactionHash: sent.transactionHash, blockNumber: sent.blockNumber.toString() }));
      return `block ${sent.blockNumber.toString()}, tx ${sent.transactionHash}; the TEE sees it ${gaps.listDelay}`;
    });
    return { listHash, entries: encoded };
  });
}

/* ------------------------------------------------------------- c. Setters */

async function setters(ctx: Ctx, listHash: Hex): Promise<{ setter: string; questionHash: Hex; instancePublicKey: Hex }[]> {
  const { rep, env, exam, tee } = ctx;
  return rep.step('c-setters', async () => {
    await rep.check('c-setters', 'the TEE shows the signed approved list, and it is the one posted', async () => {
      const notify = throttled(rep);
      const status = await poll(
        'the TEE to show the approved list',
        async () => {
          const s = await teeRead(() => tee.status());
          if (s.stage === 'failed') throw new Error('the TEE stage is failed');
          return s.approvedList ? s : null;
        },
        { timeoutMs: Math.max(exam.schedule.lockAtUnix * 1000 - Date.now() - 60_000, 60_000), intervalMs: 5_000, onWait: notify },
      );
      if (status.approvedList?.hash !== listHash) throw new Error(`the TEE list hash ${String(status.approvedList?.hash)} differs from ${listHash}`);
      updateRun((r) => {
        if (r.approvedList) r.approvedList.seenByTeeAt = stamp();
      });
      return `stage ${status.stage}, seen ${String(Math.round((exam.schedule.lockAtUnix * 1000 - Date.now()) / 60000))} minutes before Lock`;
    });

    const receipts: { setter: string; questionHash: Hex; instancePublicKey: Hex }[] = [];
    for (const [setterIndex, p] of ofKind(ctx, 'setter').entries()) {
      let confirmed: Awaited<ReturnType<typeof confirm>> | undefined;
      await rep.check('c-setters', `${p.name}: Confirm (trusted attestation, TEE list hash equals the chain)`, async () => {
        confirmed = await confirm(env);
        return `instance key ${short(confirmed.instancePublicKey)}`;
      });
      if (!confirmed) continue;
      const c = confirmed;
      for (const topic of liveCriteria.topics) {
        for (let n = 1; n <= questionsPerSetterPerTopic; n += 1) {
          const question: Question = liveQuestion(topic.name, setterIndex * questionsPerSetterPerTopic + n);
          await rep.check('c-setters', `${p.name}: sealQuestion, sign, submit, verify receipt (${topic.name} ${String(n)}${question.options ? `, multiple choice with ${String(question.options.length)} options` : ''})`, async () => {
            const status = await teeRead(() => tee.status());
            if (status.stage !== 'submit') throw new Error(`the TEE is at the ${status.stage} stage, not submit`);
            const examBytes = fromHex(exam.examId);
            const ciphertext = await sealQuestion(c.encryptionPublicKey, examBytes, fromHex(p.passkeyPublicKey as Hex), question);
            const qHash = hashQuestion(ciphertext);
            const { challenge } = await teeRead(() => tee.questionChallenge());
            const digest = hashMessage('questionSubmission', { examId: examBytes, challenge: fromHex(challenge), questionHash: qHash });
            const signed = await call(p, 'sign', p.credentialId as string, toHex(digest));
            const receipt = await tee.question({
              passkeyPublicKey: p.passkeyPublicKey as Hex,
              ciphertext: toHex(ciphertext),
              challenge,
              signature: signed.signature as Hex,
              authenticatorData: signed.authenticatorData as Hex,
              clientDataJSON: signed.clientDataJSON as Hex,
            });
            if (receipt.questionHash !== toHex(qHash)) throw new Error('the receipt is for a different question hash');
            const valid = await verifyTeeSignature(
              fromHex(c.instancePublicKey),
              fromHex(receipt.teeSignature),
              encodeMessage('questionReceipt', { examId: examBytes, passkeyPublicKey: fromHex(p.passkeyPublicKey as Hex), questionHash: qHash }),
            );
            if (!valid) throw new Error('the receipt signature does not verify under the TEE instance key');
            receipts.push({ setter: p.name, questionHash: receipt.questionHash, instancePublicKey: c.instancePublicKey });
            updateRun((r) => (r.receipts = [...receipts]));
            return `sealed, hash ${short(receipt.questionHash)}`;
          });
        }
      }
    }
    const expected = ofKind(ctx, 'setter').length * liveCriteria.topics.length * questionsPerSetterPerTopic;
    await rep.check('c-setters', `the TEE holds all ${String(expected)} questions and every receipt verified`, async () => {
      const status = await teeRead(() => tee.status());
      if (receipts.length !== expected) throw new Error(`${String(receipts.length)} verified receipts, expected ${String(expected)}`);
      if (status.questionCount !== expected) throw new Error(`the TEE reports ${String(status.questionCount)} questions`);
      if (unixNow() >= exam.schedule.lockAtUnix) throw new Error('submitting finished after the Lock round, so the bank may be locked short');
      return `questionCount ${String(status.questionCount)}, ${String(exam.schedule.lockAtUnix - unixNow())}s before Lock`;
    });
    return receipts;
  });
}

/* --------------------------------------------------------------- d. Build */

async function buildStep(ctx: Ctx, listHash: Hex, receipts: { setter: string; questionHash: Hex; instancePublicKey: Hex }[]): Promise<BuildPost> {
  const { rep, env, exam, tee } = ctx;
  return rep.step('d-build', async () => {
    let post: BuildPost | undefined;
    await rep.check('d-build', 'wait for Lock and Build, read the outbox, verify the Build signature under the attested instance key', async () => {
      const notify = throttled(rep);
      let lastStage = '';
      const message = await poll(
        'the Build in the TEE outbox',
        async () => {
          const s = await teeRead(() => tee.status());
          if (s.stage !== lastStage) {
            lastStage = s.stage;
            rep.note(`TEE stage is ${s.stage}`);
          }
          if (s.stage === 'failed') throw new Error('the TEE stage is failed: the bank did not meet the criteria, so no paper will be built');
          const out = await teeRead(() => tee.outbox());
          return out.messages.find((m) => m.kind === 'build') ?? null;
        },
        { timeoutMs: Math.max((exam.schedule.lockAtUnix + 20 * 60) * 1000 - Date.now(), 120_000), intervalMs: 3_000, onWait: notify },
      );
      const trusted = await attest(env);
      if (!trusted.verdict.trusted) throw new UntrustedTeeError(trusted.claimLines);
      post = await verifyOutboxBuild(message, { examId: exam.examId, attestedInstancePublicKey: trusted.attestation.instancePublicKey });
      return `signed by ${short(post.instancePublicKey)}, selected ${String(post.selected)} of ${String(post.bankSize)}`;
    });
    if (!post) throw new RunStopped('no verified Build');
    const b = post;

    await rep.check('d-build', 'the Build matches this exam: list hash, criteria hash, selected and bank size', () => {
      if (b.approvedListHash !== listHash) throw new Error(`Build list hash ${b.approvedListHash} differs from the posted ${listHash}`);
      if (b.criteriaHash !== exam.criteriaHash) throw new Error(`Build criteria hash ${b.criteriaHash} differs from ${exam.criteriaHash}`);
      if (b.selected !== selectedCount(liveCriteria)) throw new Error(`selected ${String(b.selected)}, expected ${String(selectedCount(liveCriteria))}`);
      if (b.bankSize !== receipts.length) throw new Error(`bank size ${String(b.bankSize)}, expected the ${String(receipts.length)} questions submitted`);
      return `selected ${String(b.selected)}, bank ${String(b.bankSize)}`;
    });

    await rep.check('d-build', 'post the Build with cast send (board keystore) and verify the read-back, field by field', async () => {
      const existing = await ctx.io.read(() => ctx.io.registry.getBuild(exam.examId));
      let tx = '';
      if (existing) {
        tx = 'already posted';
      } else {
        const sent = await boardSend(ctx.io, 'postBuild', buildArgs(b));
        tx = sent.transactionHash;
      }
      const stored = await poll('ExamRegistry to return the Build', () => ctx.io.read(() => ctx.io.registry.getBuild(exam.examId)), { timeoutMs: 120_000, intervalMs: 3_000 });
      const rows: [string, string, string][] = [
        ['approvedListHash', b.approvedListHash, stored.approvedListHash],
        ['paperHash', b.paperHash, stored.paperHash],
        ['storageManifestHash', b.storageManifestHash, stored.storageManifestHash],
        ['saltedPaperHash', b.saltedPaperHash, stored.saltedPaperHash],
        ['selected', String(b.selected), String(stored.selected)],
        ['bankSize', String(b.bankSize), String(stored.bankSize)],
        ['criteriaHash', b.criteriaHash, stored.criteriaHash],
        ['builtRound', String(b.builtRound), String(stored.builtRound)],
        ['teeSignature', b.teeSignature, stored.teeSignature],
        ['instancePublicKey', b.instancePublicKey, stored.instancePublicKey],
      ];
      const wrong = rows.filter(([, want, got]) => want.toLowerCase() !== got.toLowerCase()).map(([label]) => label);
      if (wrong.length > 0) throw new Error(`the stored Build differs in: ${wrong.join(', ')}`);
      updateRun((r) => (r.build = { transactionHash: tx as Hex, instancePublicKey: b.instancePublicKey, saltedPaperHash: b.saltedPaperHash, storageManifestHash: b.storageManifestHash, paperHash: b.paperHash }));
      return `all ${String(rows.length)} fields read back equal, ${tx}`;
    });

    for (const name of [...new Set(receipts.map((r) => r.setter))]) {
      await rep.check('d-build', `${name}: every receipt's instance key equals the Build's instance key`, () => {
        const mine = receipts.filter((r) => r.setter === name);
        const off = mine.filter((r) => !equalBytes(fromHex(r.instancePublicKey), fromHex(b.instancePublicKey)));
        if (off.length > 0) throw new Error(`${String(off.length)} of ${String(mine.length)} receipts name a different TEE instance: the question went to a TEE other than the one that built the paper`);
        return `${String(mine.length)} of ${String(mine.length)} match`;
      });
    }
    return b;
  });
}

/* -------------------------------------------------------------- e. Download */

interface Download {
  paper: Uint8Array;
  keyPubTlock: string;
}

async function downloadStep(ctx: Ctx, build: BuildPost): Promise<Map<string, Download>> {
  const { rep, exam, env } = ctx;
  return rep.step('e-download', async () => {
    const downloads = new Map<string, Download>();
    const listEntries = await ctx.io.read(() => ctx.io.registry.getApprovedListEntries(exam.examId));
    if (!listEntries) throw new RunStopped('the approved list is not readable from the chain');
    for (const p of ofKind(ctx, 'centre-holder', 'centre')) {
      await rep.check('e-download', `${p.name}: manifest, coverage, paper.bin and key-pub.tlock against the Build`, async () => {
        const manifest = await fetchManifest(ctx.fetchFile, build, exam.examId);
        const holders = holdersFromChainList(exam.examId, listEntries, build);
        checkCoverage(manifest.manifest, holders);
        const paper = await fetchListedFile(ctx.fetchFile, manifest, build, storageNames.paper);
        const keyPub = await fetchListedFile(ctx.fetchFile, manifest, build, storageNames.keyPub);
        await fetchListedFile(ctx.fetchFile, manifest, build, storageNames.token);
        downloads.set(p.name, { paper, keyPubTlock: new TextDecoder().decode(keyPub) });
        return `manifest ${short(build.storageManifestHash)}, ${String(manifest.manifest.files.length)} files, ${String(holders.length)} shares listed, paper ${String(paper.length)} bytes`;
      });
    }
    await rep.check('e-download', 'token.jwt of the Build instance verifies as a record and binds the Build instance key', async () => {
      const token = new TextDecoder().decode(await ctx.fetchFile(storageNames.token));
      const failures = await checkPublishedToken(env, token, build.instancePublicKey);
      if (failures.length > 0) throw new Error(failures.join('; '));
      return 'signature and every claim ok';
    });
    return downloads;
  });
}

/* --------------------------------------------------------------- f. Release */

const RELEASE_ORDER = releaseOrder;

async function releaseStep(ctx: Ctx, build: BuildPost): Promise<void> {
  const { rep, exam, tee } = ctx;
  await rep.step('f-release', async () => {
    await waitUntil(rep, exam.schedule.unlockAtUnix, 'the unlock round T - delta');
    await rep.check('f-release', 'the unlock round is published by drand (quicknet) and the TEE is at the unlock stage', async () => {
      await waitForRound(Number(exam.schedule.unlockRound), { timeoutMs: 5 * 60_000 });
      const status = await poll(
        'the TEE unlock stage',
        async () => {
          const s = await teeRead(() => tee.status());
          if (s.stage === 'failed') throw new Error('the TEE stage is failed');
          return s.stage === 'unlock' ? s : null;
        },
        { timeoutMs: 10 * 60_000, intervalMs: 5_000, onWait: throttled(rep) },
      );
      if (status.release.released.length !== 0) throw new Error(`${String(status.release.released.length)} shares already released before the test`);
      return `stage unlock, ${String(status.release.required)} shares required, none released yet`;
    });

    const submitted: Participant[] = [];
    for (const name of RELEASE_ORDER) {
      const p = person(ctx, name);
      const ok = await rep.check('f-release', `${p.name}: one-touch releaseShare, sealRelease, submit`, async () => {
        await releaseWhenOpen(ctx, build, p);
        return 'share verified against the manifest, sealed to the TEE encryption key, accepted';
      });
      if (!ok) return;
      submitted.push(p);
      updateRun((r) => (r.released = submitted.map((s) => ({ name: s.name, passkeyPublicKey: s.passkeyPublicKey as Hex }))));
      const n = submitted.length;
      if (n < 8) {
        await rep.check('f-release', `after ${String(n)} of 8 shares: the TEE has not released anything`, async () => {
          const s = await poll(`the TEE to count ${String(n)} releases`, async () => {
            const cur = await teeRead(() => tee.status());
            return cur.release.released.length === n ? cur : null;
          }, { timeoutMs: 60_000, intervalMs: 2_000 });
          if (s.stage === 'released') throw new Error(`the TEE reached released with only ${String(n)} shares`);
          if (n === 7) await assertNothingPublished(ctx, submitted);
          return `stage ${s.stage}, ${String(s.release.released.length)} of ${String(s.release.required)}`;
        });
      }
    }
    await rep.check('f-release', 'the 8th share (the first neutral party) unlocks: stage released, 8 releases listed', async () => {
      const s = await poll(
        'the TEE to reach released',
        async () => {
          const cur = await teeRead(() => tee.status());
          return cur.stage === 'released' ? cur : null;
        },
        { timeoutMs: 5 * 60_000, intervalMs: 3_000, onWait: throttled(rep) },
      );
      const listed = new Set(s.release.released);
      const missing = submitted.filter((x) => !listed.has(x.passkeyPublicKey as Hex)).map((x) => x.name);
      if (s.release.released.length !== 8 || missing.length > 0) throw new Error(`released ${String(s.release.released.length)}, missing ${missing.join(', ')}`);
      return 'threshold of 8 of 10 reached, and only at the 8th share';
    });
  });
}

/**
 * With 7 of 10 shares (all centres, no neutral party) the signed log is public and correct to be
 * partial, as the README says for the time during delta, but nothing that opens the paper exists.
 */
async function assertNothingPublished(ctx: Ctx, released: readonly Participant[]): Promise<void> {
  const centres = ofKind(ctx, 'centre-holder', 'centre');
  const names = [...centres.map((c) => storageNames.centreKeyPriv(fromHex(c.derivedPublicKey as Hex))), storageNames.keyPriv, storageNames.releaseLog, 'release-token.jwt'];
  for (const name of names) {
    try {
      await ctx.fetchFile(name);
    } catch (error) {
      if (error instanceof NotFoundError) continue;
      throw error;
    }
    throw new Error(`storage already holds ${name} after 7 shares`);
  }
  const log = await teeRead(() => ctx.tee.releaseLog());
  await verifySignedLog(log, ctx.exam.examId);
  if (log.entries.length !== 7) throw new Error(`GET /v1/release/log lists ${String(log.entries.length)} entries after 7 shares`);
  if (log.files.length !== 0) throw new Error(`GET /v1/release/log lists ${String(log.files.length)} files before the threshold`);
  const logged = log.entries.map((e) => e.passkeyPublicKey);
  if (JSON.stringify(logged) !== JSON.stringify(released.map((p) => p.passkeyPublicKey))) throw new Error('GET /v1/release/log does not list the 7 who released, in order');
}

/**
 * A share the TEE turned away with `too_early` or `stale_beacon` was not accepted, and the TEE says
 * to try again: its view of drand lags the public one by a moment. Any other refusal is a failure.
 */
async function releaseWhenOpen(ctx: Ctx, build: BuildPost, p: Participant): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await releaseOne(ctx, build, p);
      return;
    } catch (error) {
      const retry = isReleaseNotOpen(error) || (error instanceof TeeApiError && error.code === 'stale_beacon');
      if (!retry || attempt >= 5) throw error;
      await sleep(1_000);
    }
  }
}

async function releaseOne(ctx: Ctx, build: BuildPost, p: Participant): Promise<void> {
  const { exam, env, tee } = ctx;
  const examBytes = fromHex(exam.examId);
  // Confirm: trusted attestation, and the list the TEE signed is the one on-chain.
  const confirmed = await confirm(env);
  const list = confirmed.status.approvedList;
  if (!list) throw new Error('the TEE has no signed list');
  const own = decodeApprovedList(fromHex(list.entries)).find((e) => toHex(e.passkeyPublicKey) === p.passkeyPublicKey);
  if (!own || (own.role !== 2 && own.role !== 3)) throw new Error('this key is not a key holder on the approved list');
  if (toHex(own.derivedPublicKey) !== p.derivedPublicKey) throw new Error('the list holds a different derived key for this key');
  // The share file, checked against the manifest and the manifest against the Build.
  const manifest = await fetchManifest(ctx.fetchFile, build, exam.examId);
  const shareName = storageNames.share(fromHex(p.derivedPublicKey as Hex));
  const entry = manifest.manifest.files.find((f) => f.name === shareName);
  if (!entry) throw new Error(`the manifest does not list ${shareName}`);
  if (entry.recipient !== p.derivedPublicKey || entry.shareHash === undefined) throw new Error('the manifest does not name this holder as the recipient');
  const sealedShare = await fetchListedFile(ctx.fetchFile, manifest, build, shareName);
  const { challenge } = await teeRead(() => tee.releaseChallenge());
  const digest = hashMessage('shareRelease', { examId: examBytes, challenge: fromHex(challenge) });
  // One touch: the passkey signs the digest and the same request opens the share.
  const released = await call(p, 'releaseShare', p.credentialId as string, exam.examId, toHex(digest), toHex(sealedShare));
  const share = fromHex(released.share);
  try {
    if (toHex(hashMessage('shareHash', { share })) !== entry.shareHash) throw new Error('the share does not match the share hash in the manifest, so it was not sent');
    const sealed = await sealRelease(confirmed.encryptionPublicKey, examBytes, {
      share,
      signature: fromHex(released.signature),
      authenticatorData: fromHex(released.authenticatorData),
      clientDataJSON: fromHex(released.clientDataJSON),
    });
    await tee.releaseShare({ passkeyPublicKey: p.passkeyPublicKey as Hex, challenge, sealed: toHex(sealed) });
  } finally {
    share.fill(0);
  }
}

/* ---------------------------------------------------------------- g. Unlock */

async function unlockStep(ctx: Ctx, build: BuildPost, downloads: Map<string, Download>): Promise<Hex> {
  const { rep, exam } = ctx;
  return rep.step('g-unlock', async () => {
    const hashes = new Map<string, Hex>();
    for (const p of ofKind(ctx, 'centre-holder', 'centre')) {
      await rep.check('g-unlock', `${p.name}${p.kind === 'centre' ? ' (no share)' : ' (key holder)'}: timelockDecrypt K_pub, openKeyPriv, XOR, openPaperFile, parsePaper, saltedPaperHash against the Build`, async () => {
        const dl = downloads.get(p.name);
        if (!dl) throw new Error('no downloaded files for this centre');
        const sealed = await poll(`${p.name}'s key-priv file`, () => ctx.fetchFile(storageNames.centreKeyPriv(fromHex(p.derivedPublicKey as Hex))).catch((e: unknown) => (e instanceof NotFoundError ? null : Promise.reject(e as Error))), { timeoutMs: 5 * 60_000, intervalMs: 5_000 });
        const kPriv = await call(p, 'openKeyPriv', p.credentialId as string, exam.examId, toHex(sealed));
        const kPrivBytes = fromHex(kPriv);
        try {
          const { paperBytes, paper } = await openPaper({ examId: exam.examId, saltedPaperHash: build.saltedPaperHash, criteria: liveCriteria, keyPubTlock: dl.keyPubTlock, kPriv: kPrivBytes, paperFile: dl.paper });
          hashes.set(p.name, toHex(await sha256(paperBytes)));
          return `${String(paper.questions.length)} questions, ${String(paper.questions.filter((q) => q.options).length)} multiple choice, paper sha256 ${short(hashes.get(p.name) as string)}`;
        } finally {
          kPrivBytes.fill(0);
        }
      });
    }
    await rep.check('g-unlock', 'a neutral party gets no K_priv copy', async () => {
      const n = person(ctx, 'neutral-1');
      try {
        await ctx.fetchFile(storageNames.centreKeyPriv(fromHex(n.derivedPublicKey as Hex)));
      } catch (error) {
        if (error instanceof NotFoundError) return 'no key-priv file for the neutral party';
        throw error;
      }
      throw new Error('a key-priv file exists for a neutral party');
    });
    let common: Hex = '0x';
    await rep.check('g-unlock', 'all 8 centres, the 7 key holders and the one without a share, got the identical paper', () => {
      const names = ofKind(ctx, 'centre-holder', 'centre').map((p) => p.name);
      const missing = names.filter((n) => !hashes.has(n));
      if (missing.length > 0) throw new Error(`no paper from ${missing.join(', ')}`);
      const unique = new Set(names.map((n) => hashes.get(n)));
      if (unique.size !== 1) throw new Error(`${String(unique.size)} different papers: ${names.map((n) => `${n}=${short(hashes.get(n) as string, 6)}`).join(', ')}`);
      common = hashes.get(names[0] as string) as Hex;
      if (!hashes.has('centre-8')) throw new Error('the centre without a share got no paper');
      return `one paper, sha256 ${common}`;
    });
    if (common === '0x') throw new RunStopped('no common paper');
    updateRun((r) => (r.paperSha256 = common));
    return common;
  });
}

/* ----------------------------------------------------------------- h. Proof */

async function proofStep(ctx: Ctx, build: BuildPost, centrePaperHash: Hex): Promise<void> {
  const { rep, exam, env, tee } = ctx;
  await rep.step('h-proof', async () => {
    await waitUntil(rep, exam.schedule.endAtUnix, 'the end round');
    await rep.check('h-proof', 'the end round is published by drand', async () => {
      return `round ${String(await waitForRound(Number(exam.schedule.endRound), { timeoutMs: 10 * 60_000 }))}`;
    });

    // From here on nothing uses a passkey, a browser or any participant: only public data.
    await rep.check('h-proof', 'public proof with no key: open key-pub.tlock and key-priv.tlock with drand, get the paper, match the Build and the centres', async () => {
      const keyPubTlock = new TextDecoder().decode(await ctx.fetchFile(storageNames.keyPub));
      const keyPrivTlock = new TextDecoder().decode(await poll('key-priv.tlock', () => ctx.fetchFile(storageNames.keyPriv).catch((e: unknown) => (e instanceof NotFoundError ? null : Promise.reject(e as Error))), { timeoutMs: 120_000, intervalMs: 5_000 }));
      const manifest = await fetchManifest(ctx.fetchFile, build, exam.examId);
      const paperFile = await fetchListedFile(ctx.fetchFile, manifest, build, storageNames.paper);
      const kPriv = await retryTransient(() => timelockDecrypt(keyPrivTlock));
      try {
        const { paperBytes, paper } = await openPaper({ examId: exam.examId, saltedPaperHash: build.saltedPaperHash, criteria: liveCriteria, keyPubTlock, kPriv, paperFile });
        const digest = toHex(await sha256(paperBytes));
        if (digest !== centrePaperHash) throw new Error(`the public paper ${digest} differs from the one the centres got, ${centrePaperHash}`);
        return `${String(paper.questions.length)} questions, salted paper hash equals the Build, same paper as the centres`;
      } finally {
        kPriv.fill(0);
      }
    });

    await rep.check('h-proof', 'release-log.json and release-token.jwt verify, the log names the 8 holders who released, and it lists exactly key-priv.tlock and each centre\'s key-priv file with their stored hashes', async () => {
      const stored = JSON.parse(new TextDecoder().decode(await ctx.fetchFile(storageNames.releaseLog))) as Awaited<ReturnType<TeeClient['releaseLog']>>;
      const live = await teeRead(() => tee.releaseLog());
      await verifySignedLog(stored, exam.examId);
      // Once the delivery is prepared the TEE serves the log it published and does not sign again,
      // so the whole body must be identical, signature included.
      if (JSON.stringify(stored) !== JSON.stringify(live)) throw new Error('release-log.json differs from GET /v1/release/log');
      const token = new TextDecoder().decode(await ctx.fetchFile('release-token.jwt'));
      const failures = await checkPublishedToken(env, token, stored.instancePublicKey);
      if (failures.length > 0) throw new Error(`release-token.jwt: ${failures.join('; ')}`);
      const expected = RELEASE_ORDER.map((n) => person(ctx, n).passkeyPublicKey as Hex);
      const got = stored.entries.map((e) => e.passkeyPublicKey);
      if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`the log lists ${got.map((k) => short(k, 8)).join(', ')} instead of the 8 who released, in order`);
      const listEntries = await ctx.io.read(() => ctx.io.registry.getApprovedListEntries(exam.examId));
      if (!listEntries) throw new Error('the approved list is not readable from the chain');
      checkLogHolders(stored, listEntries, (await fetchManifest(ctx.fetchFile, build, exam.examId)).manifest, exam.schedule.unlockRound);
      const files = await checkLogFiles(stored, listEntries, ctx.fetchFile);
      return `${String(stored.entries.length)} entries, ${String(files)} files, signature, entriesHash, filesHash, token, share hashes and stored file hashes verified, signer ${short(stored.instancePublicKey)}`;
    });

    // No names are published. The list shows only the hash of each setter's passkey, and anyone recomputes it.
    await rep.check('h-proof', 'no setter name is on the on-chain list, and each setter owner is the hash of its own passkey', async () => {
      const entries = await ctx.io.read(() => ctx.io.registry.getApprovedListEntries(exam.examId));
      if (!entries) throw new Error('the approved list is not readable from the chain');
      const count = checkSetterOwners(entries);
      const setters = decodeApprovedList(fromHex(entries)).filter((e) => e.role === 1);
      if (setters.some((e) => ctx.people.some((p) => p.kind === 'setter' && e.owner === p.name))) throw new Error('a setter name appears on the list in the clear');
      return `${String(count)} setters, each listed only by the hash of its passkey`;
    });
  });
}
