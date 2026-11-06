import type { ExamNameCheck, ExamNameResult } from '@paperseal/chain';
import { describe, expect, beforeAll, it, vi } from 'vitest';
import { chain as chainSpec, roundTimeSeconds, sortReleaseFiles, storageNames, toHex, type Hex } from '@paperseal/protocol';

import {
  approvedEntries,
  checkManifest,
  checkPublishedToken,
  checkRecordToken,
  checkReleaseFiles,
  checkReleaseLog,
  holdersOf,
  parseReleaseLog,
  releaseProgress,
  type Build,
  type FreshVerdict,
  type ProofChecks,
  type ProofState,
} from '@paperseal/verify';
import { boardAddress, buildWorld, examId, random, registryAddress, registryMatches, storageBucket, type World } from '@paperseal/verify/fixtures';

import { clockTime, custody, inWords, repository, utcTime, type Custody, type CustodyStep, type Item, type NameView, type StepId, type View } from './custody';
import type { ArkivReport, LiveReport, ProofRun, Records } from './load';

// The rounds of a fixture exam, with its times in the past or future as each test needs.
const LOCK = 100;
const UNLOCK = 200;
const END = 300;

let world: World;
let fullRecords: Records;

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const file = (name: string) => {
  const bytes = world.files.get(name);
  if (!bytes) throw new Error(`no ${name}`);
  return bytes;
};

/** A published log checked for real, the way `readLog` does, against `replace`d stored files. */
async function checkedLog(w: World, replace: Record<string, Uint8Array | null> = {}, entries: Hex | null = w.entriesHex): Promise<Records['log']> {
  const stored = w.files.get('release-log.json');
  if (!stored) throw new Error('no log');
  const parsed = parseReleaseLog(stored);
  const list = approvedEntries(entries);
  const token = await checkRecordToken({
    exam: w.exam,
    examId,
    registry: registryAddress,
    bucket: storageBucket,
    trustedRoot: w.pki.root,
    token: text(w.files.get('release-token.jwt')),
    instancePublicKey: parsed.instancePublicKey,
  });
  return {
    kind: 'ready',
    verdict: await checkReleaseLog(parsed, examId, parsed.instancePublicKey),
    token,
    progress: list ? releaseProgress(holdersOf(list), parsed.entries.map((entry) => entry.passkeyPublicKey)) : null,
    files: await checkReleaseFiles(parsed, list, w.storage(replace)),
  };
}

/** Every record checked for real, against the fixture's own root in place of Google's. */
async function checkedRecords(): Promise<Records> {
  const { exam, build, pki } = world;
  const chain = { registryCode: registryMatches, exam, build, list: { listHash: build.approvedListHash }, criteria: world.criteriaHex, entries: world.entriesHex } as Records['chain'];
  const args = { exam, examId, registry: registryAddress, bucket: storageBucket, trustedRoot: pki.root };
  const list = approvedEntries(world.entriesHex);
  return {
    chain,
    token: { kind: 'ready', verdict: await checkPublishedToken({ ...args, token: world.token, build }), build, issuedAt: 1_800_000_000 },
    manifest: {
      kind: 'ready',
      report: checkManifest(file('manifest.json'), { examId, build, entries: list }),
      build,
      owners: Object.fromEntries((list ? holdersOf(list) : []).map((h) => [h.derivedPublicKey, h.owner])),
    },
    log: await checkedLog(world),
  };
}

const passingChecks: ProofChecks = {
  paperFile: 'pass',
  saltedHash: 'pass',
  examId: 'pass',
  selectedCount: 'pass',
  criteriaCount: 'pass',
  topics: 'pass',
  criteriaHash: 'pass',
};
const opened = (over: Partial<Extract<ProofState, { state: 'opened' }>> = {}): ProofRun => ({
  ok: true,
  result: { state: 'opened', checks: passingChecks, paper: { examId, questions: [{ topic: 'Maths', text: 'Q' }] }, ...over },
});

const fresh = (trusted: boolean): LiveReport['fresh'] => ({
  ok: true,
  value: {
    trusted,
    signature: trusted ? { ok: true } : { ok: false, error: new Error('not Google') },
    instanceKey: { ok: true },
    claims: [],
    instancePublicKey: `0x04${'dd'.repeat(64)}`,
  } as unknown as FreshVerdict,
});

const liveReport = (trusted: boolean, stage = 'submit'): LiveReport => ({
  fresh: fresh(trusted),
  status: { ok: true, value: { stage, questionCount: 0, release: { released: [], required: 8 } } as never },
  progress: null,
  log: null,
});

interface Scene {
  round?: number;
  chain?: Partial<Records['chain']>;
  records?: Partial<Records>;
  live?: LiveReport;
  arkiv?: View['arkiv'];
  proof?: ProofRun;
}

function sceneView({ round = LOCK - 1, chain, records, live, arkiv, proof }: Scene = {}): View {
  const value = { ...fullRecords, ...records, chain: { ...fullRecords.chain, ...chain } };
  return {
    examId,
    invalidLink: false,
    sources: { chain: true, storage: true, tee: live !== undefined, arkiv: arkiv !== undefined },
    records: { state: 'ready', value, readAt: 0 },
    live: live ? { state: 'ready', value: live, readAt: 0 } : { state: 'off' },
    arkiv: arkiv ?? { state: 'off' },
    latest: { round, error: null },
    now: roundTimeSeconds(round),
    proof: proof ?? null,
    timeZone: 'UTC',
  };
}

const scene = (over: Scene = {}): Custody => custody(sceneView(over));

const step = (result: Custody, id: StepId): CustodyStep => {
  const found = result.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};
const states = (result: Custody) => result.steps.map((s) => s.state);
const checks = (s: CustodyStep) => s.items.filter((item): item is Extract<Item, { kind: 'check' }> => item.kind === 'check');

/** Nothing has happened on the chain beyond what each scene adds back. */
const noBuild = { build: null };
const notReadyFiles: Partial<Records> = {
  token: { kind: 'neutral', message: 'no token' },
  manifest: { kind: 'neutral', message: 'no manifest' },
  log: { kind: 'neutral', message: 'no log' },
};
const beforeBuild: Scene = { chain: noBuild, records: notReadyFiles };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  world = await buildWorld({ endRound: END });
  fullRecords = await checkedRecords();
}, 30_000);

