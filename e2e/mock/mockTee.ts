import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import type { ExamRegistry } from '@paperseal/chain';
import {
  aesGcmEncrypt,
  hpkeContext,
  hpkeDeriveKeyPair,
  hpkeOpen,
  hpkeSeal,
  hpkeSerializePublicKey,
  xorCombine,
} from '@paperseal/crypto';
import {
  approvedListHash,
  attestation as attestationSpec,
  attestationNonce,
  chain as chainSpec,
  decodeApprovedList,
  decodeCriteria,
  decodeRelease,
  encodeMessage,
  encodePaper,
  encodeReleaseEntries,
  encryptedPaperHash,
  entriesHash,
  filesHash,
  fromHex,
  hashMessage,
  padPaper,
  parseQuestion,
  questionHash,
  roles,
  roundAtSeconds,
  roundTimeSeconds,
  saltedPaperHash,
  sortReleaseFiles,
  startupArgs,
  storageManifestHash,
  storageNames,
  threshold,
  toHex,
  unpadQuestion,
  type ApprovedListEntry,
  type Criteria,
  type ExamSettings,
  type Hex,
  type Question,
  type ReleaseEntry,
  type Stage,
} from '@paperseal/protocol';
import type { OutboxMessage, RegistrationEntry } from '@paperseal/tee-client';

import type { MockPki } from './pki';
import { timelockEncrypt } from './tlock';

/*
 * THE MOCK SEALED MACHINE, for the mock recordings only. It answers the routes of spec/api.md in
 * TypeScript, standing where the Go TEE stands, and it is NOT the Go TEE and NOT attested.
 *
 * Real here: the HPKE, AES-GCM, ECDSA P-256 and hashing (the same packages the apps use), the exact
 * messages, files and manifest of spec/api.md, the approved list and criteria read from the chain,
 * the checks that a share hashes to its manifest entry and that a question opens under its aad, the
 * drand timelock (sealed to the real quicknet rounds, opened by the browser with real beacons) and the
 * clock, which is the real drand clock with short rounds chosen by the exam's times.
 *
 * Replaced: the random choice of questions (it always puts a multiple choice question on the paper when the bank has one), the attestation (a throwaway root made by pki.ts), the Shamir split (a share is a random
 * value, and eight valid shares release the key), the WebAuthn signature checks at registration, on
 * questions and on release (the page still makes the signatures, this machine does not check them),
 * and the registration checks against the invite. Sepolia is a local anvil.
 *
 * Every artifact is written to the storage map, which the suite serves as the public bucket.
 */

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export interface MockTeeOptions {
  pki: MockPki;
  registry: Pick<ExamRegistry, 'getExam' | 'getCriteria' | 'getApprovedListEntries' | 'address'>;
  /** Files by `<examId>/<name>`. The suite serves this map as the public bucket. */
  storage: Map<string, Uint8Array>;
  bucket: string;
  log?: (message: string) => void;
}

export interface MockTee {
  url: string;
  /** Points the machine at an exam that is on the chain. Call after the board has published it. */
  init: (examId: Hex) => Promise<void>;
  stage: () => Stage;
  stop: () => Promise<void>;
}

async function signer() {
  const pair = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const sign = async (message: Uint8Array<ArrayBuffer> | Uint8Array): Promise<Hex> => {
    const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message as Uint8Array<ArrayBuffer>));
    let s = 0n;
    for (const byte of raw.subarray(32)) s = (s << 8n) | BigInt(byte);
    // The wire form is low-s.
    if (s > P256_N / 2n) {
      const low = P256_N - s;
      for (let i = 63; i >= 32; i--) raw[i] = Number((low >> BigInt((63 - i) * 8)) & 0xffn);
    }
    return toHex(raw);
  };
  return { publicKey, sign };
}

const readJson = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });

