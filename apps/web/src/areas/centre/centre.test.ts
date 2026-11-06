import { createHash } from 'node:crypto';

import { aesGcmEncrypt } from '@paperseal/crypto';
import {
  approvedListHash,
  encodeApprovedList,
  encodePaper,
  fromHex,
  padPaper,
  roles,
  saltedPaperHash,
  toHex,
  concatBytes,
  encodeMessage,
  entriesHash,
  filesHash,
  releaseEntryFromWire,
  releaseFileFromWire,
  sortReleaseFiles,
  storageNames,
  type ApprovedListEntry,
  type Hex,
} from '@paperseal/protocol';
import { describe, expect, it, vi } from 'vitest';

import { StorageVerificationError } from '../../shared/storage';
import { verifiedLogForUnlock, verifyReleaseLog, type CheckedLog } from './logCheck';
import { downloadPaperFiles } from './download';
import { paginate, paperItems } from './paperPages';
import { KeyFileChangedError, PaperHashMismatchError, prepareUnlock, unlockPaper, type UnlockContext } from './unlock';

const examId: Hex = `0x${'11'.repeat(32)}`;
const sha = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
const filled = (n: number, length = 32) => new Uint8Array(length).fill(n);
const key = (seed: number) => new Uint8Array([4, ...filled(seed, 64)]);

const paperJson = { examId, questions: [{ topic: 'Mechanics', text: 'State Newton\'s second law.' }, { topic: 'Optics', text: 'Define refraction.' }] };
const criteria = { topics: [{ name: 'Mechanics', questions: 1 }, { name: 'Optics', questions: 1 }] };

async function sealedPaper(kPub: Uint8Array, kPriv: Uint8Array, seed: Uint8Array) {
  const paper = encodePaper(paperJson);
  const k = kPub.map((b, i) => b ^ (kPriv[i] as number));
  const file = await aesGcmEncrypt(k, concatBytes(seed, padPaper(paper)), fromHex(examId));
  return { file, saltedHash: toHex(saltedPaperHash(seed, paper)) };
}

async function unlockSetup(overrides: { salted?: Hex; kPrivOpened?: Uint8Array } = {}) {
  const [kPub, kPriv, seed] = [filled(1), filled(2), filled(3)];
  const { file, saltedHash } = await sealedPaper(kPub, kPriv, seed);
  const derived = toHex(key(7));
  const context = {
    examId,
    credentialId: new Uint8Array([1]),
    derivedPublicKey: derived,
    keys: { openKeyPriv: vi.fn(() => Promise.resolve(overrides.kPrivOpened ?? kPriv.slice())) },
    build: { saltedPaperHash: overrides.salted ?? saltedHash },
    criteria,
    paperFile: file,
    keyPubTlock: 'armoured',
    timelockDecrypt: vi.fn((_c: string) => Promise.resolve(kPub.slice())),
    fetchFile: vi.fn((_name: string) => Promise.resolve(new Uint8Array([1, 2, 3]))),
  } satisfies UnlockContext;
  return { context, kPub };
}

const sealedKeyFile = new Uint8Array([1, 2, 3]);
const listing = (derived: Hex, bytes: Uint8Array) => ({
  files: [
    { name: 'key-priv.tlock', sha256: toHex(sha(new Uint8Array([9]))) },
    { name: storageNames.centreKeyPriv(fromHex(derived)), sha256: toHex(sha(bytes)) },
  ],
});