describe('the whole chain', () => {
  it('a finished exam is done from end to end, with an open seal and the paper', () => {
    const result = scene({ round: END, proof: opened() });
    expect(states(result)).toEqual(Array(7).fill('done'));
    expect(result.failures).toEqual([]);
    expect(result.seal).toBe('open');
    expect(result.paper?.questions).toHaveLength(1);
    expect(result.verdict).toBe('Every step has been checked. Nothing failed.');
  });

  it('never has more than one current step', () => {
    for (const s of [scene(beforeBuild), scene({ chain: { exam: null, list: null, build: null, criteria: null, entries: null } }), scene({ round: UNLOCK })]) {
      expect(states(s).filter((state) => state === 'current').length).toBeLessThanOrEqual(1);
    }
  });

  it('says where the exam is in one plain sentence, with the time and how long', () => {
    const round = UNLOCK - 280;
    const inMinutes = scene({ round, records: { log: { kind: 'neutral', message: 'no log' } } });
    const at = clockTime(roundTimeSeconds(UNLOCK), roundTimeSeconds(round), 'UTC');
    expect(inMinutes.headline).toBe(`The paper is sealed. It unlocks for centres at ${at}, in 14 minutes.`);
    expect(inMinutes.next.length).toBeGreaterThan(0);
  });

  it('every Fail row reaches the top of the page and fails its step', () => {
    const report = fullRecords.manifest.kind === 'ready' ? fullRecords.manifest : null;
    if (!report || report.report.kind !== 'parsed') throw new Error('no manifest');
    const result = scene({ records: { manifest: { ...report, report: { ...report.report, hashCheck: 'fail' } } } });
    expect(step(result, 'sealed').state).toBe('failed');
    expect(result.failures).toEqual([{ step: 5, label: 'Paper built and sealed', message: 'The published files are not the ones recorded for this paper.' }]);
    expect(result.next).toMatch(/Contact your exam board/);
    expect(result.verdict).toMatch(/One check failed/);
  });

  it('a source that gives no answer is neutral: no Pass, no failure and no finished step', () => {
    const result = scene({ records: { manifest: { kind: 'unavailable', message: 'Storage returned 500' } } });
    expect(step(result, 'sealed').state).toBe('current');
    expect(result.failures).toEqual([]);
    expect(checks(step(result, 'sealed')).find((c) => c.label === 'Storage manifest')).toMatchObject({ status: 'not-checked' });
    expect(result.verdict).toMatch(/could not be read/);
  });
});

describe('a Build with no files to check it against', () => {
  it('does not call the questions locked, and does not say everything is fine', () => {
    const result = scene({
      records: {
        token: { kind: 'unavailable', message: 'Storage returned 404' },
        manifest: { kind: 'unavailable', message: 'Storage returned 404' },
      },
    });
    expect(step(result, 'locked').state).not.toBe('done');
    expect(step(result, 'locked').state).not.toBe('failed');
    expect(step(result, 'locked').note).toMatch(/not confirmed/);
    expect(step(result, 'sealed').state).not.toBe('done');
    expect(result.failures).toEqual([]);
    expect(result.verdict).toMatch(/not confirmed/);
    expect(result.verdict).not.toMatch(/on track/);
  });
});

describe('step 1, exam published', () => {
  it('done', () => {
    const s = step(scene(), 'published');
    expect(s.state).toBe('done');
    expect(s.items).toContainEqual(expect.objectContaining({ label: 'Software image', value: world.exam.imageDigest }));
    expect(s.items).toContainEqual(expect.objectContaining({ label: 'Software version, the commit it was built from', value: world.exam.commitHash }));
    expect(s.round).toBe(null);
  });

  it('current, and nothing passes, when the exam is not published', () => {
    const result = scene({ chain: { exam: null, list: null, build: null, criteria: null, entries: null }, records: notReadyFiles });
    expect(step(result, 'published').state).toBe('current');
    // The address itself is checked, but nothing about an exam.
    expect(result.steps.flatMap(checks).filter((c) => c.status === 'pass').map((c) => c.label)).toEqual(['The exam record runs the published ExamRegistry code']);
    expect(result.headline).toBe('This exam is not on the public record.');
    expect(result.seal).toBe(null);
  });
});

describe('the code at the registry address', () => {
  const nothing = { exam: null, list: null, build: null, criteria: null, entries: null };

  it('passes, and shows the board its code holds', () => {
    const result = scene();
    const published = step(result, 'published');
    expect(published.items).toContainEqual(expect.objectContaining({ kind: 'check', label: 'The exam record runs the published ExamRegistry code', status: 'pass' }));
    expect(published.items).toContainEqual(expect.objectContaining({ kind: 'hash', value: boardAddress }));
    expect(published.aside).toContain(boardAddress);
  });

  it.each([
    ['different', 'not a Paper Seal exam record'],
    ['none', 'no exam record at this address'],
  ] as const)('fails the first step and holds the rest when it is %s', (state, words) => {
    const result = scene({ chain: { ...nothing, registryCode: { state } }, records: notReadyFiles });
    expect(step(result, 'published').state).toBe('failed');
    expect(result.failures.map((failure) => failure.message).join()).toContain(words);
    expect(result.headline).toBe('This is not a Paper Seal exam record.');
    expect(result.verdict).toContain('Do not rely on this exam');
    expect(result.steps.slice(1).every((one) => one.state === 'waiting')).toBe(true);
    expect(result.seal).toBeNull();
  });
});

describe('how the public record is read', () => {
  it('shows chain.readBlock with the setting beside it', () => {
    const rows = step(scene(), 'attested').items;
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'tag', label: { code: 'chain.readBlock' }, tag: chainSpec.readBlock }));
  });
});

describe('schedule bounds', () => {
  it('fail the first step', () => {
    const { settings } = world.exam;
    const long = scene({ chain: { exam: { ...world.exam, settings: { ...settings, delta: 86_401n } } } });
    expect(step(long, 'published').state).toBe('failed');
    expect(long.failures.map((failure) => failure.message)).toContain('The paper reaches centres too long before the exam. Paper Seal does not allow a gap this long.');
    const never = scene({ chain: { exam: { ...world.exam, settings: { ...settings, endRound: 2n ** 64n - 1n } } } });
    expect(never.failures.map((failure) => failure.message)).toContain('This exam ends too long after it starts, so the paper may never open to everyone.');
    expect(step(never, 'published').items).toContainEqual(expect.objectContaining({ value: expect.stringContaining('too far away') }));
  });

  it('pass for an exam inside them', () => {
    expect(step(scene(), 'published').items).toContainEqual(expect.objectContaining({ label: 'Exam times are within the allowed limits', status: 'pass' }));
  });
});

describe('a Build posted after the unlock time', () => {
  const unlockAt = () => roundTimeSeconds(Number(world.exam.settings.unlockRound));
  const posted = (postedAt: number) => scene({ chain: { build: { ...world.build, postedAt: BigInt(postedAt) } as Build } });
  const sealedAt = (builtRound: bigint, postedAt = 1) =>
    scene({ chain: { build: { ...world.build, builtRound, postedAt: BigInt(postedAt) } as Build } });

  it('warns that it was sealed in time and posted late, and fails nothing', () => {
    const on = posted(unlockAt());
    expect(on.warnings).toEqual([]);
    const late = posted(unlockAt() + 1);
    expect(late.warnings).toEqual([expect.stringContaining('sealed in time but recorded after its unlock time')]);
    expect(late.failures).toEqual(on.failures);
    expect(step(late, 'sealed').state).toBe(step(on, 'sealed').state);
    expect(step(late, 'sealed').items).toContainEqual(expect.objectContaining({ kind: 'text', tone: 'warn' }));
  });

  it('shows when it was sealed, with the round', () => {
    const items = step(scene(), 'sealed').items;
    expect(items).toContainEqual(expect.objectContaining({ kind: 'fact', label: 'Sealed' }));
    expect(items).toContainEqual(expect.objectContaining({ label: expect.stringContaining('Paper sealed, round 150') }));
    expect(items).toContainEqual(expect.objectContaining({ label: 'Sealed after questions closed', status: 'pass' }));
    expect(scene().warnings).toEqual([]);
  });

  it('fails a Build sealed before the lock round', () => {
    const early = sealedAt(world.exam.settings.lockRound - 1n);
    expect(step(early, 'sealed').state).toBe('failed');
    expect(early.failures).toEqual([expect.objectContaining({ message: expect.stringContaining('sealed before questions closed') })]);
    expect(step(sealedAt(world.exam.settings.lockRound), 'sealed').state).toBe('done');
  });

  it('gives a stronger warning for a Build sealed at or after the unlock round, and not the late one', () => {
    for (const round of [world.exam.settings.unlockRound, world.exam.settings.unlockRound + 5n]) {
      const result = sealedAt(round, unlockAt() + 100);
      expect(result.warnings).toEqual([expect.stringContaining('at or after the unlock time')]);
      expect(result.failures).toEqual(scene().failures);
    }
  });
});

