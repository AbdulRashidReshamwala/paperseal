import 'reflect-metadata';

import { aesGcmEncrypt, xorCombine, type ChainClient } from '@paperseal/crypto';
import {
  attestationNonce,
  approvedListHash,
  criteriaHash,
  encodeApprovedList,
  encodeCriteria,
  encodeMessage,
  encodePaper,
  encryptedPaperHash,
  entriesHash,
  fromHex,
  hashMessage,
  padPaper,
  saltedPaperHash,
  setterOwner,
  startupArgs,
  storageManifestHash,
  toHex,
  type ApprovedListEntry,
  type Hex,
  type Paper,
} from '@paperseal/protocol';
import { BasicConstraintsExtension, X509Certificate, X509CertificateGenerator } from '@peculiar/x509';
import { CompactSign } from 'jose';
import { Buffer as TlockBuffer, defaultChainInfo, timelockEncrypt, type ChainInfo } from 'tlock-js';

import { examSettings, teeStorageBucket, type Build, type Exam } from './attest';
import type { StorageReader } from './storage';

/*
 * A whole exam, built with the real encodings, real P-256 and RSA signatures and a real quicknet
 * beacon, so tests exercise the same code paths as a live exam. Only the network is stubbed.
 */

const subtle = globalThis.crypto.subtle;
const ecdsa = { name: 'ECDSA', namedCurve: 'P-256' };
const rsa = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };

export const examId: Hex = `0x${'11'.repeat(32)}`;
export const registryAddress: Hex = '0x00000000000000000000000000000000000000aa';
export const imageDigest: Hex = `0x${'ab'.repeat(32)}`;

/** Real quicknet round 1000, signed by the real network. It is the only round tests can open. */
export const beacon = {
  round: 1000,
  randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd',
  signature:
    'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
};

export function offlineQuicknet(latestRound: number = beacon.round): ChainClient {
  const info: ChainInfo = defaultChainInfo;
  return {
    options: { disableBeaconVerification: false, noCache: true },
    chain: () => ({ baseUrl: 'offline', info: () => Promise.resolve(info) }),
    latest: () => Promise.resolve({ ...beacon, round: latestRound }),
    get: (round) => {
      if (round !== beacon.round) throw new Error('too early: no beacon for this round');
      return Promise.resolve(beacon);
    },
  };
}

export const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export async function p256() {
  const pair = await subtle.generateKey(ecdsa, true, ['sign', 'verify']);
  return { pair, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

/** Low-s `r || s` over the message preimage, as the TEE signs. */
export async function teeSign(key: CryptoKey, preimage: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(preimage)));
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  let s = 0n;
  for (const byte of raw.subarray(32)) s = (s << 8n) | BigInt(byte);
  if (s > order / 2n) raw.set(Uint8Array.from(Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex')), 32);
  return raw;
}

const b64 = (data: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(data)));
/** Issued a minute ago, so a live check's window holds and the test certificates cover it. */
const iat = Math.floor(Date.now() / 1000) - 60;
const day = 86_400_000;

/** A leaf, intermediate and root, with the root standing in for Google's. */
export async function makePki(at: number = iat) {
  const [rootKeys, interKeys, leafKeys] = await Promise.all([
    subtle.generateKey(rsa, true, ['sign', 'verify']),
    subtle.generateKey(rsa, true, ['sign', 'verify']),
    subtle.generateKey(rsa, true, ['sign', 'verify']),
  ]);
  const base = { notBefore: new Date(at * 1000 - 30 * day), notAfter: new Date(at * 1000 + 30 * day), signingAlgorithm: rsa };
  const root = await X509CertificateGenerator.createSelfSigned({
    ...base,
    serialNumber: '01',
    name: 'CN=Test Root',
    keys: rootKeys,
    extensions: [new BasicConstraintsExtension(true, undefined, true)],
  });
  const intermediate = await X509CertificateGenerator.create({
    ...base,
    serialNumber: '02',
    subject: 'CN=Test Intermediate',
    issuer: root.subject,
    publicKey: interKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new BasicConstraintsExtension(true, undefined, true)],
  });
  const leaf = await X509CertificateGenerator.create({
    ...base,
    serialNumber: '03',
    subject: 'CN=Test Leaf',
    issuer: intermediate.subject,
    publicKey: leafKeys.publicKey,
    signingKey: interKeys.privateKey,
  });
  return { root: new Uint8Array(root.rawData), intermediate, leaf, rootCert: root as X509Certificate, leafKey: leafKeys.privateKey };
}

export type Pki = Awaited<ReturnType<typeof makePki>>;