describe('unlockPaper', () => {
  it('combines K_pub and K_priv, decrypts and returns the checked paper', async () => {
    const { context } = await unlockSetup();
    const steps: string[] = [];
    const paper = await unlockPaper({ ...context, onStep: (s) => steps.push(s) });
    expect(paper).toEqual(paperJson);
    expect(steps).toEqual(['timelock', 'keyPriv', 'touch', 'decrypt', 'check']);
    expect(context.fetchFile).toHaveBeenCalledWith(`key-priv/${context.derivedPublicKey}.bin`);
  });

  it('refuses to show a paper whose salted hash differs from the Build', async () => {
    const { context } = await unlockSetup({ salted: `0x${'ee'.repeat(32)}` });
    await expect(unlockPaper(context)).rejects.toBeInstanceOf(PaperHashMismatchError);
  });

  it('fails to decrypt with the wrong K_priv', async () => {
    const { context } = await unlockSetup({ kPrivOpened: filled(9) });
    await expect(unlockPaper(context)).rejects.toMatchObject({ step: 'decrypt' });
  });

  it('stops before touching the key while the time seal is closed', async () => {
    const { context } = await unlockSetup();
    context.timelockDecrypt.mockRejectedValue(new Error('too early'));
    await expect(unlockPaper(context)).rejects.toMatchObject({ step: 'timelock' });
    expect(context.keys.openKeyPriv).not.toHaveBeenCalled();
  });

  it('rejects a paper that breaks the criteria', async () => {
    const { context } = await unlockSetup();
    await expect(unlockPaper({ ...context, criteria: { topics: [{ name: 'Mechanics', questions: 2 }] } })).rejects.toMatchObject({ step: 'check' });
  });

  it('wipes K_pub and K_priv after use', async () => {
    const { context } = await unlockSetup();
    const kPriv = filled(2);
    context.keys.openKeyPriv.mockResolvedValue(kPriv);
    const kPub = filled(1);
    context.timelockDecrypt.mockResolvedValue(kPub);
    await unlockPaper(context);
    expect(kPub).toEqual(new Uint8Array(32));
    expect(kPriv).toEqual(new Uint8Array(32));
  });

  describe('against a verified release log', () => {
    it('goes on when the log lists this very file', async () => {
      const { context } = await unlockSetup();
      const paper = await unlockPaper({ ...context, verifiedLog: listing(context.derivedPublicKey, sealedKeyFile) });
      expect(paper).toEqual(paperJson);
      expect(context.keys.openKeyPriv).toHaveBeenCalledOnce();
    });

    it('stops before the touch when the file was swapped, and wipes K_pub', async () => {
      const { context } = await unlockSetup();
      const kPub = filled(1);
      context.timelockDecrypt.mockResolvedValue(kPub);
      const steps: string[] = [];
      const unlocking = unlockPaper({ ...context, verifiedLog: listing(context.derivedPublicKey, new Uint8Array([7])), onStep: (s) => steps.push(s) });
      await expect(unlocking).rejects.toBeInstanceOf(KeyFileChangedError);
      await expect(unlocking).rejects.toMatchObject({ step: 'keyPriv' });
      await expect(unlocking).rejects.toThrow('changed after the TEE wrote it');
      expect(context.keys.openKeyPriv).not.toHaveBeenCalled();
      expect(steps).toEqual(['timelock', 'keyPriv']);
      expect(kPub).toEqual(new Uint8Array(32));
    });

    it('stops a swapped file that was got ahead of the press', async () => {
      const { context } = await unlockSetup();
      const prepared = await prepareUnlock(context);
      await expect(unlockPaper({ ...context, prepared, verifiedLog: listing(context.derivedPublicKey, new Uint8Array([7])) })).rejects.toBeInstanceOf(KeyFileChangedError);
      expect(context.keys.openKeyPriv).not.toHaveBeenCalled();
    });

    it('stops when the log lists files but none for this centre', async () => {
      const { context } = await unlockSetup();
      await expect(unlockPaper({ ...context, verifiedLog: listing(toHex(key(8)), sealedKeyFile) })).rejects.toBeInstanceOf(KeyFileChangedError);
      expect(context.keys.openKeyPriv).not.toHaveBeenCalled();
    });

    it('takes a log from before the threshold, which lists no files, as saying nothing', async () => {
      const { context } = await unlockSetup();
      expect(await unlockPaper({ ...context, verifiedLog: { files: [] } })).toEqual(paperJson);
    });

    it('goes on with no log at all', async () => {
      const { context } = await unlockSetup();
      expect(await unlockPaper({ ...context, verifiedLog: null })).toEqual(paperJson);
      expect(context.keys.openKeyPriv).toHaveBeenCalledOnce();
    });
  });
});

describe('verifiedLogForUnlock', () => {
  const log = { files: [] } as unknown as CheckedLog['log'];
  const verdict = (pass: boolean) => ({ pass }) as CheckedLog['verdict'];

  it('gives the log only when it verified', async () => {
    expect(await verifiedLogForUnlock(() => Promise.resolve({ log, verdict: verdict(true) }))).toBe(log);
    expect(await verifiedLogForUnlock(() => Promise.resolve({ log, verdict: verdict(false) }))).toBeNull();
  });

  it('gives nothing when the log cannot be read, so the unlock is not blocked', async () => {
    await expect(verifiedLogForUnlock(() => Promise.reject(new Error('unreachable')))).resolves.toBeNull();
  });

  it('stops waiting for a log that never answers', async () => {
    await expect(verifiedLogForUnlock(() => new Promise(() => {}), 5)).resolves.toBeNull();
  });
});

