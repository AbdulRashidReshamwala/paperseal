import { spawnSync } from 'node:child_process';

import { examRegistryAbi } from '@paperseal/chain';
import {
  checkApprovedList,
  chain,
  checkSchedule,
  decodeCriteria,
  encodeApprovedList,
  approvedListHash,
  fromHex,
  inviteTag,
  newInviteSecret,
  ApprovedListError,
  ScheduleError,
  matchInvites,
  setterOwner,
  startupArgs,
  threshold,
  encodePaper,
  parsePaper,
  toHex,
  type ApprovedListEntry,
  type Hex,
  type Question,
  type TaggedRegistration,
} from '@paperseal/protocol';
import { decodeFunctionData, getAbiItem, toFunctionSelector, type AbiFunction } from 'viem';

import { calldata, castSendArgs } from './cast';
import { deployed, gapsFor, rpcHost } from './config';
import { composeFromInvites, issueInvites, openLink, type IssuedInvite } from './invites';
import { parseReleaseBody } from './github';
import { releaseOrder, roster } from './roster';
import { computeSchedule, liveCriteria, plan, liveQuestion, questionsPerSetterPerTopic, questionText, runTeeArgs } from './schedule';

/* `dry-check`: everything that can be checked with no network, no chain, no TEE and no key. */