export const tokenIssuedAt = iat;

export async function signToken(claims: Record<string, unknown>, pki: Pki): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: 'RS256',
      x5c: [b64(pki.leaf.rawData), b64(pki.intermediate.rawData), b64(pki.rootCert.rawData)],
    })
    .sign(pki.leafKey);
}

export const criteria = {
  maxSetterPercent: 30,
  minBankMultiple: 3,
  topics: [
    { name: 'Maths', questions: 2 },
    { name: 'Physics', questions: 1 },
  ],
};

export const paper: Paper = {
  examId,
  questions: [
    { topic: 'Maths', text: 'Differentiate x squared.' },
    { topic: 'Maths', text: 'Integrate 2x.' },
    { topic: 'Physics', text: 'Which law relates force and acceleration?', options: ['First law', 'Second law', 'Third law'] },
  ],
};

/** The list holds a setter only as the hash of its own passkey public key, and never as a name. */
export function approvedList(): ApprovedListEntry[] {
  const key = (n: number) => Uint8Array.from([0x04, n, ...random(63)]);
  const entry = (role: number, name: string, n: number): ApprovedListEntry => {
    const passkeyPublicKey = key(n);
    return {
      role,
      owner: role === 1 ? setterOwner(passkeyPublicKey) : name,
      passkeyPublicKey,
      derivedPublicKey: role === 1 ? new Uint8Array(0) : key(n + 100),
    };
  };
  return [
    entry(1, '', 1),
    ...[0, 1, 2].map((i) => entry(2, `Neutral ${String(i + 1)}`, 10 + i)),
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => entry(3, `Centre ${String(i + 1)}`, 20 + i)),
    entry(4, 'Approved centre', 40),
  ];
}

export interface WorldOptions {
  /** Which files storage holds besides the manifest. Defaults to everything written before the Build. */
  unlocked?: boolean;
  endRound?: number;
  /** Corrupts the Build's saltedPaperHash, as if the TEE committed to another paper. */
  wrongSaltedHash?: boolean;
  /** The paper's content, if not the default. */
  paper?: Paper;
  /** Binds the release token to a key other than the one that signed the log. */
  badReleaseToken?: boolean;
  /** The Build's `selected`, if not the paper's question count. */
  selected?: number;
}

