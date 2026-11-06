import { encodeMessage, fromHex, storageNames, toHex, type Hex } from '@paperseal/protocol';
import { TeeApiError, type TeeClient } from '@paperseal/tee-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkBuildSignature, checkFreshToken, checkPublishedToken, checkRecordToken } from './attest';
import type { ChainData } from './checks';
import { checkManifest, approvedEntries, holdersOf } from './commitments';
import { buildWorld, p256, random, registryAddress, teeSign, examId, signToken, type World } from './fixtures';
import { loadLive, signedKeyPriv } from './load';
import { runProof } from './proof';
import { checkReleaseFiles, checkReleaseLog, expectedReleaseFiles, parseReleaseLog, releaseProgress } from './unlock';
import { createStorage } from './storage';


// The first proof test of a run loads tlock-js, which logs through console.log.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

let world: World;
const text = (bytes: Uint8Array | null | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array());
const getWorld = async () => (world ??= await buildWorld());

describe('storage', () => {
  it('reads <base>/<examId>/<name>, and treats only a 404 as missing', async () => {
    const send = vi.fn((url: string | URL | Request) =>
      Promise.resolve(
        String(url).endsWith('gone.bin')
          ? new Response('no', { status: 404 })
          : String(url).endsWith('broken.bin')
            ? new Response('no', { status: 500 })
            : new Response(new Uint8Array([1, 2, 3])),
      ),
    );
    const storage = createStorage('https://files.example/bucket/', examId, send as typeof fetch);
    expect(storage.url('shares/0x04.bin')).toBe(`https://files.example/bucket/${examId}/shares/0x04.bin`);
    expect(await storage.get('paper.bin')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await storage.get('gone.bin')).toBeNull();
    await expect(storage.get('broken.bin')).rejects.toThrow('500');
  });
});

describe('Build signature', () => {
  it('verifies under the Build instance key, and fails when any committed field changes', async () => {
    const { build } = await getWorld();
    expect((await checkBuildSignature(examId, build)).ok).toBe(true);
    expect((await checkBuildSignature(examId, { ...build, selected: build.selected + 1 })).ok).toBe(false);
    const other = await p256();
    expect((await checkBuildSignature(examId, { ...build, instancePublicKey: toHex(other.publicKey) })).ok).toBe(false);
  });
});

describe('published token', () => {
  const check = async (w: World, overrides: Partial<Parameters<typeof checkPublishedToken>[0]> = {}) =>
    checkPublishedToken({
      token: text(w.files.get('token.jwt')),
      exam: w.exam,
      build: w.build,
      examId,
      registry: registryAddress,
      trustedRoot: w.pki.root,
      ...overrides,
    });

  it('passes every check for a token from the chain of trust that matches the exam', async () => {
    const w = await getWorld();
    const verdict = await check(w);
    expect(verdict.signature).toEqual({ ok: true });
    expect(verdict.claims.filter((claim) => !claim.ok)).toEqual([]);
    expect(verdict.build.ok).toBe(true);
    expect(verdict.verified).toBe(true);
  });

  it('fails against Google’s real root, which this test chain does not lead to', async () => {
    const w = await getWorld();
    const verdict = await checkPublishedToken({
      token: text(w.files.get('token.jwt')),
      exam: w.exam,
      build: w.build,
      examId,
      registry: registryAddress,
    });
    expect(verdict.signature.ok).toBe(false);
    expect(verdict.verified).toBe(false);
  });

  it('fails the image digest claim when the chain records another digest', async () => {
    const w = await getWorld();
    const verdict = await check(w, { exam: { ...w.exam, imageDigest: `0x${'00'.repeat(32)}` } as typeof w.exam });
    expect(verdict.claims.find((c) => c.claim === 'image_digest')?.ok).toBe(false);
    expect(verdict.verified).toBe(false);
  });

  it('fails when the token binds a different instance key than the Build names', async () => {
    const w = await getWorld();
    const stranger = await p256();
    const verdict = await check(w, { build: { ...w.build, instancePublicKey: toHex(stranger.publicKey) } });
    expect(verdict.claims.find((c) => c.claim === 'eat_nonce')?.ok).toBe(false);
    expect(verdict.verified).toBe(false);
  });

  it('fails the settings claims when the chain settings differ from the arguments', async () => {
    const w = await getWorld();
    const exam = { ...w.exam, settings: { ...w.exam.settings, delta: 1n } } as typeof w.exam;
    expect((await check(w, { exam })).claims.find((c) => c.claim === 'args')?.ok).toBe(false);
  });

  it('reports a malformed token as a failure, not a crash', async () => {
    const w = await getWorld();
    const verdict = await check(w, { token: 'not a token' });
    expect(verdict.verified).toBe(false);
    expect(verdict.signature.ok).toBe(false);
  });

  it('does not enforce expiry on a record, but a fresh token does', async () => {
    const w = await getWorld();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({ ...w.claims, iat: now - 7200, exp: now - 3600 }, w.pki);
    expect((await check(w, { token })).claims.find((c) => c.claim === 'exp')?.ok).toBe(true);
    expect((await check(w, { token })).verified).toBe(true);
    const tee = {
      attestation: () =>
        Promise.resolve({
          token,
          instancePublicKey: w.build.instancePublicKey as Hex,
          encryptionPublicKey: toHex(new Uint8Array(65).fill(4)),
          instanceKeySignature: toHex(new Uint8Array(64)),
        }),
    };
    const fresh = await checkFreshToken({ tee: tee as never, exam: w.exam, examId, registry: registryAddress, trustedRoot: w.pki.root });
    expect(fresh.claims.find((c) => c.claim === 'exp')?.ok).toBe(false);
    expect(fresh.trusted).toBe(false);
  });
});