describe('step 2, the sealed machine', () => {
  it('done from the published proof', () => {
    const s = step(scene(), 'attested');
    expect(s.state).toBe('done');
    expect(s.at).toBe(1_800_000_000);
  });

  it('waiting before the paper exists, and not holding up the steps after it', () => {
    const result = scene(beforeBuild);
    expect(step(result, 'attested').state).toBe('waiting');
    expect(step(result, 'locked').state).toBe('current');
  });

  it('done from a trusted live check before the Build, but not after it', () => {
    expect(step(scene({ ...beforeBuild, live: liveReport(true) }), 'attested').state).toBe('done');
    const missing = scene({ records: { token: { kind: 'neutral', message: 'no token' } }, live: liveReport(true) });
    expect(step(missing, 'attested').state).toBe('current');
  });

  it('failed when a claim does not match, naming the claim', () => {
    const token = fullRecords.token;
    if (token.kind !== 'ready') throw new Error('no token');
    const claims = [...token.verdict.claims];
    claims[0] = { claim: 'image_digest', ok: false, actual: 'sha256:aa', expected: 'sha256:bb' } as (typeof claims)[0];
    const result = scene({ records: { token: { ...token, verdict: { ...token.verdict, verified: false, claims } } } });
    expect(step(result, 'attested').state).toBe('failed');
    expect(result.failures[0]?.message).toMatch(/does not match what was published/);
    expect(step(result, 'attested').items).toContainEqual(expect.objectContaining({ label: { code: 'image_digest' }, status: 'fail', detail: expect.stringContaining('sha256:bb') }));
  });

  it('failed when the live machine fails its check, and neutral when it cannot be reached', () => {
    expect(step(scene({ ...beforeBuild, live: liveReport(false) }), 'attested').state).toBe('failed');
    const unreachable: LiveReport = { ...liveReport(true), fresh: { ok: false, message: 'fetch failed' } };
    const result = scene({ ...beforeBuild, live: unreachable });
    expect(step(result, 'attested').state).toBe('waiting');
    expect(result.failures).toEqual([]);
  });

  it('warns about demo mode and fills in the rebuild command', () => {
    const s = step(scene(), 'attested');
    expect(s.note).toMatch(/security keys are simulated/);
    expect(s.items).toContainEqual({
      kind: 'code',
      text: expect.stringMatching(new RegExp(`repro.yml .*-f commit=${world.exam.commitHash.slice(2)} -f expected_digest=sha256:${world.exam.imageDigest.slice(2)}`)) as string,
    });
  });
});

describe('step 3, people approved', () => {
  it('done, with setters shown only by their hash', () => {
    const s = step(scene(), 'people');
    expect(s.state).toBe('done');
    expect(s.note).toBe('12 people approved: 1 setter, 3 key holders and 8 centres.');
    expect(s.items.filter((item) => item.kind === 'hash' && item.label === 'Setter')).toHaveLength(1);
  });

  it('current when no list is posted', () => {
    const result = scene({ chain: { list: null, entries: null, build: null }, records: notReadyFiles });
    expect(step(result, 'people').state).toBe('current');
    expect(result.headline).toBe('Setting up. The list of approved people is not published yet.');
  });

  it('neutral when the list is posted but cannot be read', () => {
    const result = scene({ chain: { entries: null, problems: { list: { kind: 'unreadable', message: 'no event' } } } });
    expect(step(result, 'people').state).toBe('current');
    expect(result.failures).toEqual([]);
  });

  it('failed when the bytes do not match the stored hash', () => {
    const result = scene({ chain: { entries: null, problems: { list: { kind: 'mismatch', message: 'bytes differ' } } } });
    expect(step(result, 'people').state).toBe('failed');
  });

  it('failed when the list hash on the chain differs', () => {
    const result = scene({ chain: { list: { listHash: `0x${'00'.repeat(32)}` } as never } });
    expect(step(result, 'people').state).toBe('failed');
  });

  it("failed when the Build's list is not the published list", () => {
    const result = scene({ chain: { build: { ...world.build, approvedListHash: `0x${'00'.repeat(32)}` } as Build } });
    expect(step(result, 'people').state).toBe('failed');
    expect(result.failures[0]?.message).toMatch(/different list of approved people/);
  });
});

describe('step 4, questions locked', () => {
  it('done once the Build gives the bank size', () => {
    const s = step(scene(), 'locked');
    expect(s.state).toBe('done');
    expect(s.note).toBe('3 questions chosen from a question bank of 30.');
    expect(s.round).toBe(LOCK);
  });

  it('current before the lock round, saying when', () => {
    const result = scene(beforeBuild);
    expect(step(result, 'locked').state).toBe('current');
    expect(step(result, 'locked').note).toMatch(/Setters can send questions until/);
    expect(result.headline).toMatch(/^Questions are coming in. They close at/);
  });

  it('never claims the lock happened until the Build shows it', () => {
    const result = scene({ ...beforeBuild, round: LOCK });
    expect(step(result, 'locked').state).toBe('current');
    expect(step(result, 'locked').note).toMatch(/Questions have closed/);
  });

  it('failed when the criteria do not match the exam', () => {
    const exam = { ...world.exam, settings: { ...world.exam.settings, criteriaHash: `0x${'00'.repeat(32)}` } } as typeof world.exam;
    const result = scene({ chain: { exam } });
    expect(step(result, 'locked').state).toBe('failed');
  });

  it('failed when a trusted machine reports the exam failed, and not on its unverified word', () => {
    const trusted = scene({ ...beforeBuild, round: LOCK, live: liveReport(true, 'failed') });
    expect(step(trusted, 'locked').state).toBe('failed');
    expect(trusted.failures[0]?.message).toMatch(/cannot go ahead/);
    const unverified = scene({ ...beforeBuild, round: LOCK, live: { ...liveReport(false, 'failed'), fresh: { ok: false, message: 'down' } } });
    expect(step(unverified, 'locked').state).toBe('current');
  });
});