/** A whole exam: chain records, storage files, a PKI token and a release log. */
export async function buildWorld(options: WorldOptions = {}) {
  const { unlocked = true, endRound = beacon.round } = options;
  const client = offlineQuicknet();
  const examBytes = fromHex(examId);
  const signing = await p256();
  const entries = approvedList();
  const entriesBytes = encodeApprovedList(entries);
  const criteriaBytes = encodeCriteria(criteria);
  const thePaper = options.paper ?? paper;
  const paperBytes = encodePaper(thePaper);

  const k = random(32);
  const kPub = random(32);
  const kPriv = xorCombine(k, kPub);
  const seed = random(32);
  const paperFile = await aesGcmEncrypt(k, new Uint8Array([...seed, ...padPaper(paperBytes)]), examBytes);
  const sealAt = (round: number, secret: Uint8Array) => timelockEncrypt(round, TlockBuffer.from(secret), client);
  const seal = (secret: Uint8Array) => sealAt(beacon.round, secret);

  const holders = entries.filter((e) => e.role === 2 || e.role === 3);
  const shares = holders.map((holder) => ({ holder, bytes: random(80) }));
  const pki = await makePki();

  const exam = {
    settings: {
      examId,
      examStart: 1_900_000_000n,
      delta: 3600n,
      lockRound: 100n,
      unlockRound: 200n,
      endRound: BigInt(endRound),
      criteriaHash: toHex(criteriaHash(criteriaBytes)),
      rpcHost: 'rpc.example.org',
    },
    commitHash: `0x${'cd'.repeat(20)}`,
    imageDigest,
    createdAt: 1n,
    createdBlock: 1n,
  } as unknown as Exam;

  const settings = examSettings(exam, registryAddress);
  const claims = {
    iss: 'https://confidentialcomputing.googleapis.com',
    aud: 'paperseal',
    iat,
    exp: iat + 3600,
    swname: 'CONFIDENTIAL_SPACE',
    dbgstat: 'disabled-since-boot',
    hwmodel: 'GCP_AMD_SEV',
    secboot: true,
    eat_nonce: attestationNonce(signing.publicKey, examBytes),
    submods: {
      confidential_space: { support_attributes: ['STABLE'] },
      container: { image_digest: `sha256:${imageDigest.slice(2)}`, args: ['/tee', ...startupArgs(settings)], cmd_override: startupArgs(settings), env_override: { STORAGE_BUCKET: teeStorageBucket } },
    },
  };
  const token = await signToken(claims, pki);

  const sha = (bytes: Uint8Array) => toHex(encryptedPaperHash(bytes));
  const files = new Map<string, Uint8Array>();
  files.set('paper.bin', paperFile);
  files.set('key-pub.tlock', new TextEncoder().encode(await seal(kPub)));
  files.set('token.jwt', new TextEncoder().encode(token));
  for (const { holder, bytes } of shares) files.set(`shares/${toHex(holder.derivedPublicKey)}.bin`, bytes);
  const manifest = {
    examId,
    files: [...files.entries()]
      .map(([name, bytes]) => {
        const share = shares.find((s) => name === `shares/${toHex(s.holder.derivedPublicKey)}.bin`);
        return {
          name,
          sha256: sha(bytes),
          ...(share
            ? { recipient: toHex(share.holder.derivedPublicKey), shareHash: toHex(hashMessage('shareHash', { share: share.bytes })) }
            : {}),
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  files.set('manifest.json', manifestBytes);

  const selected = options.selected ?? thePaper.questions.length;
  const salted = saltedPaperHash(seed, paperBytes);
  const buildFields = {
    examId: examBytes,
    approvedListHash: approvedListHash(examBytes, entriesBytes),
    paperHash: encryptedPaperHash(paperFile),
    storageManifestHash: storageManifestHash(manifestBytes),
    saltedPaperHash: options.wrongSaltedHash ? random(32) : salted,
    selected,
    bankSize: 30,
    criteriaHash: criteriaHash(criteriaBytes),
  };
  const build = {
    approvedListHash: toHex(buildFields.approvedListHash),
    paperHash: toHex(buildFields.paperHash),
    storageManifestHash: toHex(buildFields.storageManifestHash),
    saltedPaperHash: toHex(buildFields.saltedPaperHash),
    selected,
    bankSize: 30,
    postedAt: 1n,
    criteriaHash: toHex(buildFields.criteriaHash),
    teeSignature: toHex(await teeSign(signing.pair.privateKey, encodeMessage('build', buildFields))),
    instancePublicKey: toHex(signing.publicKey),
  } as unknown as Build;

  // Unlock ran on a fresh instance, with its own key and its own attested token.
  const unlockSigning = await p256();
  const releaseToken = await signToken(
    { ...claims, eat_nonce: attestationNonce(options.badReleaseToken ? signing.publicKey : unlockSigning.publicKey, examBytes) },
    pki,
  );
  // Eight holders released: the three neutral parties and five centres.
  const releasedHolders = holders.slice(0, 8);
  const logEntries = releasedHolders.map((holder, i) => ({
    passkeyPublicKey: toHex(holder.passkeyPublicKey),
    shareHash: toHex(random(32)),
    round: String(200 + i),
  }));
  const wire = logEntries.map((e) => ({ passkeyPublicKey: fromHex(e.passkeyPublicKey), shareHash: fromHex(e.shareHash), round: BigInt(e.round) }));
  const logHash = entriesHash(wire);
  const releaseLog = {
    examId,
    entries: logEntries,
    entriesHash: toHex(logHash),
    teeSignature: toHex(await teeSign(unlockSigning.pair.privateKey, encodeMessage('releaseLog', { examId: examBytes, entriesHash: logHash }))),
    instancePublicKey: toHex(unlockSigning.publicKey),
  };
  files.set('release-token.jwt', new TextEncoder().encode(releaseToken));
  files.set('release-log.json', new TextEncoder().encode(JSON.stringify(releaseLog)));
  if (unlocked) {
    files.set('key-priv.tlock', new TextEncoder().encode(await seal(kPriv)));
  }

  const storage = (replace: Record<string, Uint8Array | null> = {}): StorageReader => ({
    url: (name) => `https://files.example/${examId}/${name}`,
    get: (name) => Promise.resolve(name in replace ? (replace[name] ?? null) : (files.get(name) ?? null)),
  });

  return {
    client,
    signing,
    unlockSigning,
    entries,
    entriesHex: toHex(entriesBytes),
    criteriaHex: toHex(criteriaBytes),
    exam,
    build,
    pki,
    token,
    claims,
    files,
    manifest,
    releaseLog,
    storage,
    seed,
    k,
    kPub,
    kPriv,
    seal,
    sealAt,
    holders,
  };
}

export type World = Awaited<ReturnType<typeof buildWorld>>;
