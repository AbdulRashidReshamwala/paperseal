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
  releaseEntryFromWire,
  type ApprovedListEntry,
  type Hex,
} from '@paperseal/protocol';
import { describe, expect, it, vi } from 'vitest';

import { StorageVerificationError } from '../../shared/storage';
import { verifyReleaseLog } from './logCheck';
import { formatRemaining, secondsUntilRound } from './Countdown';
import { downloadPaperFiles } from './download';
import { PaperHashMismatchError, unlockPaper, type UnlockContext } from './unlock';

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

describe('countdown', () => {
  it('counts down in drand rounds', () => {
    // Round 1 is produced at genesis, and a round is produced every 3 seconds.
    expect(secondsUntilRound(11, 1692803367 + 6)).toBe(24);
    expect(secondsUntilRound(11, 1692803367 + 100)).toBe(0);
    expect(formatRemaining(3725)).toBe('1:02:05');
  });
});

describe('verifyReleaseLog', () => {
  async function signedLog() {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const entries = [{ passkeyPublicKey: toHex(key(1)) as Hex, shareHash: `0x${'ab'.repeat(32)}` as Hex, round: '42' }];
    const hash = toHex(entriesHash(entries.map(releaseEntryFromWire)));
    let signature = new Uint8Array(
      await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(encodeMessage('releaseLog', { examId: fromHex(examId), entriesHash: fromHex(hash) }))),
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
      teeSignature: toHex(signature),
      instancePublicKey: toHex(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))),
    };
  }
  const good = () => Promise.resolve({ passed: true, failures: [] as string[] });
  const bad = () => Promise.resolve({ passed: false, failures: ['eat_nonce'] });

  it('passes when the hash, signature and token all check out', async () => {
    const log = await signedLog();
    expect(await verifyReleaseLog(log, { examId }, 'jwt', good)).toMatchObject({ pass: true, entriesHash: true, signature: true, exam: true });
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