describe('step 5, paper built and sealed', () => {
  it('done, and only then does the seal show', () => {
    const result = scene();
    expect(step(result, 'sealed').state).toBe('done');
    expect(result.seal).toBe('sealed');
  });

  it('waiting behind an earlier step, with no seal', () => {
    const result = scene(beforeBuild);
    expect(step(result, 'sealed').state).toBe('waiting');
    expect(result.seal).toBe(null);
    expect(result.noSeal).toBe('Not sealed yet');
  });

  it('current with the Build posted but the manifest unread, and the seal is not assumed', () => {
    const result = scene({ records: { manifest: { kind: 'neutral', message: 'no manifest' } } });
    expect(step(result, 'sealed').state).toBe('current');
    expect(result.seal).toBe(null);
    expect(result.noSeal).toBe('Not confirmed yet');
    expect(result.headline).toBe('The paper is published. Its checks are not finished.');
  });

  it('does not check the Build signature without the token', () => {
    const result = scene({ records: { token: { kind: 'neutral', message: 'no token' } } });
    const row = checks(step(result, 'sealed')).find((c) => c.label === "Build signed by the token's instance key");
    expect(row).toMatchObject({ status: 'not-checked' });
    expect(step(result, 'sealed').state).not.toBe('done');
  });

  it('failed when the Build signature does not verify, in steps 2 and 5', () => {
    const token = fullRecords.token;
    if (token.kind !== 'ready') throw new Error('no token');
    const bad = { ...token.verdict, verified: false, build: { ok: false, error: 'bad signature' } };
    const result = scene({ records: { token: { ...token, verdict: bad } } });
    expect(step(result, 'sealed').state).toBe('failed');
    expect(step(result, 'attested').state).toBe('failed');
    expect(result.seal).toBe(null);
    expect(result.headline).toBe('The paper is published, but it failed its checks.');
  });

  it('shows no seal and does not say sealed when an earlier step failed', () => {
    const token = fullRecords.token;
    if (token.kind !== 'ready') throw new Error('no token');
    const signature = { ok: false as const, error: new Error('not Google') } as typeof token.verdict.signature;
    const result = scene({ records: { token: { ...token, verdict: { ...token.verdict, verified: false, signature } } } });
    expect(step(result, 'attested').state).toBe('failed');
    expect(result.seal).toBe(null);
    expect(result.noSeal).toBe('Not confirmed yet');
    expect(result.headline).toBe('The paper is published, but it failed its checks.');
  });

  it('failed when a file is addressed to someone not on the list', () => {
    const manifest = fullRecords.manifest;
    if (manifest.kind !== 'ready' || manifest.report.kind !== 'parsed') throw new Error('no manifest');
    const files = manifest.report.files.map((f) => (f.recipient ? { ...f, recipientOnList: 'fail' as const } : f));
    const result = scene({ records: { manifest: { ...manifest, report: { ...manifest.report, files } } } });
    expect(step(result, 'sealed').state).toBe('failed');
  });

  it('failed on a malformed manifest', () => {
    const manifest = fullRecords.manifest;
    if (manifest.kind !== 'ready') throw new Error('no manifest');
    const report = { kind: 'malformed' as const, hash: `0x${'00'.repeat(32)}` as Hex, hashCheck: 'pass' as const, error: 'not JSON' };
    expect(step(scene({ records: { manifest: { ...manifest, report } } }), 'sealed').state).toBe('failed');
  });
});

describe('step 6, unlock', () => {
  it('waiting before the unlock round, with the live countdown in its evidence', () => {
    const s = step(scene({ records: { log: { kind: 'neutral', message: 'no log' } } }), 'unlock');
    expect(s.state).toBe('current');
    expect(s.note).toMatch(/^Opens to centres at/);
    expect(s.items).toContainEqual(expect.objectContaining({ kind: 'countdown', round: UNLOCK }));
  });

  it('current after the unlock round, with the seal opening', () => {
    const result = scene({ round: UNLOCK, records: { log: { kind: 'neutral', message: 'no log' } } });
    expect(step(result, 'unlock').state).toBe('current');
    expect(result.seal).toBe('opening');
    expect(result.headline).toMatch(/^Unlocking for centres/);
  });

  it('done with a verified log and enough holders', () => {
    const result = scene({ round: UNLOCK + 1 });
    expect(step(result, 'unlock').state).toBe('done');
    expect(step(result, 'unlock').note).toBe('8 of the 8 needed key holders have released.');
    expect(result.headline).toMatch(/^Key holders have released their parts. The paper opens to everyone at/);
  });

  it('is not done, and says not verified, when the release token is not there', () => {
    const log = fullRecords.log;
    if (log.kind !== 'ready') throw new Error('no log');
    const result = scene({ round: UNLOCK + 1, records: { log: { ...log, token: null, verdict: { ...log.verdict, signature: 'absent' } } } });
    expect(step(result, 'unlock').state).toBe('current');
    expect(step(result, 'unlock').note).toMatch(/not verified/);
    const rows = step(result, 'unlock').items.filter((item) => item.kind === 'tag' && item.tag === 'Released');
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row).toMatchObject({ tone: 'neutral' });
  });

  it('failed when the release token does not verify', () => {
    const log = fullRecords.log;
    if (log.kind !== 'ready' || !log.token) throw new Error('no log');
    const token = { ...log.token, verified: false, claims: [{ claim: 'eat_nonce', ok: false, actual: 'a', expected: 'b' } as never] };
    const result = scene({ round: UNLOCK + 1, records: { log: { ...log, token } } });
    expect(step(result, 'unlock').state).toBe('failed');
    expect(result.failures[0]?.message).toMatch(/does not pass/);
    expect(step(result, 'unlock').items).toContainEqual(expect.objectContaining({ status: 'fail', detail: expect.stringContaining('eat_nonce') }));
  });

  it('failed on a malformed log', () => {
    const result = scene({ round: UNLOCK, records: { log: { kind: 'malformed', message: 'not JSON' } } });
    expect(step(result, 'unlock').state).toBe('failed');
  });

  it('failed when a verified release comes from a key not on the list, and neutral until it is verified', () => {
    const log = fullRecords.log;
    if (log.kind !== 'ready' || !log.progress) throw new Error('no log');
    const progress = { ...log.progress, unknown: [`0x04${'ee'.repeat(64)}` as Hex] };
    expect(step(scene({ round: UNLOCK, records: { log: { ...log, progress } } }), 'unlock').state).toBe('failed');
    const unverified = { ...log, progress, token: null };
    expect(step(scene({ round: UNLOCK, records: { log: unverified } }), 'unlock').failures).toEqual([]);
  });

  it('labels what the live machine says, and does not treat it as evidence until it passes', () => {
    const list = approvedEntries(world.entriesHex);
    const keys = holdersOf(list ?? []).slice(0, 3).map((h) => h.passkeyPublicKey);
    const progress = releaseProgress(holdersOf(list ?? []), keys);
    const said = { ...liveReport(false), fresh: { ok: false as const, message: 'down' }, progress };
    const s = step(scene({ round: UNLOCK, records: { log: { kind: 'neutral', message: 'no log' } }, live: said }), 'unlock');
    expect(s.items).toContainEqual({ kind: 'heading', text: 'Live from the machine, optional' });
    expect(s.items).toContainEqual(expect.objectContaining({ label: 'Key holders released', value: '3 of 8 needed (not verified)' }));
    expect(s.note).toMatch(/may have released/);
    const known = step(scene({ round: UNLOCK, records: { log: { kind: 'neutral', message: 'no log' } }, live: { ...liveReport(true), progress } }), 'unlock');
    expect(known.note).toBe('Unlocked. 3 of the 8 needed key holders have released.');
  });

  it('not applicable when no paper was sealed', () => {
    const result = scene({ ...beforeBuild, round: END });
    expect(step(result, 'unlock').state).toBe('not-applicable');
  });

  it('not applicable when the unlock never happened', () => {
    const proof: ProofRun = { ok: true, result: { state: 'sealed' } };
    const result = scene({ round: END, records: { log: { kind: 'neutral', message: 'no log' } }, proof });
    expect(step(result, 'unlock').state).toBe('not-applicable');
  });
});

