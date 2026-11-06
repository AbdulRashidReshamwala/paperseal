import type { ExamNameCheck, ExamNameResult } from '@paperseal/chain';
import { describe, expect, beforeAll, it, vi } from 'vitest';
import { roundTimeSeconds, type Hex } from '@paperseal/protocol';

import { checkPublishedToken, checkRecordToken, type Build, type FreshVerdict } from './attest';
import { approvedEntries, checkManifest, holdersOf } from './commitments';
import { clockTime, custody, inWords, repository, type Custody, type CustodyStep, type Item, type NameView, type StepId, type View } from './custody';
import { buildWorld, examId, registryAddress, type World } from './fixtures';
import type { LiveReport, ProofRun, Records } from './load';
import type { ProofChecks, ProofState } from './proof';
import { checkReleaseLog, parseReleaseLog, releaseProgress } from './unlock';

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

/** Every record checked for real, against the fixture's own root in place of Google's. */
async function checkedRecords(): Promise<Records> {
  const { exam, build, pki } = world;
  const chain = { exam, build, list: { listHash: build.approvedListHash }, criteria: world.criteriaHex, entries: world.entriesHex } as Records['chain'];
  const args = { exam, examId, registry: registryAddress, trustedRoot: pki.root };
  const list = approvedEntries(world.entriesHex);
  const parsed = parseReleaseLog(file('release-log.json'));
  const token = await checkRecordToken({ ...args, token: text(file('release-token.jwt')), instancePublicKey: parsed.instancePublicKey });
  return {
    chain,
    token: { kind: 'ready', verdict: await checkPublishedToken({ ...args, token: world.token, build }), build, issuedAt: 1_800_000_000 },
    manifest: {
      kind: 'ready',
      report: checkManifest(file('manifest.json'), { examId, build, entries: list }),
      build,
      owners: Object.fromEntries((list ? holdersOf(list) : []).map((h) => [h.derivedPublicKey, h.owner])),
    },
    log: {
      kind: 'ready',
      verdict: await checkReleaseLog(parsed, examId, parsed.instancePublicKey),
      token,
      progress: releaseProgress(holdersOf(list ?? []), parsed.entries.map((entry) => entry.passkeyPublicKey)),
    },
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
  proof?: ProofRun;
}

function sceneView({ round = LOCK - 1, chain, records, live, proof }: Scene = {}): View {
  const value = { ...fullRecords, ...records, chain: { ...fullRecords.chain, ...chain } };
  return {
    examId,
    invalidLink: false,
    sources: { chain: true, storage: true, tee: live !== undefined },
    records: { state: 'ready', value, readAt: 0 },
    live: live ? { state: 'ready', value: live, readAt: 0 } : { state: 'off' },
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
    expect(result.steps.flatMap(checks).filter((c) => c.status === 'pass')).toEqual([]);
    expect(result.headline).toBe('This exam is not on the public record.');
    expect(result.seal).toBe(null);
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
      sources: { chain: true, storage: true, tee: false },
      records: { state: 'ready', value: fullRecords, readAt: 0 },
      live: { state: 'off' },
      latest: { round: END - 1, error: null },
      now: roundTimeSeconds(END) + 600,
      proof: null,
    };
    expect(step(custody(base), 'open').note).toMatch(/^Opens to everyone at/);
    expect(step(custody({ ...base, latest: { round: null, error: 'down' } }), 'open').note).toBe('Opening the paper.');
  });
});

describe('step 1 on a name route, the name', () => {
  const name = 'jee-main-2026.board.eth';
  const used = { teeUrl: '', storageUrl: 'https://files.example/bucket', bucket: 'bucket' };
  const passed: ExamNameResult = {
    ok: true,
    value: { name, label: 'jee-main-2026', parent: 'board.eth', examId, registry: registryAddress, board: `0x${'bb'.repeat(20)}`, teeUrl: null, storageUrl: 'https://files.example/bucket', bucket: null },
  };
  const named = (result: NameView['result'], over: Scene = {}) =>
    custody({ ...sceneView(over), name: { name, result, used } });

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
      ['Live machine address, the TEE URL', 'Your own choice'],
      ['Where the public files are kept, the storage URL', 'From the name'],
      ['File store bucket', 'Built into this page'],
    ]);
    expect(step(result, 'name').aside).toMatch(/test network/);
  });

  it.each([
    ['name', 'Not a valid name'],
    ['registry', 'No registry'],
    ['primaryName', 'Primary name differs'],
    ['forward', 'Not verified both ways'],
  ] as [ExamNameCheck, string][])('a failed %s check fails it, holds every later step and shows no seal', (check, title) => {
    const value: ExamNameResult = { ok: false, failed: check, reason: 'Because.', partial: { name } };
    const result = named({ state: 'ready', value, readAt: 0 }, { round: END, proof: opened() });
    expect(step(result, 'name').state).toBe('failed');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ step: 1, label: 'Exam name' });
    // The plain sentence leads, and the reader's own reason stays in the folded detail.
    expect(result.failures[0]?.message).toMatch(new RegExp(`^${title}\\. \\w`));
    expect(result.failures[0]?.message).not.toContain('Because.');
    expect(checks(step(result, 'name')).find((c) => c.status === 'fail')?.detail).toBe('Because.');
    expect(states(result).slice(1)).toEqual(Array(7).fill('waiting'));
    expect(result.steps.slice(1).flatMap(checks).filter((c) => c.status === 'pass')).toEqual([]);
    expect(result.headline).toBe('This name does not lead to a verified exam.');
    expect(result.paper).toBe(null);
    expect(result.seal).toBe(null);
  });

  it.each([
    ['not connected', { state: 'off' }, 'This page cannot read the public record yet.'],
    ['reading', { state: 'loading' }, 'Checking the exam name.'],
    ["can't read ENS", { state: 'error', message: 'RPC down' }, 'The exam name could not be read.'],
  ] as const)('%s is neutral, with no Pass and no seal', (_, polled, headline) => {
    const result = custody({ ...sceneView(), examId: null, records: { state: 'off' }, name: { name, result: polled, used } });
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
    sources: { chain: false, storage: false, tee: false },
    records: { state: 'off' },
    live: { state: 'off' },
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