describe('fresh token', () => {
  it('is trusted only when the instance key also signs the encryption key', async () => {
    const w = await getWorld();
    const encryption = await p256();
    const good = await teeSign(w.signing.pair.privateKey, encodeMessage('instanceKey', { examId: fromHex(examId), encryptionPublicKey: encryption.publicKey }));
    const token = text(w.files.get('token.jwt'));
    const ask = (signature: Uint8Array) => ({
      attestation: () =>
        Promise.resolve({
          token,
          instancePublicKey: toHex(w.signing.publicKey),
          encryptionPublicKey: toHex(encryption.publicKey),
          instanceKeySignature: toHex(signature),
        }),
    });
    const verdict = await checkFreshToken({ tee: ask(good) as never, exam: w.exam, examId, registry: registryAddress, trustedRoot: w.pki.root });
    expect(verdict.signature).toEqual({ ok: true });
    expect(verdict.instanceKey.ok).toBe(true);
    expect(verdict.claims.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.trusted).toBe(true);
    expect(verdict.instancePublicKey).toBe(toHex(w.signing.publicKey));
    const forged = await checkFreshToken({ tee: ask(new Uint8Array(64)) as never, exam: w.exam, examId, registry: registryAddress, trustedRoot: w.pki.root });
    expect(forged.instanceKey.ok).toBe(false);
    expect(forged.trusted).toBe(false);
  });
});