describe('step 6, the copy on Arkiv', () => {
  const noLog = { log: { kind: 'neutral' as const, message: 'no log' } };
  const entityKey: Hex = `0x${'0e'.repeat(32)}`;
  const writer: Hex = '0x1111111111111111111111111111111111111111';
  const down = (): LiveReport => ({ ...liveReport(true), fresh: { ok: false, message: 'fetch failed' }, status: { ok: false, message: 'fetch failed' } });
  const progressOf = (count: number) => {
    const holders = holdersOf(approvedEntries(world.entriesHex) ?? []);
    return releaseProgress(holders, world.releaseLog.entries.slice(0, count).map((e) => e.passkeyPublicKey));
  };
  const report = (
    count: number | null,
    ageSeconds: number | null = 30,
    over: Partial<ArkivReport> = {},
  ): View['arkiv'] => {
    const newestAt = ageSeconds === null ? null : roundTimeSeconds(UNLOCK) - ageSeconds;
    return {
      state: 'ready',
      readAt: 0,
      value: {
        writers: [writer],
        read: { logs: count === null ? 0 : 1, tokens: 1, heartbeats: 0 },
        log:
          count === null
            ? null
            : {
                entityKey,
                creator: writer,
                createdAtBlock: 1n,
                writtenAt: newestAt ?? 0,
                entries: count,
                instancePublicKey: world.releaseLog.instancePublicKey,
                verdict: { examId: 'pass', entriesHash: 'pass', filesHash: 'pass', signature: 'pass' },
                progress: progressOf(count),
              },
        ignored: { tokens: 0, unreadable: 0, unattested: 0, failed: 0 },
        heartbeat: null,
        newestAt,
        ageSeconds,
        ...over,
      },
    };
  };

  it('keeps showing progress from Arkiv when the live machine cannot be reached', () => {
    const s = step(scene({ round: UNLOCK, records: noLog, live: down(), arkiv: report(5) }), 'unlock');
    expect(s.state).toBe('current');
    expect(s.failures).toEqual([]);
    expect(s.note).toBe('Unlocked. 5 of the 8 needed key holders have released.');
    expect(s.aside).toMatch(/^Read from the copy on Arkiv/);
    expect(s.items).toContainEqual({ kind: 'fact', label: 'Progress shown is from', value: 'The copy on Arkiv' });
    expect(s.items).toContainEqual({ kind: 'hash', label: 'Entity key of the log shown', value: entityKey });
    expect(s.items).toContainEqual(expect.objectContaining({ kind: 'link', href: `https://rabdi.explorer.arkiv.network/entity/${entityKey}` }));
    expect(s.items).toContainEqual({ kind: 'fact', label: 'Writers read', value: writer });
    expect(s.items).toContainEqual(expect.objectContaining({ status: 'pass', label: 'Release log signed by a key a passing release token attests' }));
    expect(s.items).toContainEqual({ kind: 'fact', label: 'Rows ignored', value: 'None' });
    const released = s.items.filter((item) => item.kind === 'tag' && item.tag === 'Released');
    expect(released).toHaveLength(5);
    for (const item of released) expect(item).toMatchObject({ tone: 'ok' });
  });

  it('is done when the Arkiv log shows enough key holders', () => {
    const s = step(scene({ round: UNLOCK, records: noLog, arkiv: report(8) }), 'unlock');
    expect(s.state).toBe('done');
    expect(s.note).toBe('8 of the 8 needed key holders have released.');
  });

  it('shows whichever verified source has more releases, and says which', () => {
    const live = { ...liveReport(true), progress: progressOf(3) };
    const arkivWins = step(scene({ round: UNLOCK, records: noLog, live, arkiv: report(5) }), 'unlock');
    expect(arkivWins.note).toBe('Unlocked. 5 of the 8 needed key holders have released.');
    expect(arkivWins.aside).toMatch(/copy on Arkiv/);
    const teeWins = step(scene({ round: UNLOCK, records: noLog, live: { ...live, progress: progressOf(6) }, arkiv: report(5) }), 'unlock');
    expect(teeWins.note).toBe('Unlocked. 6 of the 8 needed key holders have released.');
    expect(teeWins.aside).toMatch(/live machine/);
    expect(teeWins.items).toContainEqual({ kind: 'fact', label: 'Progress shown is from', value: 'The live machine' });
  });

  it('never counts rows that did not verify, and says how many were ignored', () => {
    const ignored = { tokens: 1, unreadable: 0, unattested: 2, failed: 0 };
    const s = step(scene({ round: UNLOCK, records: noLog, arkiv: report(null, undefined, { ignored, read: { logs: 2, tokens: 1, heartbeats: 0 } }) }), 'unlock');
    expect(s.note).toBe('Unlocked. No release has been verified yet.');
    expect(s.failures).toEqual([]);
    expect(s.aside).toBeUndefined();
    expect(s.items).toContainEqual({
      kind: 'fact',
      label: 'Rows ignored',
      value: '1 release token that did not pass the check, 2 release logs not signed by a key a passing token attests',
    });
    expect(s.items).toContainEqual(expect.objectContaining({ label: 'Release log', status: 'not-checked', detail: 'No release log on Arkiv has passed its check yet' }));
  });

  it('warns when the copy stops updating while unlock is not over', () => {
    const stale = step(scene({ round: UNLOCK, records: noLog, arkiv: report(5, 600) }), 'unlock');
    expect(stale.items).toContainEqual({
      kind: 'text',
      tone: 'warn',
      text: 'The Arkiv copy stopped updating 10 minutes ago. That does not mean no one has released since. This page keeps reading it.',
    });
    expect(stale.failures).toEqual([]);
    const fresh = step(scene({ round: UNLOCK, records: noLog, arkiv: report(5, 60) }), 'unlock');
    expect(fresh.items.some((item) => item.kind === 'text' && item.tone === 'warn')).toBe(false);
    const finished = step(scene({ round: UNLOCK, arkiv: report(5, 600) }), 'unlock');
    expect(finished.state).toBe('done');
    expect(finished.items.some((item) => item.kind === 'text' && /stopped updating/.test(item.text))).toBe(false);
  });

  const warnings = (s: CustodyStep) => s.items.filter((item) => item.kind === 'text' && item.tone === 'warn');

  it('judges the copy by its age in Arkiv blocks, never by this device\'s clock', () => {
    // The same report, read with this device's clock far ahead and far behind.
    for (const shift of [-86_400, 0, 86_400 * 365]) {
      const at = (age: number) => {
        const view = sceneView({ round: UNLOCK, records: noLog, arkiv: report(5, age) });
        return step(custody({ ...view, now: view.now + shift }), 'unlock');
      };
      expect(warnings(at(60))).toEqual([]);
      expect(warnings(at(600))).toHaveLength(1);
    }
  });

  it('shows the newest heartbeat, and a heartbeat never moves progress', () => {
    const heartbeat = { creator: writer, createdAtBlock: 9n, writtenAt: roundTimeSeconds(UNLOCK) - 10, stage: 'unlock' };
    const withBeat = step(scene({ round: UNLOCK, records: noLog, arkiv: report(5, 10, { heartbeat, read: { logs: 1, tokens: 1, heartbeats: 4 } }) }), 'unlock');
    const without = step(scene({ round: UNLOCK, records: noLog, arkiv: report(5, 10) }), 'unlock');
    expect(withBeat.note).toBe(without.note);
    expect(withBeat.state).toBe(without.state);
    expect(withBeat.failures).toEqual([]);
    expect(withBeat.items).toContainEqual({ kind: 'fact', label: 'Newest heartbeat written at', value: utcTime(heartbeat.writtenAt) });
    expect(withBeat.items).toContainEqual({ kind: 'fact', label: 'Stage the relay last read, as it says', value: 'unlock' });
    expect(withBeat.items).toContainEqual({ kind: 'fact', label: 'Rows read', value: '1 release log, 1 release token, 4 heartbeats' });
    // Only heartbeats and no verified log: still no progress.
    const onlyBeats = step(scene({ round: UNLOCK, records: noLog, arkiv: report(null, 10, { heartbeat }) }), 'unlock');
    expect(onlyBeats.note).toBe('Unlocked. No release has been verified yet.');
    expect(warnings(onlyBeats)).toEqual([]);
  });

  it('says so when no relay has written since unlock opened, only while unlock is open', () => {
    const silent = report(null, null);
    const open = step(scene({ round: UNLOCK, records: noLog, arkiv: silent }), 'unlock');
    expect(open.items).toContainEqual({
      kind: 'text',
      tone: 'warn',
      text: 'No relay has written to Arkiv for this exam since unlock opened. That does not mean no one has released. This page keeps reading it.',
    });
    expect(open.failures).toEqual([]);
    const before = step(scene({ round: LOCK, records: noLog, arkiv: silent }), 'unlock');
    expect(warnings(before)).toEqual([]);
    const over = step(scene({ round: END, records: noLog, arkiv: silent }), 'unlock');
    expect(warnings(over)).toEqual([]);
    const done = step(scene({ round: UNLOCK, arkiv: silent }), 'unlock');
    expect(done.state).toBe('done');
    expect(warnings(done)).toEqual([]);
    const noWriters = step(scene({ round: UNLOCK, records: noLog }), 'unlock');
    expect(warnings(noWriters)).toEqual([]);
  });

  it('tags each writer with where it came from, and notes name entries that are not addresses', () => {
    const own: Hex = '0x2222222222222222222222222222222222222222';
    const built: Hex = '0x3333333333333333333333333333333333333333';
    const view = sceneView({ round: UNLOCK, records: noLog, arkiv: report(5, 10, { writers: [writer, own, built] }) });
    const s = step(
      custody({
        ...view,
        arkivWriters: [
          { address: writer, from: ['name', 'own'] },
          { address: own, from: ['own'] },
          { address: built, from: ['built'] },
        ],
        arkivWritersIgnored: ['nope', '0x12'],
      }),
      'unlock',
    );
    expect(s.items).toContainEqual({ kind: 'tag', label: 'Writer read', tone: 'neutral', tag: 'From the name and your own choice', value: writer });
    expect(s.items).toContainEqual({ kind: 'tag', label: 'Writer read', tone: 'neutral', tag: 'Your own choice', value: own });
    expect(s.items).toContainEqual({ kind: 'tag', label: 'Writer read', tone: 'neutral', tag: 'Built into this page', value: built });
    expect(s.items).toContainEqual({ kind: 'text', text: "The exam's name also lists nope, 0x12. They are not addresses, so this page does not read them." });
    expect(s.failures).toEqual([]);
  });

  it('is neutral when Arkiv cannot be read', () => {
    const s = step(scene({ round: UNLOCK, records: noLog, arkiv: { state: 'error', message: 'rate limited' } }), 'unlock');
    expect(s.state).toBe('current');
    expect(s.failures).toEqual([]);
    expect(s.items).toContainEqual({ kind: 'check', label: 'Copy on Arkiv', status: 'not-checked', detail: 'Could not be read: rate limited' });
  });

  it('says how to turn it on when no writers are set', () => {
    const s = step(scene({ round: UNLOCK, records: noLog }), 'unlock');
    expect(s.items).toContainEqual({ kind: 'heading', text: 'Copy on Arkiv, optional' });
    expect(s.items).toContainEqual({ kind: 'text', text: expect.stringMatching(/^Add who may write the copy on Arkiv/) });
  });
});