/** A storage with a manifest that covers 3 neutral and 7 centre key holders. */
function storage() {
  const holders: ApprovedListEntry[] = Array.from({ length: 10 }, (_, i) => ({
    role: i < 3 ? roles.neutral : roles.centreKeyHolder,
    passkeyPublicKey: key(10 + i),
    derivedPublicKey: key(50 + i),
    owner: `h${String(i)}`,
  }));
  const entries = toHex(encodeApprovedList(holders));
  const paper = new Uint8Array([5, 5, 5]);
  const keyPub = new TextEncoder().encode('-----BEGIN AGE ENCRYPTED FILE-----');
  const token = new Uint8Array([8]);
  const plain = new Map<string, Uint8Array>([
    ['paper.bin', paper],
    ['key-pub.tlock', keyPub],
    ['token.jwt', token],
  ]);
  const files = [...plain.entries()].map(([name, bytes]) => ({ name, sha256: toHex(sha(bytes)) }));
  for (const holder of holders) {
    const share = new Uint8Array([6, holder.passkeyPublicKey[1] as number]);
    const name = `shares/${toHex(holder.derivedPublicKey)}.bin`;
    plain.set(name, share);
    files.push({ name, sha256: toHex(sha(share)), recipient: toHex(holder.derivedPublicKey), shareHash: `0x${'ab'.repeat(32)}` } as never);
  }
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  const manifest = new TextEncoder().encode(JSON.stringify({ examId, files }));
  plain.set('manifest.json', manifest);
  const build = {
    approvedListHash: toHex(approvedListHash(fromHex(examId), fromHex(entries))),
    paperHash: toHex(sha(paper)),
    storageManifestHash: toHex(sha(manifest)),
  };
  return { plain, entries, build, keyPub };
}

describe('downloadPaperFiles', () => {
  function context(s = storage(), overrides: Partial<Parameters<typeof downloadPaperFiles>[0]> = {}) {
    return {
      examId,
      fetchFile: (name: string) => {
        const found = s.plain.get(name);
        return found ? Promise.resolve(found) : Promise.reject(new Error(`missing ${name}`));
      },
      readBuild: () => Promise.resolve(s.build),
      readListEntries: () => Promise.resolve(s.entries),
      ...overrides,
    };
  }

  it('downloads the three files and checks them against the manifest and the Build', async () => {
    const s = storage();
    const downloaded = await downloadPaperFiles(context(s));
    expect(downloaded.paper).toEqual(new Uint8Array([5, 5, 5]));
    expect(downloaded.keyPubTlock).toBe(new TextDecoder().decode(s.keyPub));
    expect(downloaded.checks.map((c) => c.label)).toEqual(['manifest.json', 'Manifest coverage', 'paper.bin', 'key-pub.tlock']);
  });

  it('refuses a manifest that differs from the Build', async () => {
    const s = storage();
    await expect(downloadPaperFiles(context(s, { readBuild: () => Promise.resolve({ ...s.build, storageManifestHash: `0x${'01'.repeat(32)}` }) }))).rejects.toThrow('storage manifest hash');
  });

  it('refuses a paper file that was swapped', async () => {
    const s = storage();
    s.plain.set('paper.bin', new Uint8Array([9]));
    await expect(downloadPaperFiles(context(s))).rejects.toThrow('paper.bin does not match');
  });

  it('refuses a paper hash in the Build that differs from the file', async () => {
    const s = storage();
    await expect(downloadPaperFiles(context(s, { readBuild: () => Promise.resolve({ ...s.build, paperHash: `0x${'01'.repeat(32)}` }) }))).rejects.toBeInstanceOf(StorageVerificationError);
  });

  it('refuses when no Build is posted', async () => {
    await expect(downloadPaperFiles(context(storage(), { readBuild: () => Promise.resolve(null) }))).rejects.toThrow('No paper');
  });

  it('refuses an on-chain list that is not the one the Build committed to', async () => {
    const s = storage();
    await expect(downloadPaperFiles(context(s, { readBuild: () => Promise.resolve({ ...s.build, approvedListHash: `0x${'05'.repeat(32)}` }) }))).rejects.toThrow('approved list hash');
  });
});