describe('manifest', () => {
  const ctx = async () => {
    const w = await getWorld();
    return { w, context: { examId, build: w.build, entries: approvedEntries(w.entriesHex) } };
  };

  it('passes hash, exam, coverage and recipients for the manifest the Build committed to', async () => {
    const { w, context } = await ctx();
    const report = checkManifest(must(w.files.get('manifest.json')), context);
    if (report.kind !== 'parsed') throw new Error('expected a parsed manifest');
    expect(report.hashCheck).toBe('pass');
    expect(report.examIdCheck).toBe('pass');
    expect(report.coverage).toEqual({ check: 'pass' });
    expect(report.files.map((f) => f.name)).toContain('paper.bin');
    const shareFiles = report.files.filter((f) => f.recipient);
    expect(shareFiles).toHaveLength(10);
    expect(shareFiles.every((f) => f.recipientOnList === 'pass')).toBe(true);
  });

  it('fails when the bytes differ from what the Build hashed', async () => {
    const { w, context } = await ctx();
    const changed = new TextEncoder().encode(text(w.files.get('manifest.json')) + ' ');
    expect(checkManifest(changed, context).hashCheck).toBe('fail');
  });

  it('fails a recipient that is not an approved key holder and a missing holder share', async () => {
    const { w, context } = await ctx();
    const manifest = structuredClone(w.manifest);
    const share = must(manifest.files.find((f) => 'recipient' in f));
    (share as { recipient: string }).recipient = toHex(new Uint8Array(65).fill(4));
    const report = checkManifest(new TextEncoder().encode(JSON.stringify(manifest)), context);
    if (report.kind !== 'parsed') throw new Error('expected a parsed manifest');
    expect(report.files.filter((f) => f.recipientOnList === 'fail')).toHaveLength(1);
    expect(report.coverage.check).toBe('fail');
  });

  it('is neutral with no Build or no approved list, and reports a malformed manifest', async () => {
    const { w } = await ctx();
    const report = checkManifest(must(w.files.get('manifest.json')), { examId, build: null, entries: null });
    if (report.kind !== 'parsed') throw new Error('expected a parsed manifest');
    expect(report.hashCheck).toBe('absent');
    expect(report.coverage.check).toBe('absent');
    expect(checkManifest(new TextEncoder().encode('{}'), { examId, build: null, entries: null }).kind).toBe('malformed');
  });

  it('fails a manifest for another exam', async () => {
    const { w, context } = await ctx();
    const other = { ...w.manifest, examId: `0x${'22'.repeat(32)}` };
    const report = checkManifest(new TextEncoder().encode(JSON.stringify(other)), context);
    if (report.kind !== 'parsed') throw new Error('expected a parsed manifest');
    expect(report.examIdCheck).toBe('fail');
  });
});