describe('step 7, exam ends and paper opens', () => {
  it('waiting behind an earlier step, saying when, and the proof has not run', () => {
    const s = step(scene(beforeBuild), 'open');
    expect(s.state).toBe('waiting');
    expect(s.note).toMatch(/^Opens to everyone at/);
    expect(s.round).toBe(END);
  });

  it('current once every earlier step is done, still before the end round', () => {
    const s = step(scene({ round: END - 1 }), 'open');
    expect(s.state).toBe('current');
    expect(s.note).toMatch(/^Opens to everyone at/);
  });

  it('current while the proof runs', () => {
    const result = scene({ round: END });
    expect(step(result, 'open').state).toBe('current');
    expect(step(result, 'open').note).toBe('Opening the paper.');
    expect(result.seal).toBe('opening');
  });

  it('done with all 7 checks passed', () => {
    const s = step(scene({ round: END, proof: opened() }), 'open');
    expect(s.state).toBe('done');
    expect(s.note).toBe('The paper is open to everyone. All 7 checks passed.');
    expect(checks(s).filter((c) => c.status === 'pass')).toHaveLength(7);
  });

  it('failed, with the paper withheld, when the paper is not the one committed to', () => {
    const result = scene({ round: END, proof: opened({ checks: { ...passingChecks, saltedHash: 'fail' }, paper: null }) });
    expect(step(result, 'open').state).toBe('failed');
    expect(result.paper).toBe(null);
    expect(result.withheld).toBe(true);
    expect(result.failures[0]?.message).toMatch(/not the paper recorded for this exam/);
  });

  it('is not done when a check could not run, and never counts it as a pass', () => {
    const s = step(scene({ round: END, proof: opened({ checks: { ...passingChecks, topics: 'absent' } }) }), 'open');
    expect(s.state).toBe('current');
    expect(checks(s).find((c) => c.status === 'not-checked')).toMatchObject({ detail: 'No criteria on the chain' });
  });

  it('failed when the paper will not open', () => {
    const proof: ProofRun = { ok: true, result: { state: 'failed', step: 'decrypt', message: 'bad key' } };
    const result = scene({ round: END, proof });
    expect(step(result, 'open').state).toBe('failed');
    expect(result.headline).toBe('The paper could not be opened.');
  });

  it('neutral when the proof could not read a file', () => {
    const result = scene({ round: END, proof: { ok: false, message: 'Storage returned 500' } });
    expect(step(result, 'open').state).toBe('current');
    expect(result.failures).toEqual([]);
  });

  it('not applicable when no copy of the key exists', () => {
    const result = scene({ round: END, records: { log: { kind: 'neutral', message: 'no log' } }, proof: { ok: true, result: { state: 'sealed' } } });
    expect(step(result, 'open').state).toBe('not-applicable');
    expect(result.headline).toBe('The paper stays sealed. It was never unlocked.');
    expect(result.seal).toBe('sealed');
  });

  it('not applicable when no paper was sealed', () => {
    const result = scene({ ...beforeBuild, round: END });
    expect(step(result, 'open').state).toBe('not-applicable');
    expect(result.headline).toBe('The exam ended and no paper was published.');
  });

  it("uses the public clock's round, not the device clock, once the round is known", () => {
    const base: View = {
      examId,
      invalidLink: false,
      sources: { chain: true, storage: true, tee: false, arkiv: false },
      records: { state: 'ready', value: fullRecords, readAt: 0 },
      live: { state: 'off' },
      arkiv: { state: 'off' },
      latest: { round: END - 1, error: null },
      now: roundTimeSeconds(END) + 600,
      proof: null,
    };
    expect(step(custody(base), 'open').note).toMatch(/^Opens to everyone at/);
    expect(step(custody({ ...base, latest: { round: null, error: 'down' } }), 'open').note).toBe('Opening the paper.');
  });
});