export async function startMockTee(options: MockTeeOptions): Promise<MockTee> {
  const say = options.log ?? (() => undefined);
  const instance = await signer();
  const encryptionKey = await hpkeDeriveKeyPair(randomBytes(32));
  const encryptionPublicKey = await hpkeSerializePublicKey(encryptionKey.publicKey);

  // Set by init().
  let examId: Hex | null = null;
  let examBytes = new Uint8Array();
  let settings: ExamSettings | null = null;
  let imageDigest: Hex = '0x';
  let criteria: Criteria | null = null;
  let stage: Stage = 'onboard';
  let lockMs = 0;
  let unlockMs = 0;
  let endMs = 0;

  const registrations: RegistrationEntry[] = [];
  let list: { entries: ApprovedListEntry[]; encoded: Hex; hash: Hex; teeSignature: Hex } | null = null;
  const bank: { setter: Hex; question: Question; hash: Hex }[] = [];
  const outbox: OutboxMessage[] = [];
  // Secrets of the Build, kept in memory only, as the real machine does.
  let kPriv: Uint8Array | null = null;
  const expectedShare = new Map<Hex, Hex>();
  const released: ReleaseEntry[] = [];
  let logBody: unknown = null;
  let delivering = false;

  const file = (name: string, data: Uint8Array) => options.storage.set(`${examId ?? ''}/${name}`, data);

  function token(): string {
    if (!settings) throw new Error('the mock machine has no exam yet');
    const iat = Math.floor(Date.now() / 1000);
    const args = startupArgs(settings);
    return options.pki.mint({
      iss: attestationSpec.issuer,
      aud: attestationSpec.audience,
      iat,
      nbf: iat,
      exp: iat + 3600,
      swname: attestationSpec.swname,
      dbgstat: attestationSpec.dbgstat,
      hwmodel: attestationSpec.hwModels[0],
      secboot: true,
      oemid: 11129,
      eat_nonce: [attestationNonce(instance.publicKey, fromHex(settings.examId))],
      submods: {
        confidential_space: { support_attributes: ['LATEST', attestationSpec.supportAttribute, 'USABLE'] },
        container: {
          image_digest: `sha256:${imageDigest.slice(2)}`,
          args: ['/tee', ...args],
          cmd_override: args,
          env_override: { STORAGE_BUCKET: options.bucket },
        },
      },
    });
  }

  async function init(id: Hex): Promise<void> {
    const registry = options.registry;
    const exam = await registry.getExam(id);
    if (!exam) throw new Error('the exam is not on the chain');
    const s = exam.settings;
    settings = {
      examId: id,
      examStart: Number(s.examStart),
      delta: Number(s.delta),
      lockRound: s.lockRound.toString(),
      unlockRound: s.unlockRound.toString(),
      endRound: s.endRound.toString(),
      criteriaHash: s.criteriaHash,
      rpcHost: s.rpcHost,
      registry: registry.address,
      chainId: chainSpec.chainId,
    };
    imageDigest = exam.imageDigest;
    const encoded = await registry.getCriteria(id);
    if (!encoded) throw new Error('the exam has no criteria on the chain');
    criteria = decodeCriteria(fromHex(encoded));
    examId = id;
    examBytes = fromHex(id);
    lockMs = roundTimeSeconds(Number(s.lockRound)) * 1000;
    unlockMs = roundTimeSeconds(Number(s.unlockRound)) * 1000;
    endMs = roundTimeSeconds(Number(s.endRound)) * 1000;
    say(`mock machine ready for ${id}: lock ${new Date(lockMs).toISOString()}, unlock ${new Date(unlockMs).toISOString()}`);
  }

  async function acceptList(): Promise<void> {
    if (list || !examId) return;
    const encoded = await options.registry.getApprovedListEntries(examId);
    if (!encoded) return;
    let entries: ApprovedListEntry[];
    try {
      entries = decodeApprovedList(fromHex(encoded));
    } catch (error) {
      say(`mock machine: the approved list failed its checks: ${(error as Error).message}`);
      stage = 'failed';
      return;
    }
    const known = new Set(registrations.map((r) => r.passkeyPublicKey.toLowerCase()));
    if (!entries.every((entry) => known.has(toHex(entry.passkeyPublicKey).toLowerCase()))) {
      say('mock machine: an entry on the list never registered here');
      stage = 'failed';
      return;
    }
    const hash = toHex(approvedListHash(examBytes, fromHex(encoded)));
    const teeSignature = await instance.sign(encodeMessage('approvedList', { examId: examBytes, entries: fromHex(encoded) }));
    list = { entries, encoded, hash, teeSignature };
    stage = 'submit';
    say('mock machine: approved list accepted, questions open');
  }

  async function lockAndBuild(): Promise<void> {
    if (!examId || !criteria || !list) return;
    stage = 'lock';
    const perTopic = new Map<string, typeof bank>();
    for (const item of bank) perTopic.set(item.question.topic, [...(perTopic.get(item.question.topic) ?? []), item]);
    for (const topic of criteria.topics) {
      const items = perTopic.get(topic.name) ?? [];
      if (items.length < topic.questions * criteria.minBankMultiple) {
        say(`mock machine: ${topic.name} has ${String(items.length)} questions, too few for the criteria`);
        stage = 'failed';
        return;
      }
      const bySetter = new Map<Hex, number>();
      for (const item of items) bySetter.set(item.setter, (bySetter.get(item.setter) ?? 0) + 1);
      for (const count of bySetter.values()) {
        if (count * 100 > criteria.maxSetterPercent * items.length) {
          say(`mock machine: a setter wrote too much of ${topic.name}`);
          stage = 'failed';
          return;
        }
      }
    }
    stage = 'build';
    const selected: Question[] = [];
    for (const topic of criteria.topics) {
      const items = [...(perTopic.get(topic.name) ?? [])];
      // A Fisher-Yates shuffle with the machine's own randomness.
      for (let i = items.length - 1; i > 0; i--) {
        const j = randomBytes(4).readUInt32BE() % (i + 1);
        [items[i], items[j]] = [items[j] as (typeof items)[number], items[i] as (typeof items)[number]];
      }
      const chosen = items.slice(0, topic.questions);
      // MOCK ONLY: the real machine picks at random. This one makes sure a topic that has a multiple choice question
      // in its bank shows one on the paper, so a recording of the paper always has lettered options to show.
      const spare = items.slice(topic.questions).find((item) => item.question.options);
      if (spare && !chosen.some((item) => item.question.options)) chosen[chosen.length - 1] = spare;
      selected.push(...chosen.map((item) => item.question));
    }
    const seed = new Uint8Array(randomBytes(32));
    const paperBytes = encodePaper({ examId, questions: selected });
    const plaintext = new Uint8Array(seed.length + padPaper(paperBytes).length);
    plaintext.set(seed);
    plaintext.set(padPaper(paperBytes), seed.length);
    const key = new Uint8Array(randomBytes(32));
    const kPub = new Uint8Array(randomBytes(32));
    kPriv = xorCombine(key, kPub);
    const paperFile = await aesGcmEncrypt(key, plaintext, examBytes);
    const keyPubTlock = new TextEncoder().encode(await timelockEncrypt(Number(settings?.unlockRound), kPub));

    const manifestFiles: { name: string; sha256: Hex; recipient?: Hex; shareHash?: Hex }[] = [];
    const written = new Map<string, Uint8Array>();
    const add = (name: string, data: Uint8Array, extra: { recipient?: Hex; shareHash?: Hex } = {}) => {
      written.set(name, data);
      manifestFiles.push({ name, sha256: toHex(sha256(data)), ...extra });
    };
    add(storageNames.paper, paperFile);
    add(storageNames.keyPub, keyPubTlock);
    for (const entry of list.entries) {
      if (entry.role !== roles.neutral && entry.role !== roles.centreKeyHolder) continue;
      const share = new Uint8Array(randomBytes(32));
      const shareHash = toHex(hashMessage('shareHash', { share }));
      expectedShare.set(toHex(entry.passkeyPublicKey).toLowerCase() as Hex, shareHash);
      add(storageNames.share(entry.derivedPublicKey), await hpkeSeal(entry.derivedPublicKey, share, hpkeContext('share', examBytes)), {
        recipient: toHex(entry.derivedPublicKey),
        shareHash,
      });
    }
    add(storageNames.token, new TextEncoder().encode(token()));
    const manifest = new TextEncoder().encode(JSON.stringify({ examId, files: sortReleaseFiles(manifestFiles) }));
    for (const [name, data] of written) file(name, data);
    file(storageNames.manifest, manifest);

    const fields = {
      approvedListHash: list.hash,
      paperHash: toHex(encryptedPaperHash(paperFile)),
      storageManifestHash: toHex(storageManifestHash(manifest)),
      saltedPaperHash: toHex(saltedPaperHash(seed, paperBytes)),
      selected: selected.length,
      bankSize: bank.length,
      criteriaHash: settings?.criteriaHash as Hex,
      // The newest drand round when the paper was sealed. The real machine reads it from the relay, this one from the clock.
      builtRound: BigInt(roundAtSeconds(Math.floor(Date.now() / 1000))),
    };
    const teeSignature = await instance.sign(
      encodeMessage('build', {
        examId: examBytes,
        approvedListHash: fromHex(fields.approvedListHash),
        paperHash: fromHex(fields.paperHash),
        storageManifestHash: fromHex(fields.storageManifestHash),
        saltedPaperHash: fromHex(fields.saltedPaperHash),
        selected: fields.selected,
        bankSize: fields.bankSize,
        criteriaHash: fromHex(fields.criteriaHash),
        builtRound: fields.builtRound,
      }),
    );
    outbox.push({
      kind: 'build',
      examId,
      fields: { ...fields, selected: String(fields.selected), bankSize: String(fields.bankSize), builtRound: fields.builtRound.toString() },
      teeSignature,
      instancePublicKey: toHex(instance.publicKey),
    });
    stage = 'distribute';
    say(`mock machine: built a paper of ${String(selected.length)} questions from a bank of ${String(bank.length)}`);
  }

  async function deliver(): Promise<void> {
    if (delivering || !examId || !kPriv || !list) return;
    delivering = true;
    const files: { name: string; sha256: Uint8Array }[] = [];
    const add = (name: string, data: Uint8Array) => {
      file(name, data);
      files.push({ name, sha256: sha256(data) });
    };
    for (const entry of list.entries) {
      if (entry.role !== roles.centre && entry.role !== roles.centreKeyHolder) continue;
      add(storageNames.centreKeyPriv(entry.derivedPublicKey), await hpkeSeal(entry.derivedPublicKey, kPriv, hpkeContext('keyPriv', examBytes)));
    }
    add(storageNames.keyPriv, new TextEncoder().encode(await timelockEncrypt(Number(settings?.endRound), kPriv)));
    file('release-token.jwt', new TextEncoder().encode(token()));
    const sorted = sortReleaseFiles(files);
    logBody = await logFor(sorted);
    file(storageNames.releaseLog, new TextEncoder().encode(JSON.stringify(logBody)));
    kPriv.fill(0);
    stage = 'released';
    say('mock machine: delivered the keys, the release log is signed');
  }

  async function logFor(files: { name: string; sha256: Uint8Array }[]) {
    const entries = [...released];
    const entriesDigest = entriesHash(entries);
    const filesDigest = filesHash(files);
    return {
      examId,
      entries: entries.map((e) => ({ passkeyPublicKey: toHex(e.passkeyPublicKey), shareHash: toHex(e.shareHash), round: e.round.toString() })),
      entriesHash: toHex(entriesDigest),
      files: files.map((f) => ({ name: f.name, sha256: toHex(f.sha256) })),
      filesHash: toHex(filesDigest),
      teeSignature: await instance.sign(encodeMessage('releaseLog', { examId: examBytes, entriesHash: entriesDigest, filesHash: filesDigest })),
      instancePublicKey: toHex(instance.publicKey),
    };
  }

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking || !examId) return;
    ticking = true;
    void (async () => {
      try {
        const now = Date.now();
        if (stage === 'onboard') await acceptList();
        else if (stage === 'submit' && now >= lockMs) await lockAndBuild();
        else if (stage === 'distribute' && now >= unlockMs) stage = 'unlock';
      } catch (error) {
        say(`mock machine: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        ticking = false;
      }
    })();
  }, 1000);

  const server: Server = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    void (async () => {
      try {
        const route = `${req.method ?? ''} ${path}`;
        if (!examId || !settings || !criteria) {
          fail(503, 'unavailable', 'The mock machine has no exam yet.');
          return;
        }
        switch (route) {
          case 'GET /v1/attestation':
            send(200, {
              token: token(),
              instancePublicKey: toHex(instance.publicKey),
              encryptionPublicKey: toHex(encryptionPublicKey),
              instanceKeySignature: await instance.sign(encodeMessage('instanceKey', { examId: examBytes, encryptionPublicKey })),
              attested: true,
            });
            return;
          case 'GET /v1/status': {
            const live: Stage = stage === 'distribute' && Date.now() >= unlockMs ? 'unlock' : stage;
            send(200, {
              stage: live,
              ...(examId ? { examId } : {}),
              questionCount: bank.length,
              ...(list ? { approvedList: { examId, entries: list.encoded, hash: list.hash, teeSignature: list.teeSignature } } : {}),
              release: { released: released.map((e) => toHex(e.passkeyPublicKey)), required: threshold.required },
            });
            return;
          }
          case 'GET /v1/registrations':
            send(200, { registrations });
            return;
          case 'GET /v1/outbox':
            send(200, { messages: outbox });
            return;
          case 'POST /v1/register/challenge':
          case 'POST /v1/questions/challenge':
            send(200, { challenge: toHex(randomBytes(32)) });
            return;
          case 'POST /v1/register': {
            const body = await readJson(req);
            if (list) {
              fail(409, 'registration_closed', 'The list is already on the chain, so registration is closed.');
              return;
            }
            registrations.push({
              owner: String(body.owner),
              passkeyPublicKey: body.passkeyPublicKey as Hex,
              derivedPublicKey: body.derivedPublicKey as Hex,
              inviteTag: body.inviteTag as Hex,
            });
            send(200, {});
            return;
          }
          case 'POST /v1/questions': {
            const body = await readJson(req);
            const passkey = String(body.passkeyPublicKey).toLowerCase() as Hex;
            if (stage !== 'submit') {
              fail(409, 'wrong_stage', 'Questions are not open.');
              return;
            }
            const setter = list?.entries.find((e) => e.role === roles.setter && toHex(e.passkeyPublicKey).toLowerCase() === passkey);
            if (!setter) {
              fail(403, 'not_a_setter', 'This key is not a setter on the approved list.');
              return;
            }
            const ciphertext = fromHex(String(body.ciphertext));
            let question: Question;
            try {
              const opened = await hpkeOpen(encryptionKey, ciphertext, hpkeContext('question', examBytes, fromHex(passkey)));
              question = parseQuestion(unpadQuestion(opened), criteria);
            } catch (error) {
              fail(400, 'invalid_question', `The question did not open or did not pass: ${(error as Error).message}`);
              return;
            }
            const hash = toHex(questionHash(ciphertext));
            bank.push({ setter: passkey, question, hash });
            send(200, {
              questionHash: hash,
              teeSignature: await instance.sign(encodeMessage('questionReceipt', { examId: examBytes, passkeyPublicKey: fromHex(passkey), questionHash: fromHex(hash) })),
            });
            return;
          }
          case 'POST /v1/release/challenge':
            if (Date.now() < unlockMs) fail(425, 'too_early', 'The unlock round is not published yet.');
            else send(200, { challenge: toHex(randomBytes(32)) });
            return;
          case 'POST /v1/release/share': {
            const body = await readJson(req);
            const passkey = String(body.passkeyPublicKey).toLowerCase() as Hex;
            if (Date.now() < unlockMs) {
              fail(425, 'too_early', 'The unlock round is not published yet.');
              return;
            }
            if (Date.now() > endMs) {
              fail(410, 'too_late', 'The end round is published, so shares are refused.');
              return;
            }
            if (stage !== 'unlock') {
              fail(409, 'wrong_stage', 'Shares are not being accepted.');
              return;
            }
            const wanted = expectedShare.get(passkey);
            if (!wanted) {
              fail(403, 'not_a_key_holder', 'This key holds no share.');
              return;
            }
            if (released.some((e) => toHex(e.passkeyPublicKey).toLowerCase() === passkey)) {
              fail(409, 'already_released', 'This share was already accepted.');
              return;
            }
            let share: Uint8Array;
            try {
              share = decodeRelease(await hpkeOpen(encryptionKey, fromHex(String(body.sealed)), hpkeContext('release', examBytes))).share;
            } catch (error) {
              fail(400, 'invalid_release', `The release did not open: ${(error as Error).message}`);
              return;
            }
            const shareHash = hashMessage('shareHash', { share });
            if (toHex(shareHash) !== wanted) {
              fail(400, 'wrong_share', 'This share does not match the manifest.');
              return;
            }
            released.push({ passkeyPublicKey: fromHex(passkey), shareHash, round: BigInt(roundAtSeconds(Math.floor(Date.now() / 1000))) });
            if (released.length >= threshold.required) void deliver();
            send(200, {});
            return;
          }
          case 'GET /v1/release/log':
            if (stage === 'released' && logBody) send(200, logBody);
            else if (released.length >= threshold.required) fail(503, 'delivery_pending', 'The files are being prepared.');
            else send(200, await logFor([]));
            return;
          default:
            fail(404, 'not_found', `The mock machine has no ${path}.`);
        }
      } catch (error) {
        fail(500, 'internal', error instanceof Error ? error.message : String(error));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock machine has no port');
  void encodeReleaseEntries;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    init,
    stage: () => stage,
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