describe('release log', () => {
  it('verifies under the instance key that signed it, and shows which holders released', async () => {
    const w = await getWorld();
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    expect(await checkReleaseLog(log, examId, log.instancePublicKey)).toEqual({
      examId: 'pass',
      entriesHash: 'pass',
      filesHash: 'pass',
      signature: 'pass',
    });
    const progress = releaseProgress(holdersOf(w.entries), log.entries.map((e) => e.passkeyPublicKey));
    expect(progress.count).toBe(8);
    expect(progress.required).toBe(8);
    expect(progress.rows).toHaveLength(10);
    expect(progress.rows.filter((r) => !r.released)).toHaveLength(2);
    expect(progress.unknown).toEqual([]);
  });

  it('fails under another key, with another exam, or with tampered entries', async () => {
    const w = await getWorld();
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    const stranger = await p256();
    expect((await checkReleaseLog(log, examId, toHex(stranger.publicKey))).signature).toBe('fail');
    expect((await checkReleaseLog(log, `0x${'22'.repeat(32)}`, log.instancePublicKey)).examId).toBe('fail');
    const tampered = { ...log, entries: log.entries.slice(1) };
    const verdict = await checkReleaseLog(tampered, examId, log.instancePublicKey);
    expect(verdict.entriesHash).toBe('fail');
  });

  it('fails tampered files, and a tampered filesHash under the same signature', async () => {
    const w = await getWorld();
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    const swapped = log.files.map((file, i) => (i === 0 ? { ...file, sha256: toHex(random(32)) } : file));
    const changedFiles = await checkReleaseLog({ ...log, files: swapped }, examId, log.instancePublicKey);
    expect(changedFiles).toMatchObject({ filesHash: 'fail', signature: 'pass' });
    const changedHash = await checkReleaseLog({ ...log, filesHash: toHex(random(32)) }, examId, log.instancePublicKey);
    expect(changedHash).toMatchObject({ filesHash: 'fail', signature: 'fail' });
  });

  it('refuses a list out of order or with a repeated name, rather than sorting it', async () => {
    const w = await getWorld();
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    const reversed = await checkReleaseLog({ ...log, files: [...log.files].reverse() }, examId, log.instancePublicKey);
    expect(reversed.filesHash).toBe('fail');
    const repeated = await checkReleaseLog({ ...log, files: [...log.files, must(log.files.at(-1))] }, examId, log.instancePublicKey);
    expect(repeated.filesHash).toBe('fail');
  });

  it('is signed by a fresh Unlock instance, not the Build instance, and its token passes against the chain', async () => {
    const w = await getWorld();
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    expect(log.instancePublicKey).not.toBe(w.build.instancePublicKey);
    const verdict = await checkRecordToken({
      token: text(w.files.get('release-token.jwt')),
      exam: w.exam,
      examId,
      registry: registryAddress,
      instancePublicKey: log.instancePublicKey,
      trustedRoot: w.pki.root,
    });
    expect(verdict.verified).toBe(true);
    // Under the Build key the same log does not verify.
    expect((await checkReleaseLog(log, examId, w.build.instancePublicKey as Hex)).signature).toBe('fail');
  });

  it('fails a release token that binds a different key than the log names', async () => {
    const w = await buildWorld({ badReleaseToken: true });
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    const verdict = await checkRecordToken({
      token: text(w.files.get('release-token.jwt')),
      exam: w.exam,
      examId,
      registry: registryAddress,
      instancePublicKey: log.instancePublicKey,
      trustedRoot: w.pki.root,
    });
    expect(verdict.claims.find((c) => c.claim === 'eat_nonce')?.ok).toBe(false);
    expect(verdict.verified).toBe(false);
  });

  it('does not check a signature it has no key for', async () => {
    const w = await getWorld();
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    expect((await checkReleaseLog(log, examId, null)).signature).toBe('absent');
  });

  it('flags a release by a key that is not on the approved list', async () => {
    const w = await getWorld();
    const stranger = toHex(new Uint8Array(65).fill(4));
    expect(releaseProgress(holdersOf(w.entries), [stranger]).unknown).toEqual([stranger]);
  });

  it('rejects a body that is not a release log', () => {
    expect(() => parseReleaseLog(new TextEncoder().encode('nope'))).toThrow();
    expect(() => parseReleaseLog(new TextEncoder().encode('{"examId":"0x"}'))).toThrow('release log shape');
  });

  it('rejects a log without files or filesHash, or with a malformed file', async () => {
    const w = await getWorld();
    const parse = (log: unknown) => () => parseReleaseLog(new TextEncoder().encode(JSON.stringify(log)));
    const { files, filesHash, ...old } = w.releaseLog;
    expect(parse({ ...old, filesHash })).toThrow('release log shape');
    expect(parse({ ...old, files })).toThrow('release log shape');
    expect(parse({ ...w.releaseLog, filesHash: '0xabcd' })).toThrow('release log shape');
    expect(parse({ ...w.releaseLog, files: [{ name: 'key-priv.tlock', sha256: '0xabcd' }] })).toThrow('malformed file');
    expect(parse({ ...w.releaseLog, files: [{ sha256: filesHash }] })).toThrow('malformed file');
  });

  it('counts a live answer of delivery_pending as no log yet, not as a failure', async () => {
    const w = await getWorld();
    const tee = {
      status: () => Promise.resolve({ stage: 'unlock', questionCount: 0, release: { released: [], required: 8 } }),
      releaseLog: () => Promise.reject(new TeeApiError(503, 'delivery_pending', 'not ready')),
      attestation: () => Promise.reject(new Error('down')),
    } as unknown as TeeClient;
    const chain = { exam: w.exam, entries: w.entriesHex } as ChainData;
    const report = await loadLive({ tee, chain: () => chain, examId, registry: registryAddress });
    if ('kind' in report) throw new Error('expected a report');
    expect(report.log).toBeNull();
  });
});

describe('release files', () => {
  it('expects key-priv.tlock and one copy per centre, and no one else', async () => {
    const w = await getWorld();
    const names = [...expectedReleaseFiles(w.entries).keys()];
    const centres = w.entries.filter((entry) => entry.role === 3 || entry.role === 4);
    expect(centres).toHaveLength(8);
    expect(names).toHaveLength(9);
    expect(names).toContain(storageNames.keyPriv);
    for (const entry of w.entries) {
      const named = names.includes(storageNames.centreKeyPriv(entry.derivedPublicKey));
      expect(named).toBe(entry.role === 3 || entry.role === 4);
    }
  });

  it('passes when the log, the list and storage all agree', async () => {
    const w = await getWorld();
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    const report = await checkReleaseFiles(log, w.entries, w.storage());
    expect(report).toMatchObject({ pending: false, names: 'pass', missing: [], extra: [], check: 'pass' });
    expect(report.files).toHaveLength(9);
  });

  it('still compares stored files with no list, without passing', async () => {
    const w = await getWorld();
    const log = parseReleaseLog(must(w.files.get('release-log.json')));
    const report = await checkReleaseFiles(log, null, w.storage({ [storageNames.keyPriv]: random(40) }));
    expect(report.check).toBe('fail');
    expect(report.files.find((file) => file.name === storageNames.keyPriv)?.problem).toBe('changed');
  });
});