describe('key files listed in the signed log', () => {
  const unlocked = (records: Partial<Records>) => scene({ round: UNLOCK, records });
  const centreCopy = (w: World) => {
    const centre = w.entries.find((entry) => entry.role === 4);
    if (!centre) throw new Error('no centre');
    return { name: storageNames.centreKeyPriv(centre.derivedPublicKey), owner: centre.owner };
  };
  const failing = (result: Custody) => result.failures.map((failure) => failure.message);

  it('passes each file, names each centre, and only then finishes the step', async () => {
    const result = unlocked({ log: await checkedLog(world) });
    const s = step(result, 'unlock');
    expect(s.state).toBe('done');
    expect(result.failures).toEqual([]);
    const rows = checks(s).filter((c) => typeof c.label === 'object');
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.status === 'pass')).toBe(true);
    expect(rows.find((row) => row.detail === `recipient ${centreCopy(world).owner}`)).toBeTruthy();
    expect(checks(s).find((c) => c.label === 'filesHash matches the files')?.status).toBe('pass');
  });

  it('fails a swapped centre copy', async () => {
    const { name, owner } = centreCopy(world);
    const result = unlocked({ log: await checkedLog(world, { [name]: random(120) }) });
    expect(step(result, 'unlock').state).toBe('failed');
    expect(failing(result)).toEqual([`The copy of the key for ${owner} was changed after it was recorded.`]);
    expect(result.verdict).toMatch(/^One check failed/);
  });

  it('fails a centre copy missing from storage', async () => {
    const { name, owner } = centreCopy(world);
    const result = unlocked({ log: await checkedLog(world, { [name]: null }) });
    expect(step(result, 'unlock').state).toBe('failed');
    expect(failing(result)).toEqual([`The copy of the key for ${owner} was removed from the public files.`]);
  });

  it('fails a centre copy the signed log leaves out', async () => {
    // `key-priv.tlock` sorts first, so the second file is a centre's copy.
    const w = await buildWorld({ logFiles: (files) => files.filter((_, i) => i !== 1) });
    const result = unlocked({ log: await checkedLog(w) });
    expect(step(result, 'unlock').state).toBe('failed');
    expect(failing(result)).toHaveLength(1);
    expect(failing(result)[0]).toMatch(/^The copy of the key for .* is not in the signed log\.$/);
  });

  it('fails an extra file in the signed log, even one that is really stored', async () => {
    const stranger = `key-priv/${toHex(random(65))}.bin`;
    const w = await buildWorld({ logFiles: (files) => sortReleaseFiles([...files, { name: stranger, sha256: random(32) }]) });
    const result = unlocked({ log: await checkedLog(w) });
    expect(step(result, 'unlock').state).toBe('failed');
    expect(failing(result)).toEqual(['The signed log lists a copy of the key for someone who is not on the approved list.']);
  });

  it('fails a log at the threshold that lists no files', async () => {
    const w = await buildWorld({ logFiles: () => [] });
    const result = unlocked({ log: await checkedLog(w) });
    expect(step(result, 'unlock').state).toBe('failed');
    expect(failing(result)).toContain('The file that opens the paper is not in the signed log.');
  });

  it('fails a swapped key-priv.tlock', async () => {
    const result = unlocked({ log: await checkedLog(world, { [storageNames.keyPriv]: random(40) }) });
    expect(step(result, 'unlock').state).toBe('failed');
    expect(failing(result)).toEqual(['The file that opens the paper was changed after it was recorded.']);
  });

  it('is not a failure below the threshold, with no files listed, and never a pass', async () => {
    const w = await buildWorld({ unlocked: false });
    const result = unlocked({ log: await checkedLog(w) });
    const s = step(result, 'unlock');
    expect(result.failures).toEqual([]);
    expect(s.state).toBe('current');
    expect(checks(s).find((c) => c.label === 'Key files match the signed log')).toMatchObject({ status: 'not-checked', detail: expect.stringMatching(/^Not unlocked yet/) as string });
  });

  it('checks nothing against a log that has not passed, and does not finish', () => {
    const log = fullRecords.log;
    if (log.kind !== 'ready') throw new Error('expected a log');
    const s = step(unlocked({ log: { ...log, files: null } }), 'unlock');
    expect(s.state).toBe('current');
    expect(checks(s).find((c) => c.label === 'Key files match the signed log')?.status).toBe('not-checked');
  });

  it('is not a pass while a stored file can not be read', async () => {
    const { name } = centreCopy(world);
    const log = await checkedLog(world);
    if (log.kind !== 'ready' || !log.files) throw new Error('expected a report');
    const parsed = parseReleaseLog(file('release-log.json'));
    const flaky = { url: () => '', get: (n: string) => (n === name ? Promise.reject(new Error('error 500')) : world.storage().get(n)) };
    const report = await checkReleaseFiles(parsed, approvedEntries(world.entriesHex), flaky);
    const result = unlocked({ log: { ...log, files: report } });
    expect(report.check).toBe('absent');
    expect(result.failures).toEqual([]);
    expect(step(result, 'unlock').state).toBe('current');
  });

  it('can not pass with no approved list to compare names with', async () => {
    const log = await checkedLog(world, {}, null);
    if (log.kind !== 'ready') throw new Error('expected a log');
    expect(log.files?.names).toBe('absent');
    expect(log.files?.check).toBe('absent');
    expect(step(unlocked({ log }), 'unlock').state).toBe('current');
  });

  it('fails a list of files that does not match filesHash', async () => {
    const log = await checkedLog(world);
    if (log.kind !== 'ready') throw new Error('expected a log');
    const result = unlocked({ log: { ...log, verdict: { ...log.verdict, filesHash: 'fail' } } });
    expect(step(result, 'unlock').state).toBe('failed');
    expect(failing(result)).toEqual(['The list of key files has been changed after it was signed.']);
  });

  it('can not read as a pass once the paper is open', async () => {
    const { name } = centreCopy(world);
    const result = scene({ round: END, proof: opened(), records: { log: await checkedLog(world, { [name]: random(120) }) } });
    expect(step(result, 'open').state).toBe('done');
    expect(result.headline).toBe('The paper is open, but it did not pass every check.');
    expect(result.verdict).toMatch(/^One check failed/);
  });

  it('puts a removed key file at the top of the page, not only a paper that would not open', () => {
    const message = 'The file that opens the paper (key-priv.tlock) was removed from the public files after the unlock recorded it.';
    const result = scene({ round: END, proof: { ok: true, result: { state: 'failed', step: 'files', message } } });
    expect(step(result, 'open').state).toBe('failed');
    expect(failing(result)).toContain(message);
  });
});