let failures = 0;
async function check(label: string, run: () => Promise<string | void> | string | void): Promise<void> {
  try {
    const detail = await run();
    console.log(`PASS  ${label}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const expect = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

const NOW = 1_800_000_000;
const COMMIT = `0x${'ab'.repeat(20)}` as Hex;
const DIGEST = `0x${'cd'.repeat(32)}` as Hex;

const sigOf = (name: string): string => {
  const item = getAbiItem({ abi: examRegistryAbi, name: name as 'createExam' }) as AbiFunction;
  type P = { type: string; components?: readonly P[] };
  const t = (p: P): string => (p.type.startsWith('tuple') ? `(${(p.components ?? []).map(t).join(',')})${p.type.slice(5)}` : p.type);
  return `${name}(${item.inputs.map(t).join(',')})`;
};

const cast = (args: string[]) => spawnSync('cast', args, { encoding: 'utf8' });

export async function dryCheck(): Promise<void> {
  const schedule = computeSchedule(NOW);
  const settings = plan('Dry check exam', schedule).settings;

  // Written out here, so a change to config.ts has to be made twice to pass.
  const expected = {
    latest: { lock: 165, unlock: 195, examStart: 210, end: 295, delta: 15, lead: 100 },
    finalized: { lock: 1680, unlock: 1860, examStart: 1920, end: 2160, delta: 60, lead: 1200 },
  };
  for (const mode of ['latest', 'finalized'] as const) {
    const want = expected[mode];
    const active = mode === chain.readBlock ? ', the active mode' : '';
    const minutes = (s: number) => `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
    await check(`schedule for ${mode}${active}: lock +${minutes(want.lock)}, unlock +${minutes(want.unlock)}, T +${minutes(want.examStart)}, end +${minutes(want.end)}, each round the first at or after its time`, () => {
      const using = gapsFor(mode);
      const s = computeSchedule(NOW, using);
      const near = (actual: number, target: number) => actual >= target && actual < target + 3;
      expect(using.minLeadBeforeLock === want.lead, `lead before Lock ${String(using.minLeadBeforeLock)}s`);
      expect(near(s.lockAtUnix, NOW + want.lock), `lock ${String(s.lockAtUnix - NOW)}s`);
      expect(near(s.unlockAtUnix, s.examStart - s.delta), 'unlock round is not the first at or after T - delta');
      expect(s.unlockAtUnix - NOW < want.unlock + 3, `unlock ${String(s.unlockAtUnix - NOW)}s`);
      expect(s.examStart === NOW + want.examStart && s.delta === want.delta, 'T or delta');
      expect(near(s.endAtUnix, NOW + want.end), 'end round');
      expect(BigInt(s.lockRound) < BigInt(s.unlockRound) && BigInt(s.unlockRound) < BigInt(s.endRound), 'round order');
      expect(s.endAtUnix > s.examStart, 'the end round must be after T');
      expect(mode !== 'latest' || s.endAtUnix - NOW < 300, 'a dev exam must finish in under 5 minutes');
      checkSchedule(plan('Dry check exam', s).settings);
      return `lock ${s.lockRound}, unlock ${s.unlockRound}, end ${s.endRound}, delta ${String(s.delta)}s, run needs ${String(want.lead)}s before Lock`;
    });
  }

  await check('checkSchedule accepts it and rejects a wrong unlock round, a wrong chain and a zero delta', () => {
    checkSchedule({ ...settings, chainId: chain.chainId });
    const rejects = (patch: object, code: string) => {
      try {
        checkSchedule({ ...settings, ...patch });
      } catch (error) {
        expect(error instanceof ScheduleError && error.code === code, `expected ${code}, got ${String(error)}`);
        return;
      }
      throw new Error(`${code} was not raised`);
    };
    rejects({ unlockRound: String(Number(schedule.unlockRound) + 1) }, 'unlock_round');
    rejects({ chainId: 1 }, 'chain_id');
    rejects({ delta: 0 }, 'delta_zero');
  });

  const built = plan('Dry check exam', schedule);
  await check('criteria: 2 topics of 3, maxSetterPercent 50, minBankMultiple 2; encoding round-trips and hashes', () => {
    const back = decodeCriteria(fromHex(built.criteriaEncoded));
    expect(JSON.stringify(back) === JSON.stringify(liveCriteria), 'round trip');
    expect(liveCriteria.topics.length === 2 && liveCriteria.topics.every((t) => t.questions === 3), 'topics');
    expect(liveCriteria.maxSetterPercent === 50 && liveCriteria.minBankMultiple === 2, 'percent or multiple');
    // 2 setters x 3 per topic = 6 per topic, which is 2 x 3, and each holds exactly 50 percent.
    const perTopic = 2 * questionsPerSetterPerTopic;
    expect(perTopic >= liveCriteria.minBankMultiple * 3, 'bank per topic is too small');
    expect((questionsPerSetterPerTopic / perTopic) * 100 <= liveCriteria.maxSetterPercent, 'a setter holds too much of a topic');
    return built.criteriaHash;
  });

  await check('roster: 13 participants, 3 neutrals plus 7 centre key holders equal 10 holders, release order reaches 8 only on the 8th', () => {
    const by = (role: number) => roster.filter((r) => r.role === role).length;
    expect(roster.length === 13 && by(1) === 2 && by(2) === threshold.neutrals && by(3) === threshold.centres && by(4) === 1, 'roster counts');
    expect(releaseOrder.length === threshold.required, 'release order is not the threshold');
    expect(releaseOrder.slice(0, 7).every((n) => n.startsWith('centre-')) && releaseOrder[7]?.startsWith('neutral-') === true, 'centres first, a neutral party 8th');
  });

  // Invites, composed the way the board app does it, with the same protocol functions. No network.
  const point = (n: number): Uint8Array => {
    const out = new Uint8Array(65);
    out[0] = 4;
    out.fill(n, 1);
    return out;
  };
  const registrationFor = (invite: IssuedInvite, index: number, secret: Hex = invite.inviteSecret, owner?: string): TaggedRegistration => {
    const passkey = point(index + 1);
    return {
      owner: owner ?? (invite.role === 'setter' ? setterOwner(passkey) : (invite.owner as string)),
      passkeyPublicKey: toHex(passkey),
      derivedPublicKey: invite.role === 'setter' ? '0x' : toHex(point(100 + index)),
      inviteTag: toHex(inviteTag(fromHex(secret), passkey)),
    };
  };
  const issued = issueInvites(built.examId, roster);
  const registered = issued.map((invite, i) => registrationFor(invite, i));

  await check('invites: one random 32-byte secret per participant, and each link keeps its role, owner and secret in the URL fragment only', () => {
    expect(issued.length === roster.length, 'one invite per participant');
    expect(new Set(issued.map((i) => i.inviteSecret)).size === roster.length, 'secrets repeat');
    expect(issued.every((i) => /^0x[0-9a-f]{64}$/.test(i.inviteSecret)), 'secret shape');
    for (const invite of issued) {
      const url = new URL(invite.link);
      expect(url.search === '' && url.pathname === '/', `${invite.name}: something is outside the fragment`);
      expect(url.hash.includes(invite.inviteSecret) && url.hash.includes(built.examId), `${invite.name}: the fragment lacks the secret or exam`);
      const opened = openLink(invite.link);
      expect(opened.role === invite.role && opened.owner === invite.owner && opened.inviteSecret === invite.inviteSecret, `${invite.name}: the link reads back differently`);
      if (invite.role === 'setter') expect(opened.owner === undefined && !url.hash.includes('owner') && !url.hash.includes(invite.name), `${invite.name}: a setter invite carries a name`);
    }
    for (const bad of [`${issued[0]?.link ?? ''}&x=1`, (issued[0]?.link ?? '').replace('secret=0x', 'secret=0X'), (issued[3]?.link ?? '').replace(/&owner=[^&]*/, '')]) {
      let refused = false;
      try {
        openLink(bad);
      } catch {
        refused = true;
      }
      expect(refused, 'a damaged link was accepted');
    }
    return `${String(issued.length)} links; a link with an extra part, an uppercase secret or a missing owner is refused`;
  });

  await check('compose from invites: every participant matches its own invite, and the entries pass checkApprovedList with the roster roles', () => {
    const composed = composeFromInvites(issued, registered);
    expect(composed.entries.length === roster.length && composed.matching.unmatched.length === 0, 'entries or unmatched');
    expect(composed.matching.rows.every((r) => r.state.kind === 'matched'), 'an invite is not matched');
    for (const [i, r] of roster.entries()) {
      const entry = composed.entries.find((e) => toHex(e.passkeyPublicKey) === registered[i]?.passkeyPublicKey);
      expect(entry?.role === r.role, `${r.name} has role ${String(entry?.role)}, expected ${String(r.role)}`);
    }
    return '13 matched; 3 neutrals, 7 centre key holders, 1 centre without a share and 2 setters';
  });

  await check('compose from invites: a name without its secret, a copied tag, another name and a doubled invite are all kept off the list', () => {
    const neutral = issued.findIndex((i) => i.role === 'keyholder');
    const base = issued[neutral] as IssuedInvite;
    const intruder = { ...registrationFor(base, 50, newInviteSecret()) }; // knows the name, not the secret
    const copied = { ...registrationFor(base, 51), inviteTag: registered[neutral]?.inviteTag as Hex }; // another passkey with a tag made for this one
    const renamed = { ...registrationFor(base, 52), owner: 'someone-else' }; // the right secret under another name
    const wrongKind = { ...registrationFor(base, 53), derivedPublicKey: '0x' as Hex }; // a setter-shaped key on a holder invite
    for (const [what, extra] of [['name only', intruder], ['copied tag', copied], ['renamed', renamed], ['wrong key kind', wrongKind]] as const) {
      const composed = composeFromInvites(issued, [...registered, extra]);
      expect(composed.matching.unmatched.length === 1 && composed.matching.unmatched[0]?.passkeyPublicKey === extra.passkeyPublicKey, `${what}: not unmatched`);
      expect(composed.entries.length === roster.length && !composed.entries.some((e) => toHex(e.passkeyPublicKey) === extra.passkeyPublicKey), `${what}: reached the list`);
      expect(composed.matching.rows[neutral]?.state.kind === 'matched', `${what}: the real registration lost its place`);
    }
    // Two passkeys on one invite: neither is listed, so the list is short and cannot be composed, until the invite is reissued.
    const twin = registrationFor(base, 54);
    let refused = false;
    try {
      composeFromInvites(issued, [...registered, twin]);
    } catch (error) {
      refused = error instanceof ApprovedListError;
    }
    expect(refused, 'a doubled invite was listed, or failed with the wrong error');
    const reissued = issued.map((i, k) => (k === neutral ? { ...i, inviteSecret: newInviteSecret() } : i));
    const after = matchInvites(reissued, [...registered, twin]);
    expect(after.rows[neutral]?.state.kind === 'waiting' && after.unmatched.length === 2, 'a reissued invite still matches an old key');
    return 'each is unmatched or refused, and a reissued invite matches neither old key';
  });

  await check('the live questions include multiple choice, and every one passes the paper format', () => {
    const questions: Question[] = [];
    for (const topic of liveCriteria.topics) {
      for (let n = 1; n <= 2 * questionsPerSetterPerTopic; n += 1) questions.push(liveQuestion(topic.name, n));
    }
    const choice = questions.filter((q) => q.options !== undefined);
    expect(choice.length >= 2 && choice.length < questions.length, 'the live questions are not a mix of multiple choice and written');
    expect(
      liveCriteria.topics.every((t) => questions.some((q) => q.topic === t.name && q.options !== undefined)),
      'a topic has no multiple choice question',
    );
    expect(new Set(choice.map((q) => q.options?.length)).size > 1, 'every multiple choice question has the same number of options');
    expect(questions.every((q) => q.options === undefined || !('answer' in q)), 'a question carries an answer key');
    // The same strict path the proof uses: encode, then parse, with the bytes unchanged.
    const examId = `0x${'ab'.repeat(32)}` as const;
    const bytes = encodePaper({ examId, questions });
    const parsed = parsePaper(bytes);
    expect(parsed.questions.length === questions.length, 'parsePaper changed the question count');
    expect(toHex(encodePaper(parsed)) === toHex(bytes), 'the paper does not round-trip to the same bytes');
    expect(parsed.questions.every((q, i) => q.options === undefined || q.options.join('|') === questions[i]?.options?.join('|')), 'option order changed');
    expect(
      questions.every((q) => !/setter/i.test(JSON.stringify(q)) && !roster.some((r) => JSON.stringify(q).includes(r.name))),
      'a question or option names a setter',
    );
    return `${String(choice.length)} of ${String(questions.length)} are multiple choice, with ${[...new Set(choice.map((q) => q.options?.length))].join(' and ')} options`;
  });

  await check('question text names no setter, and no two questions read the same', () => {
    const texts: string[] = [];
    for (const setterIndex of [0, 1]) {
      for (const topic of liveCriteria.topics) {
        for (let n = 1; n <= questionsPerSetterPerTopic; n += 1) texts.push(questionText(topic.name, setterIndex * questionsPerSetterPerTopic + n));
      }
    }
    expect(texts.every((t) => !/setter/i.test(t) && !roster.some((r) => t.includes(r.name))), 'a question names a setter');
    expect(new Set(texts).size === texts.length, 'two questions read the same');
    return `${String(texts.length)} questions, e.g. "${texts[0] ?? ''}"`;
  });

  const registry = deployed.registry;
  const settingsArgs = {
    examId: built.examId,
    examStart: BigInt(schedule.examStart),
    delta: BigInt(schedule.delta),
    lockRound: BigInt(schedule.lockRound),
    unlockRound: BigInt(schedule.unlockRound),
    endRound: BigInt(schedule.endRound),
    criteriaHash: built.criteriaHash,
    rpcHost,
  };
  const createArgs = [COMMIT, DIGEST, settingsArgs, built.criteriaEncoded] as const;
  const createData = calldata('createExam', createArgs);

  await check('createExam calldata decodes back to the inputs and has the selector of the ABI signature', () => {
    const decoded = decodeFunctionData({ abi: examRegistryAbi, data: createData });
    expect(decoded.functionName === 'createExam', 'function name');
    const [commit, digest, s, criteria] = decoded.args as unknown as [Hex, Hex, typeof settingsArgs, Hex];
    expect(commit === COMMIT && digest === DIGEST && criteria === built.criteriaEncoded, 'commit, digest or criteria');
    expect(s.examStart === settingsArgs.examStart && s.unlockRound === settingsArgs.unlockRound && s.rpcHost === rpcHost && s.criteriaHash === built.criteriaHash, 'settings');
    expect(createData.slice(0, 10) === toFunctionSelector(sigOf('createExam')), 'selector');
    return `${String((createData.length - 2) / 2)} bytes, selector ${createData.slice(0, 10)}`;
  });

  const cd = cast(['--version']);
  await check('createExam, postApprovedList and postBuild calldata equal what `cast calldata` builds independently', () => {
    if (cd.status !== 0) return 'skipped, cast is not installed';
    const quote = (value: string) => `"${value}"`;
    const tuple = `(${[built.examId, schedule.examStart, schedule.delta, schedule.lockRound, schedule.unlockRound, schedule.endRound, built.criteriaHash, quote(rpcHost)].join(',')})`;
    const viaCast = cast(['calldata', sigOf('createExam'), COMMIT, DIGEST, tuple, built.criteriaEncoded]);
    expect(viaCast.status === 0, `cast calldata failed: ${viaCast.stderr.trim()}`);
    expect(viaCast.stdout.trim() === createData, 'createExam calldata differs from cast');

    const entries = syntheticList();
    const listData = calldata('postApprovedList', [built.examId, entries.encoded]);
    const list = cast(['calldata', sigOf('postApprovedList'), built.examId, entries.encoded]);
    expect(list.status === 0 && list.stdout.trim() === listData, 'postApprovedList calldata differs from cast');

    const word = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
    const sig = `0x${'11'.repeat(64)}`;
    const key = `0x04${'22'.repeat(64)}`;
    const buildData = calldata('postBuild', [built.examId, word(1), word(2), word(3), word(4), 6, 12, built.criteriaHash, sig, key]);
    const build = cast(['calldata', sigOf('postBuild'), built.examId, word(1), word(2), word(3), word(4), '6', '12', built.criteriaHash, sig, key]);
    expect(build.status === 0 && build.stdout.trim() === buildData, 'postBuild calldata differs from cast');
    return 'all three equal';
  });

  await check('approved list: setters are the hash of their own passkey, composed and encoded by the protocol package, calldata decodes back', () => {
    const { encoded, entries } = syntheticList();
    checkApprovedList(entries);
    const data = calldata('postApprovedList', [built.examId, encoded]);
    const decoded = decodeFunctionData({ abi: examRegistryAbi, data });
    expect(decoded.functionName === 'postApprovedList' && (decoded.args as unknown as Hex[])[1] === encoded, 'round trip');
    for (const e of entries.filter((x) => x.role === 1)) expect(e.owner === setterOwner(e.passkeyPublicKey), 'setter owner is not the hash of its passkey');
    const bad = entries.map((e) => (e.role === 1 ? { ...e, owner: 'Alice' } : e));
    try {
      checkApprovedList(bad);
    } catch (error) {
      expect(error instanceof ApprovedListError, 'wrong error type');
      return `list hash ${toHex(approvedListHash(fromHex(built.examId), fromHex(encoded)))}; a setter named in the clear is rejected`;
    }
    throw new Error('a setter with a plain name was accepted');
  });

  await check('setterOwner depends only on the passkey public key, and another key is rejected', () => {
    const { entries } = syntheticList();
    const setter = entries.find((e) => e.role === 1);
    if (!setter) throw new Error('no setter in the synthetic list');
    const a = setterOwner(setter.passkeyPublicKey);
    expect(a === setterOwner(setter.passkeyPublicKey), 'not deterministic');
    const other = new Uint8Array(setter.passkeyPublicKey);
    other[1] = (other[1] ?? 0) ^ 1;
    expect(a !== setterOwner(other), 'the key does not matter');
    expect(/^0x[0-9a-f]{64}$/.test(a), 'shape');
    const swapped = entries.map((e) => (e === setter ? { ...e, owner: setterOwner(other) } : e));
    try {
      checkApprovedList(swapped);
    } catch (error) {
      expect(error instanceof ApprovedListError, 'wrong error type');
      return 'an owner that is the hash of another key is rejected';
    }
    throw new Error('a setter owner that is not the hash of its own passkey was accepted');
  });

  await check('cast send arguments: keystore account and password file path, calldata passed as --data, no key or prompt flags', () => {
    const args = castSendArgs(registry, createData);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0] === 'send' && args[1] === registry, 'to');
    expect(at('--data') === createData, '--data');
    expect(at('--account') === deployed.keystoreAccount && at('--password-file') === deployed.passwordFile, 'account or password file');
    expect(at('--rpc-url') === deployed.rpcUrl && args.includes('--json'), 'rpc or json');
    for (const forbidden of ['--private-key', '--interactive', '--keystore', '--mnemonic', '--ledger', '--trezor']) expect(!args.includes(forbidden), `${forbidden} must not be used`);
    // The file is only named, never opened: nothing here reads it, so the check is on the argv alone.
    expect(args.filter((a) => a.includes('board-keystore-password')).length === 1, 'the password file path appears once');
    return `account ${deployed.keystoreAccount}, password file path only (contents never read)`;
  });

  await check('run-tee.sh arguments: ten startup arguments in spec order, then --image-digest=sha256:<hex>, in the formats the script accepts', () => {
    const args = runTeeArgs(settings, DIGEST);
    expect(args.length === 11, `${String(args.length)} arguments`);
    expect(JSON.stringify(args.slice(0, 10)) === JSON.stringify(startupArgs(settings)), 'startup arguments');
    const names = args.map((a) => a.slice(2, a.indexOf('=')));
    expect(names.join(',') === 'exam-id,exam-start,delta,lock-round,unlock-round,end-round,criteria-hash,rpc-host,registry,chain-id,image-digest', `order ${names.join(',')}`);
    expect(/^--image-digest=sha256:[0-9a-f]{64}$/.test(args[10] as string), 'image digest');
    expect(/^--registry=0x[0-9a-f]{40}$/.test(args[8] as string), 'registry must be lowercase');
    expect(/^--rpc-host=[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(args[7] as string), 'rpc host');
    return args.join(' ');
  });

  await check('GitHub release parsing follows the apps/web rules', () => {
    const body = (j: object) => `notes\n\n\`\`\`json\n${JSON.stringify(j)}\n\`\`\`\n`;
    const good = { version: 'v0.2.0', commit: COMMIT, imageDigest: DIGEST, run: 'https://github.com/o/r/actions/runs/1' };
    expect(parseReleaseBody(body(good), 'v0.2.0')?.imageDigest === DIGEST, 'good release');
    expect(parseReleaseBody(body({ ...good, version: 'v0.2.1' }), 'v0.2.0') === null, 'version must equal the tag');
    expect(parseReleaseBody(body({ ...good, imageDigest: `0x${'CD'.repeat(32)}` }), 'v0.2.0') === null, 'digest must be lowercase');
    expect(parseReleaseBody(body({ ...good, commit: `0x${'ab'.repeat(32)}` }), 'v0.2.0') === null, 'commit must be 20 bytes');
    expect(parseReleaseBody(body({ ...good, run: 'http://x' }), 'v0.2.0') === null, 'run must be https');
    expect(parseReleaseBody(`${body(good)}${body(good)}`, 'v0.2.0') === null, 'exactly one block');
    expect(parseReleaseBody(body(good), 'v0.2') === null, 'tag shape');
  });

  console.log(failures === 0 ? '\ndry-check: all checks passed (offline, nothing sent).' : `\ndry-check: ${String(failures)} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

/** A well-formed list of 13 entries with fake keys, for encoding checks only. Never posted. */
function syntheticList(): { entries: ApprovedListEntry[]; encoded: Hex } {
  const point = (n: number): Uint8Array => {
    const out = new Uint8Array(65);
    out[0] = 4;
    out.fill(n, 1);
    return out;
  };
  const entries: ApprovedListEntry[] = roster.map((r, i) => ({
    role: r.role,
    passkeyPublicKey: point(i + 1),
    derivedPublicKey: r.role === 1 ? new Uint8Array() : point(100 + i),
    owner: r.role === 1 ? setterOwner(point(i + 1)) : r.name,
  }));
  return { entries, encoded: toHex(encodeApprovedList(entries)) };
}