describe('post-exam proof', () => {
  const input = (w: World, over: Partial<Parameters<typeof runProof>[0]> = {}): Parameters<typeof runProof>[0] => ({
    storage: w.storage(),
    examId,
    exam: w.exam,
    build: w.build,
    criteria: w.criteriaHex,
    currentRound: 1000,
    keyPrivSha256: null,
    now: 2_000_000_000,
    client: w.client,
    ...over,
  });
  /** What `signedKeyPriv` gives for a log that passed: its hash of `key-priv.tlock`. */
  const listedKeyPriv = (w: World) => must(w.releaseLog.files.find((file) => file.name === storageNames.keyPriv)).sha256;

  it('opens the paper with the real timelocks and passes every check', async () => {
    const w = await getWorld();
    const result = await runProof(input(w));
    if (result.state !== 'opened') throw new Error(`expected opened, got ${result.state}`);
    expect(Object.values(result.checks)).toEqual(Array(7).fill('pass'));
    expect(result.paper?.questions).toHaveLength(3);
    expect(result.paper?.questions[0]?.text).toBe('Differentiate x squared.');
  });

  it('says when the paper opens before the end round, and reads no files', async () => {
    const w = await buildWorld({ endRound: 5000 });
    const get = vi.fn();
    const result = await runProof(input(w, { currentRound: 1000, storage: { url: () => '', get } }));
    expect(result).toEqual({ state: 'waiting', endRound: 5000, opensAt: 1692803367 + 4999 * 3 });
    expect(get).not.toHaveBeenCalled();
  });

  it('falls back to the clock when drand has not answered', async () => {
    const w = await buildWorld({ endRound: 5000 });
    expect((await runProof(input(w, { currentRound: null, now: 1_692_803_367 + 10 }))).state).toBe('waiting');
  });

  it('says no copy exists when the end round passed with no key-priv.tlock', async () => {
    const w = await buildWorld({ unlocked: false });
    expect(await runProof(input(w))).toEqual({ state: 'sealed' });
  });

  it('opens the paper when key-priv.tlock is the file the signed log lists', async () => {
    const w = await getWorld();
    const result = await runProof(input(w, { keyPrivSha256: listedKeyPriv(w) }));
    if (result.state !== 'opened') throw new Error('expected opened');
    expect(result.paper).not.toBeNull();
  });

  it('fails, and does not say sealed, when a signed log lists a deleted key-priv.tlock', async () => {
    const w = await getWorld();
    const result = await runProof(input(w, { keyPrivSha256: listedKeyPriv(w), storage: w.storage({ [storageNames.keyPriv]: null }) }));
    expect(result).toMatchObject({ state: 'failed', step: 'files', message: expect.stringMatching(/was removed from the public files/) as string });
  });

  it('fails before opening anything when key-priv.tlock is not the file the signed log lists', async () => {
    const w = await getWorld();
    // Sealed for real to the right round, so only the log's hash can catch it.
    const swapped = new TextEncoder().encode(await w.seal(w.kPriv));
    const result = await runProof(input(w, { keyPrivSha256: listedKeyPriv(w), storage: w.storage({ [storageNames.keyPriv]: swapped }) }));
    expect(result).toMatchObject({ state: 'failed', step: 'files', message: expect.stringMatching(/was changed after the unlock recorded it/) as string });
  });

  it('stays sealed with no log and no key-priv.tlock', async () => {
    const w = await getWorld();
    const storage = w.storage({ [storageNames.keyPriv]: null, [storageNames.releaseLog]: null });
    expect(await runProof(input(w, { storage }))).toEqual({ state: 'sealed' });
  });

  it('takes the hash for the proof only from a log whose checks passed', async () => {
    const w = await getWorld();
    const report = await checkReleaseFiles(parseReleaseLog(must(w.files.get('release-log.json'))), w.entries, w.storage());
    const ready = { kind: 'ready', verdict: {}, token: null, progress: null } as unknown as Extract<Parameters<typeof signedKeyPriv>[0], { kind: 'ready' }>;
    expect(signedKeyPriv({ ...ready, files: report })).toBe(listedKeyPriv(w));
    expect(signedKeyPriv({ ...ready, files: null })).toBeNull();
    expect(signedKeyPriv({ kind: 'neutral', message: 'no log' })).toBeNull();
    expect(signedKeyPriv({ kind: 'malformed', message: 'bad' })).toBeNull();
  });

  it('fails when the Build’s saltedPaperHash is not the paper’s, and withholds the paper', async () => {
    const w = await buildWorld({ wrongSaltedHash: true });
    const result = await runProof(input(w));
    if (result.state !== 'opened') throw new Error('expected opened');
    expect(result.checks.saltedHash).toBe('fail');
    expect(result.paper).toBeNull();
  });

  it('fails the count checks when the Build’s selected is not the paper’s', async () => {
    const w = await buildWorld({ selected: 4 });
    const result = await runProof(input(w));
    if (result.state !== 'opened') throw new Error('expected opened');
    expect(result.checks.selectedCount).toBe('fail');
    expect(result.checks.criteriaCount).toBe('fail');
  });

  it('fails the topic check when the paper does not follow the criteria', async () => {
    const w = await buildWorld({
      paper: { examId, questions: [{ topic: 'Maths', text: 'a' }, { topic: 'Physics', text: 'b' }, { topic: 'Physics', text: 'c' }] },
    });
    const result = await runProof(input(w));
    if (result.state !== 'opened') throw new Error('expected opened');
    expect(result.checks.topics).toBe('fail');
    expect(result.parseError).toContain('Maths');
  });

  it('keeps criteria checks neutral when the chain has no criteria', async () => {
    const w = await getWorld();
    const result = await runProof(input(w, { criteria: null }));
    if (result.state !== 'opened') throw new Error('expected opened');
    expect(result.checks.criteriaHash).toBe('absent');
    expect(result.checks.topics).toBe('absent');
    expect(result.checks.criteriaCount).toBe('absent');
  });

  it('fails the paper file check when paper.bin is not the one the Build hashed', async () => {
    const w = await getWorld();
    const result = await runProof(input(w, { build: { ...w.build, paperHash: `0x${'00'.repeat(32)}` } }));
    if (result.state !== 'opened') throw new Error('expected opened');
    expect(result.checks.paperFile).toBe('fail');
  });

  it('reports a file that storage does not have', async () => {
    const w = await getWorld();
    const result = await runProof(input(w, { storage: w.storage({ 'key-pub.tlock': null }) }));
    expect(result).toMatchObject({ state: 'failed', step: 'files' });
  });

  it('reports K_priv that does not belong to K_pub, without showing a paper', async () => {
    const w = await getWorld();
    const wrong = new TextEncoder().encode(await w.seal(new Uint8Array(32).fill(7)));
    const result = await runProof(input(w, { storage: w.storage({ 'key-priv.tlock': wrong }) }));
    expect(result).toMatchObject({ state: 'failed', step: 'decrypt' });
  });

  it('reports a timelock that the beacon cannot open', async () => {
    const w = await getWorld();
    // K_priv sealed to a round whose beacon is not published, while drand's latest says it is.
    const early = new TextEncoder().encode(await w.sealAt(5000, w.kPriv));
    const result = await runProof(input(w, { storage: w.storage({ 'key-priv.tlock': early }) }));
    expect(result).toMatchObject({ state: 'failed', step: 'timelock' });
  });

  it('needs the exam, the storage URL and the Build, and says so', async () => {
    const w = await getWorld();
    expect((await runProof(input(w, { exam: null }))).state).toBe('not-ready');
    expect((await runProof(input(w, { storage: null }))).state).toBe('not-ready');
    expect((await runProof(input(w, { build: null }))).state).toBe('not-ready');
  });
});