describe('verifyReleaseLog', () => {
  async function signedLog(files = sortReleaseFiles([
    { name: `key-priv/${toHex(key(2))}.bin`, sha256: toHex(filled(0x44)) },
    { name: 'key-priv.tlock', sha256: toHex(filled(0x45)) },
  ])) {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const entries = [{ passkeyPublicKey: toHex(key(1)) as Hex, shareHash: `0x${'ab'.repeat(32)}` as Hex, round: '42' }];
    const hash = toHex(entriesHash(entries.map(releaseEntryFromWire)));
    const filesDigest = toHex(filesHash(files.map(releaseFileFromWire)));
    let signature = new Uint8Array(
      await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(encodeMessage('releaseLog', { examId: fromHex(examId), entriesHash: fromHex(hash), filesHash: fromHex(filesDigest) }))),
    );
    const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const s = BigInt(toHex(signature.subarray(32)));
    if (s > order / 2n) {
      signature = signature.slice();
      signature.set(fromHex(`0x${(order - s).toString(16).padStart(64, '0')}`), 32);
    }
    return {
      examId,
      entries,
      entriesHash: hash,
      files,
      filesHash: filesDigest,
      teeSignature: toHex(signature),
      instancePublicKey: toHex(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))),
    };
  }
  const good = () => Promise.resolve({ passed: true, failures: [] as string[] });
  const bad = () => Promise.resolve({ passed: false, failures: ['eat_nonce'] });

  it('passes when the hash, signature and token all check out', async () => {
    const log = await signedLog();
    expect(await verifyReleaseLog(log, { examId }, 'jwt', good)).toMatchObject({ pass: true, entriesHash: true, files: true, signature: true, exam: true });
  });

  it('passes a log from before the threshold, which lists no files', async () => {
    const log = await signedLog([]);
    expect(await verifyReleaseLog(log, { examId }, 'jwt', good)).toMatchObject({ pass: true, files: true });
  });

  it('fails a wrong filesHash, whether or not the signature covers it', async () => {
    const log = await signedLog();
    const other = await signedLog([{ name: 'key-priv.tlock', sha256: toHex(filled(0x46)) }]);
    const swapped = await verifyReleaseLog({ ...log, filesHash: other.filesHash }, { examId }, 'jwt', good);
    expect(swapped).toMatchObject({ pass: false, files: false, signature: false });
    const signedOver = await verifyReleaseLog({ ...other, files: log.files }, { examId }, 'jwt', good);
    expect(signedOver).toMatchObject({ pass: false, files: false, signature: true });
  });

  it('fails a list of files that was changed under a good signature', async () => {
    const log = await signedLog();
    const changed = log.files.map((file) => ({ ...file, sha256: toHex(filled(0x47)) }));
    expect(await verifyReleaseLog({ ...log, files: changed }, { examId }, 'jwt', good)).toMatchObject({ pass: false, files: false });
  });

  it('fails a malformed list of files instead of throwing', async () => {
    const log = await signedLog();
    const backwards = [...log.files].reverse();
    expect(await verifyReleaseLog({ ...log, files: backwards }, { examId }, 'jwt', good)).toMatchObject({ pass: false, files: false });
    const [first] = log.files as [(typeof log.files)[number]];
    expect(await verifyReleaseLog({ ...log, files: [first, first] }, { examId }, 'jwt', good)).toMatchObject({ pass: false, files: false });
    expect(await verifyReleaseLog({ ...log, files: [{ name: 'x', sha256: '0x00' }] }, { examId }, 'jwt', good)).toMatchObject({ pass: false, files: false });
    expect(await verifyReleaseLog({ ...log, files: null as never }, { examId }, 'jwt', good)).toMatchObject({ pass: false, files: false });
  });

  it('fails when the token does not attest the key, or is missing', async () => {
    const log = await signedLog();
    expect((await verifyReleaseLog(log, { examId }, 'jwt', bad)).pass).toBe(false);
    const missing = await verifyReleaseLog(log, { examId }, null, good);
    expect(missing.pass).toBe(false);
    expect(missing.token.failures[0]).toContain('not available');
  });

  it('fails a log signed by another key, or with changed entries', async () => {
    const log = await signedLog();
    const other = await signedLog();
    expect((await verifyReleaseLog({ ...log, instancePublicKey: other.instancePublicKey }, { examId }, 'jwt', good)).signature).toBe(false);
    const changed = { ...log, entries: [{ ...(log.entries[0] as (typeof log.entries)[number]), round: '43' }] };
    expect(await verifyReleaseLog(changed, { examId }, 'jwt', good)).toMatchObject({ pass: false, entriesHash: false });
  });
});

describe('the paper pages', () => {
  it('numbers straight through and groups a topic that comes back', () => {
    const items = paperItems({
      examId: `0x${'11'.repeat(32)}`,
      questions: [
        { topic: 'Waves', text: 'one' },
        { topic: 'Heat', text: 'two' },
        { topic: 'Waves', text: 'three' },
      ],
    });
    expect(items.map((item) => [item.number, item.question.text, item.opensTopic])).toEqual([
      [1, 'one', true],
      [2, 'three', false],
      [3, 'two', true],
    ]);
  });

  it('never splits a question, and covers every question once', () => {
    expect(paginate([40, 40, 40, 40, 40], 100)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ]);
  });

  it('gives a question taller than a page its own page, which grows, so nothing is cut off', () => {
    expect(paginate([40, 250, 40], 100)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2, tallBy: 250 },
      { start: 2, end: 3 },
    ]);
  });

  it('has one empty page for no questions', () => {
    expect(paginate([], 100)).toEqual([{ start: 0, end: 0 }]);
  });
});