describe('step 1 on a name route, the name', () => {
  const name = 'jee-main-2026.board.eth';
  const used = { teeUrl: '', storageUrl: 'https://files.example/bucket', bucket: 'bucket' };
  const passed: ExamNameResult = {
    ok: true,
    value: { name, label: 'jee-main-2026', parent: 'board.eth', examId, registry: registryAddress, board: `0x${'bb'.repeat(20)}`, teeUrl: null, storageUrl: 'https://files.example/bucket', bucket: null, arkivWriters: null, arkivWritersIgnored: [] },
  };
  const named = (result: NameView['result'], over: Scene = {}) =>
    custody({ ...sceneView(over), name: { name, result, used, configuredRegistry: '' } });

  describe('with a registry other than the one this page is set up to read', () => {
    const other = `0x${'cd'.repeat(20)}`;
    const set = (result: NameView['result'], configuredRegistry: string) => custody({ ...sceneView(), name: { name, result, used, configuredRegistry } });
    const ready: NameView['result'] = { state: 'ready', value: passed, readAt: 0 };

    it('warns on the main view, and keeps the Sepolia line', () => {
      const result = set(ready, other);
      expect(result.warnings).toEqual([expect.stringContaining('different exam record')]);
      expect(step(result, 'name').aside).toContain('Sepolia');
      expect(step(result, 'name').state).toBe('done');
      expect(step(result, 'name').items).toContainEqual(expect.objectContaining({ kind: 'hash', value: other }));
    });

    it('warns too when the name went on to fail', () => {
      const failed: ExamNameResult = { ok: false, failed: 'primaryName', reason: 'no', partial: { registry: registryAddress } };
      const result = set({ state: 'ready', value: failed, readAt: 0 }, other);
      expect(result.warnings).toHaveLength(1);
      expect(step(result, 'name').aside).toContain('Sepolia');
    });

    it('says nothing when they match in any case, or none is set', () => {
      expect(set(ready, registryAddress.toUpperCase().replace('0X', '0x')).warnings).toEqual([]);
      expect(set(ready, '').warnings).toEqual([]);
      expect(set({ state: 'loading' }, other).warnings).toEqual([]);
    });
  });

  it('passes first, and the exam then runs as usual', () => {
    const result = named({ state: 'ready', value: passed, readAt: 0 }, { round: END, proof: opened() });
    expect(result.steps.map((s) => s.id)).toEqual(['name', 'published', 'attested', 'people', 'locked', 'sealed', 'unlock', 'open']);
    expect(states(result)).toEqual(Array(8).fill('done'));
    expect(result.seal).toBe('open');
    expect(checks(step(result, 'name')).map((c) => [c.label, c.status])).toEqual([
      ['Exam name, a valid ENS label', 'pass'],
      ['Address record runs the ExamRegistry code for this board', 'pass'],
      ["Board's primary name", 'pass'],
      ['board.eth points back to the board, so verified both ways', 'pass'],
    ]);
    const tags = step(result, 'name').items.filter((item) => item.kind === 'tag');
    expect(tags.map((item) => item.kind === 'tag' && [item.label, item.tag])).toEqual([
      ['TEE URL', 'From your settings'],
      ['Storage URL', 'From the name'],
      ['Storage bucket', 'Built into this page'],
    ]);
    expect(step(result, 'name').aside).toMatch(/Sepolia/);
  });

  it.each([
    ['name', 'Not a valid name'],
    ['registry', 'No exam record'],
    ['primaryName', 'Not the board’s name'],
    ['forward', 'Not confirmed by the board'],
  ] as [ExamNameCheck, string][])('a failed %s check fails it, holds every later step and shows no seal', (check, title) => {
    const value: ExamNameResult = { ok: false, failed: check, reason: 'Because.', partial: { name } };
    const result = named({ state: 'ready', value, readAt: 0 }, { round: END, proof: opened() });
    expect(step(result, 'name').state).toBe('failed');
    expect(result.failures).toEqual([{ step: 1, label: 'Name', message: expect.stringMatching(new RegExp(`^${title}\\. `)) as string }]);
    expect(states(result).slice(1)).toEqual(Array(7).fill('waiting'));
    expect(result.steps.slice(1).flatMap(checks).filter((c) => c.status === 'pass')).toEqual([]);
    expect(result.headline).toBe('This name does not lead to a verified exam.');
    expect(result.paper).toBe(null);
    expect(result.seal).toBe(null);
  });

  it('counts its own step in the references that name a later one', () => {
    const live = liveReport(false);
    const text = (result: Custody) =>
      result.steps.flatMap((s) => s.items).flatMap((item) => (item.kind === 'text' ? [item.text] : []));
    const plain = custody(sceneView({ live }));
    const namedView = named({ state: 'ready', value: passed, readAt: 0 }, { live });
    expect(text(plain).filter((line) => line.includes('See step 2'))).not.toEqual([]);
    expect(text(namedView).filter((line) => line.includes('See step 3'))).not.toEqual([]);
    expect(text(namedView).filter((line) => line.includes('See step 2'))).toEqual([]);
  });

  it.each([
    ['not connected', { state: 'off' }, 'This page cannot read the public record yet.'],
    ['reading', { state: 'loading' }, 'Checking the exam name.'],
    ["can't read ENS", { state: 'error', message: 'RPC down' }, 'The exam name could not be read.'],
  ] as const)('%s is neutral, with no Pass and no seal', (_, polled, headline) => {
    const result = custody({ ...sceneView(), examId: null, records: { state: 'off' }, name: { name, result: polled, used, configuredRegistry: '' } });
    expect(result.headline).toBe(headline);
    expect(step(result, 'name').state).toBe('current');
    expect(result.failures).toEqual([]);
    expect(result.seal).toBe(null);
    expect(result.steps.flatMap(checks).filter((c) => c.status === 'pass')).toEqual([]);
  });
});

describe('before there is an exam to show', () => {
  const base: View = {
    examId: null,
    invalidLink: false,
    sources: { chain: false, storage: false, tee: false, arkiv: false },
    records: { state: 'off' },
    live: { state: 'off' },
    arkiv: { state: 'off' },
    latest: { round: null, error: null },
    now: 0,
    proof: null,
  };

  it.each([
    ['no exam', base, 'Choose an exam to check.'],
    ['a bad link', { ...base, invalidLink: true }, 'This link does not name an exam.'],
    ['no connection', { ...base, examId }, 'This page cannot read the public record yet.'],
    ['a first read', { ...base, examId, sources: { ...base.sources, chain: true }, records: { state: 'loading' } }, 'Reading the public record.'],
    ['a failed read', { ...base, examId, sources: { ...base.sources, chain: true }, records: { state: 'error', message: 'down' } }, 'The public record could not be read.'],
  ] as [string, View, string][])('%s says so, with no Pass', (_, view, headline) => {
    const result = custody(view);
    expect(result.headline).toBe(headline);
    expect(result.steps.flatMap(checks).filter((c) => c.status === 'pass')).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.seal).toBe(null);
  });
});

describe('words', () => {
  it.each([
    [0, 'any moment now'],
    [30, 'in under a minute'],
    [840, 'in 14 minutes'],
    [4800, 'in 1 hour 20 minutes'],
    [7200, 'in 2 hours'],
    [86_400 * 3, 'in 3 days'],
  ])('%i seconds is "%s"', (seconds, words) => {
    expect(inWords(seconds)).toBe(words);
  });

  it('adds the day only when it is not today', () => {
    const now = Date.UTC(2026, 10, 6, 12) / 1000;
    expect(clockTime(now + 3600, now, 'UTC')).toBe('13:00');
    expect(clockTime(now + 86_400, now, 'UTC')).toBe('Sat 7 Nov, 12:00');
  });
});

describe('repository', () => {
  it('defaults and can be overridden by a fork', () => {
    expect(repository({})).toBe('AbdulRashidReshamwala/paperseal');
    expect(repository({ VITE_RELEASES_REPO: ' me/fork ' })).toBe('me/fork');
    expect(() => repository({ VITE_RELEASES_REPO: 'bad repo' })).toThrow();
  });
});
