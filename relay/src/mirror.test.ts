import { instanceKeyHash, MirrorInputError, type HeartbeatInput, type MirrorInput, type MirrorResult } from '@paperseal/arkiv';
import type { Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MirrorTarget } from './args';
import { mirrorPass, newMemo, tally, type RelayWriter } from './mirror';
import { fetchStorageFile, storageObjectUrl, type Fetch } from './storage';
import { abortableSleep, watch, type Beat, type HeartbeatDeps } from './watch';

const examId: Hex = `0x${'ab'.repeat(32)}`;
const otherExam: Hex = `0x${'cd'.repeat(32)}`;
const registry = '0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8';
const keyA: Hex = `0x04${'11'.repeat(64)}`;
const keyB: Hex = `0x04${'22'.repeat(64)}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const storage = 'https://storage.example/bucket';
const tee = 'https://tee.example';
const jwt = (tag: string) => `aGVhZA.${tag}.c2ln`;

function logBody(options: { exam?: Hex; entries?: number; entriesHash?: Hex; key?: Hex } = {}): string {
  return JSON.stringify({
    examId: options.exam ?? examId,
    entries: Array.from({ length: options.entries ?? 1 }, (_, i) => ({ passkeyPublicKey: keyA, shareHash: hash(i + 1), round: String(i + 1) })),
    entriesHash: options.entriesHash ?? hash(100 + (options.entries ?? 1)),
    teeSignature: `0x${'00'.repeat(64)}`,
    instancePublicKey: options.key ?? keyA,
  });
}

type Route = () => Response;
const json = (value: unknown, status = 200): Route => () => new Response(JSON.stringify(value), { status });
const text = (value: string): Route => () => new Response(value);
const missing: Route = () => new Response('<Error>NoSuchKey</Error>', { status: 404 });

/** A fetch that answers from a URL table and 404s the rest. Unrouted TEE paths fail like a dead host. */
function routes(table: Record<string, Route | Error>): Fetch & { urls: string[] } {
  const urls: string[] = [];
  const send = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const route = table[url];
    if (route instanceof Error) return Promise.reject(route);
    return Promise.resolve(route ? route() : missing());
  }) as Fetch & { urls: string[] };
  send.urls = urls;
  return send;
}

const storageFiles = (log?: string, token?: string): Record<string, Route> => ({
  ...(log === undefined ? {} : { [storageObjectUrl(storage, examId, 'release-log.json')]: text(log) }),
  ...(token === undefined ? {} : { [storageObjectUrl(storage, examId, 'release-token.jwt')]: text(token) }),
});

const teeRoutes = (options: { stage?: string; listExam?: Hex; log?: string | Route; token?: string; key?: Hex }): Record<string, Route> => ({
  [`${tee}/v1/status`]: json({
    stage: options.stage ?? 'unlock',
    questionCount: 4,
    ...(options.listExam ? { approvedList: { examId: options.listExam, entries: '0x', hash: hash(9), teeSignature: '0x' } } : {}),
    release: { released: [], required: 2 },
  }),
  [`${tee}/v1/release/log`]:
    options.log === undefined
      ? json({ error: { code: 'wrong_stage', message: 'this is only accepted during unlock' } }, 409)
      : typeof options.log === 'string'
        ? text(options.log)
        : options.log,
  [`${tee}/v1/attestation`]: json({
    token: options.token ?? jwt('dGVl'),
    instancePublicKey: options.key ?? keyA,
    encryptionPublicKey: keyB,
    instanceKeySignature: '0x00',
  }),
});

/** Records every call in order, and answers like packages/arkiv's writer. */
function fakeWriter(existing: { tokens?: string[]; logs?: string[] } = {}) {
  const calls: { kind: 'token' | 'log'; input: MirrorInput & { instancePublicKey?: Hex } }[] = [];
  let n = 0;
  const answer = (exists: boolean): MirrorResult => {
    n += 1;
    return exists ? { written: false, entityKey: hash(1000 + n) } : { written: true, entityKey: hash(1000 + n), txHash: hash(2000 + n) };
  };
  const writer: RelayWriter = {
    address: '0x1111111111111111111111111111111111111111',
    mirrorReleaseToken: vi.fn((input: MirrorInput & { instancePublicKey: Hex }) => {
      calls.push({ kind: 'token', input });
      return Promise.resolve(answer(existing.tokens?.includes(instanceKeyHash(input.instancePublicKey)) ?? false));
    }),
    mirrorReleaseLog: vi.fn((input: MirrorInput) => {
      calls.push({ kind: 'log', input });
      const entriesHash = (JSON.parse(new TextDecoder().decode(input.body)) as { entriesHash: string }).entriesHash;
      return Promise.resolve(answer(existing.logs?.includes(entriesHash) ?? false));
    }),
  };
  return { writer, calls };
}

const target = (sources: { storage?: boolean; tee?: boolean }): MirrorTarget => ({
  examId,
  registry,
  storageUrl: sources.storage ? storage : undefined,
  teeUrl: sources.tee ? tee : undefined,
});

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const summary = (outcomes: { kind: string; source: string; result: string }[]) => outcomes.map((o) => `${o.kind}/${o.source}/${o.result}`);

describe('storage', () => {
  it('builds <base>/<examId>/<name> like apps/verifier, lowercasing the exam ID', () => {
    expect(storageObjectUrl(`${storage}/`, examId.toUpperCase().replace('0X', '0x') as Hex, 'release-log.json')).toBe(
      `${storage}/${examId}/release-log.json`,
    );
  });

  it('returns exact bytes, null on 404, and throws on other errors', async () => {
    const send = routes({
      [`${storage}/${examId}/a`]: text('{"x": 1 }'),
      [`${storage}/${examId}/b`]: () => new Response('nope', { status: 500 }),
    });
    expect(decode((await fetchStorageFile(send, storage, examId, 'a')) ?? new Uint8Array())).toBe('{"x": 1 }');
    expect(await fetchStorageFile(send, storage, examId, 'missing')).toBeNull();
    await expect(fetchStorageFile(send, storage, examId, 'b')).rejects.toThrow('storage returned 500 for b');
  });
});

describe('mirrorPass', () => {
  it('writes the storage token before the log, with their exact bytes and the log signer key', async () => {
    const body = logBody({ entries: 2 });
    const { writer, calls } = fakeWriter();
    const report = await mirrorPass(target({ storage: true }), { fetch: routes(storageFiles(body, jwt('c3Rv'))), writer, chainId: 11155111 });

    expect(calls.map((c) => c.kind)).toEqual(['token', 'log']);
    expect(decode(calls[0]?.input.body ?? new Uint8Array())).toBe(jwt('c3Rv'));
    expect(calls[0]?.input.instancePublicKey).toBe(keyA);
    expect(decode(calls[1]?.input.body ?? new Uint8Array())).toBe(body);
    expect(calls[1]?.input).toMatchObject({ examId, registry, chainId: 11155111 });
    expect(summary(report.outcomes)).toEqual(['token/storage/written', 'log/storage/written']);
    expect(report.outcomes[0]).toMatchObject({ entityKey: hash(1001), txHash: hash(2001), key: instanceKeyHash(keyA) });
    expect(report.outcomes[1]?.detail).toBe('2 entries');
  });

  it('refuses a log for another exam, and the token beside it, without writing', async () => {
    const { writer, calls } = fakeWriter();
    const report = await mirrorPass(target({ storage: true }), {
      fetch: routes(storageFiles(logBody({ exam: otherExam }), jwt('c3Rv'))),
      writer,
      chainId: 1,
    });
    expect(calls).toHaveLength(0);
    expect(summary(report.outcomes)).toEqual(['log/storage/refused', 'token/storage/refused']);
    expect(report.outcomes[0]?.detail).toContain(otherExam);
    expect(tally(report).refused).toBe(2);
  });

  it('refuses a TEE log for another exam', async () => {
    const { writer, calls } = fakeWriter();
    const report = await mirrorPass(target({ tee: true }), { fetch: routes(teeRoutes({ log: logBody({ exam: otherExam }) })), writer, chainId: 1 });
    expect(calls).toHaveLength(0);
    expect(summary(report.outcomes)).toEqual(['log/tee/refused']);
  });

  it('tolerates missing files and an unreachable TEE: notes only, no writes', async () => {
    const { writer, calls } = fakeWriter();
    const send = routes({ [`${tee}/v1/status`]: new TypeError('fetch failed'), [`${tee}/v1/release/log`]: new TypeError('fetch failed') });
    const report = await mirrorPass(target({ storage: true, tee: true }), { fetch: send, writer, chainId: 1 });
    expect(calls).toHaveLength(0);
    expect(report.outcomes).toHaveLength(0);
    expect(report.notes).toEqual(
      expect.arrayContaining([
        'storage: no release-log.json yet',
        'storage: no release-token.jwt yet',
        expect.stringContaining('tee: could not read /v1/status'),
        expect.stringContaining('tee: could not read /v1/release/log'),
      ]),
    );
  });

  it('notes a TEE that has no log at its stage, without asking for its token', async () => {
    const { writer } = fakeWriter();
    const send = routes(teeRoutes({ stage: 'submit', listExam: examId }));
    const report = await mirrorPass(target({ tee: true }), { fetch: send, writer, chainId: 1 });
    expect(report.notes[0]).toMatch(/^tee: no release log at stage submit/);
    expect(send.urls).not.toContain(`${tee}/v1/attestation`);
    expect(report.tee).toEqual({ stage: 'submit', servesExam: true });
  });

  it('holds a token whose log is missing, and writes nothing', async () => {
    const { writer, calls } = fakeWriter();
    const report = await mirrorPass(target({ storage: true }), { fetch: routes(storageFiles(undefined, jwt('c3Rv'))), writer, chainId: 1 });
    expect(calls).toHaveLength(0);
    expect(summary(report.outcomes)).toEqual(['token/storage/held']);
  });

  it('with TEE and storage both present, writes each token and log once, tokens first', async () => {
    const body = logBody({ entries: 2 });
    const { writer, calls } = fakeWriter();
    const send = routes({ ...storageFiles(body, jwt('c3Rv')), ...teeRoutes({ stage: 'released', listExam: examId, log: body }) });
    const report = await mirrorPass(target({ storage: true, tee: true }), { fetch: send, writer, chainId: 1 });

    expect(calls.map((c) => c.kind)).toEqual(['token', 'log']);
    expect(summary(report.outcomes)).toEqual(['token/storage/written', 'token/tee/skipped', 'log/storage/written', 'log/tee/skipped']);
    expect(report.outcomes[1]).toMatchObject({ detail: 'same instance key as the storage token', entityKey: hash(1001) });
    expect(report.tee).toEqual({ stage: 'released', servesExam: true });
  });

  it('writes a newer TEE log beside an older storage log, both after the token', async () => {
    const { writer, calls } = fakeWriter();
    const send = routes({ ...storageFiles(logBody({ entries: 1 }), jwt('c3Rv')), ...teeRoutes({ listExam: examId, log: logBody({ entries: 3 }) }) });
    const report = await mirrorPass(target({ storage: true, tee: true }), { fetch: send, writer, chainId: 1 });
    expect(calls.map((c) => c.kind)).toEqual(['token', 'log', 'log']);
    expect(summary(report.outcomes)).toEqual(['token/storage/written', 'token/tee/skipped', 'log/storage/written', 'log/tee/written']);
  });

  it('mirrors the TEE token for the TEE log signer, and holds it when another instance answers', async () => {
    const body = logBody({ key: keyA });
    const good = fakeWriter();
    const report = await mirrorPass(target({ tee: true }), { fetch: routes(teeRoutes({ log: body, token: jwt('dGVl') })), writer: good.writer, chainId: 1 });
    expect(good.calls.map((c) => [c.kind, c.input.instancePublicKey])).toEqual([['token', keyA], ['log', undefined]]);
    expect(decode(good.calls[0]?.input.body ?? new Uint8Array())).toBe(jwt('dGVl'));
    expect(report.tee.servesExam).toBe(true);

    const other = fakeWriter();
    const held = await mirrorPass(target({ tee: true }), { fetch: routes(teeRoutes({ log: body, key: keyB })), writer: other.writer, chainId: 1 });
    expect(other.calls).toHaveLength(0);
    expect(summary(held.outcomes)).toEqual(['token/tee/held', 'log/tee/held']);
  });

  it('ignores a TEE that serves another exam', async () => {
    const { writer, calls } = fakeWriter();
    const send = routes(teeRoutes({ stage: 'released', listExam: otherExam, log: logBody() }));
    const report = await mirrorPass(target({ tee: true }), { fetch: send, writer, chainId: 1 });
    expect(calls).toHaveLength(0);
    expect(report.tee).toEqual({ stage: 'released', servesExam: false });
    expect(report.notes[0]).toContain('not this one');
  });

  it('reports rows the writer already has as skipped', async () => {
    const body = logBody();
    const { writer } = fakeWriter({ tokens: [instanceKeyHash(keyA)], logs: [hash(101)] });
    const report = await mirrorPass(target({ storage: true }), { fetch: routes(storageFiles(body, jwt('c3Rv'))), writer, chainId: 1 });
    expect(summary(report.outcomes)).toEqual(['token/storage/skipped', 'log/storage/skipped']);
    expect(report.outcomes[0]).toMatchObject({ detail: 'already on Arkiv from this writer', entityKey: hash(1001) });
    expect(report.outcomes[0]?.txHash).toBeUndefined();
  });

  it('holds the log when its token write fails, and refuses on a MirrorInputError', async () => {
    const { writer } = fakeWriter();
    writer.mirrorReleaseToken = vi.fn(() => Promise.reject(new Error('HTTP request failed: status 503')));
    const report = await mirrorPass(target({ storage: true }), { fetch: routes(storageFiles(logBody(), jwt('c3Rv'))), writer, chainId: 1 });
    expect(summary(report.outcomes)).toEqual(['token/storage/failed', 'log/storage/held']);
    expect(writer.mirrorReleaseLog).not.toHaveBeenCalled();

    writer.mirrorReleaseToken = vi.fn(() => Promise.reject(new MirrorInputError('release token body is not a compact JWT')));
    const refused = await mirrorPass(target({ storage: true }), { fetch: routes(storageFiles(logBody(), 'not a jwt')), writer, chainId: 1 });
    expect(summary(refused.outcomes)).toEqual(['token/storage/refused', 'log/storage/held']);
  });

  it('does not ask Arkiv again for rows it confirmed earlier in the run', async () => {
    const { writer, calls } = fakeWriter();
    const memo = newMemo();
    const deps = { fetch: routes(storageFiles(logBody(), jwt('c3Rv'))), writer, chainId: 1 };
    await mirrorPass(target({ storage: true }), deps, memo);
    const second = await mirrorPass(target({ storage: true }), deps, memo);
    expect(calls).toHaveLength(2);
    expect(summary(second.outcomes)).toEqual(['token/storage/skipped', 'log/storage/skipped']);
    expect(second.outcomes.every((o) => o.detail === 'already mirrored in this run')).toBe(true);
  });

  it('reports the logs it read for this exam, and writes no heartbeat (mirror is one pass)', async () => {
    const { writer } = fakeWriter();
    const heartbeat = vi.fn();
    const send = routes({ ...storageFiles(logBody({ entries: 1 }), jwt('c3Rv')), ...teeRoutes({ listExam: examId, log: logBody({ entries: 3 }) }) });
    const report = await mirrorPass(target({ storage: true, tee: true }), { fetch: send, writer: Object.assign(writer, { heartbeat }), chainId: 1 });
    expect(report.logs).toEqual([
      { source: 'storage', entriesHash: hash(101), entries: 1 },
      { source: 'tee', entriesHash: hash(103), entries: 3 },
    ]);
    expect(heartbeat).not.toHaveBeenCalled();
  });
});

describe('watch', () => {
  const noSleep = () => Promise.resolve();

  it('writes only new snapshots and stops once the TEE says released', async () => {
    const { writer, calls } = fakeWriter();
    const passes = [
      teeRoutes({ stage: 'unlock', listExam: examId, log: logBody({ entries: 1 }) }),
      teeRoutes({ stage: 'unlock', listExam: examId, log: logBody({ entries: 1 }) }),
      teeRoutes({ stage: 'unlock', listExam: examId, log: logBody({ entries: 2 }) }),
      teeRoutes({ stage: 'released', listExam: examId, log: logBody({ entries: 3 }) }),
    ];
    let pass = 0;
    const send: Fetch = (input, init) => routes(passes[Math.min(pass, passes.length - 1)] ?? {})(input, init);
    const reports: string[][] = [];
    const end = await watch(target({ tee: true }), 10, {
      fetch: send,
      writer,
      chainId: 1,
      signal: new AbortController().signal,
      sleep: () => {
        pass += 1;
        return Promise.resolve();
      },
      onReport: (report) => reports.push(summary(report.outcomes)),
      onError: () => undefined,
    });
    expect(end).toBe('released');
    expect(reports).toHaveLength(4);
    expect(calls.map((c) => c.kind)).toEqual(['token', 'log', 'log', 'log']);
    expect(reports[1]).toEqual(['token/tee/skipped', 'log/tee/skipped']);
  });

  it('keeps going through TEE and storage errors until stopped', async () => {
    const { writer } = fakeWriter();
    const controller = new AbortController();
    let sleeps = 0;
    const errors: string[] = [];
    const notes: string[][] = [];
    const end = await watch(target({ storage: true, tee: true }), 10, {
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      writer,
      chainId: 1,
      signal: controller.signal,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 3) controller.abort();
        return Promise.resolve();
      },
      onReport: (report) => notes.push(report.notes),
      onError: (message) => errors.push(message),
    });
    expect(end).toBe('stopped');
    expect(notes).toHaveLength(3);
    expect(notes[0]?.length).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual([]);
  });

  it('does not stop on a TEE that shows another exam as released', async () => {
    const { writer } = fakeWriter();
    const controller = new AbortController();
    let sleeps = 0;
    const end = await watch(target({ tee: true }), 10, {
      fetch: routes(teeRoutes({ stage: 'released', listExam: otherExam, log: logBody() })),
      writer,
      chainId: 1,
      signal: controller.signal,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 2) controller.abort();
        return noSleep();
      },
      onReport: () => undefined,
      onError: () => undefined,
    });
    expect(end).toBe('stopped');
    expect(sleeps).toBe(2);
  });

  it('retries a few passes when the TEE is done but a write failed', async () => {
    const { writer } = fakeWriter();
    writer.mirrorReleaseToken = vi.fn(() => Promise.reject(new Error('HTTP request failed')));
    const errors: string[] = [];
    const end = await watch(target({ tee: true }), 10, {
      fetch: routes(teeRoutes({ stage: 'released', listExam: examId, log: logBody() })),
      writer,
      chainId: 1,
      signal: new AbortController().signal,
      sleep: noSleep,
      onReport: () => undefined,
      onError: (message) => errors.push(message),
      finalRetries: 2,
    });
    expect(end).toBe('released');
    expect(writer.mirrorReleaseToken).toHaveBeenCalledTimes(3);
    expect(errors).toHaveLength(2);
  });
});

describe('watch heartbeats', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A heartbeat writer that records what each beat said and when, by the (fake) clock. */
  function beats(fail: (n: number) => boolean = () => false) {
    const calls: { at: number; input: HeartbeatInput }[] = [];
    const written: Beat[] = [];
    const write = vi.fn((input: HeartbeatInput) => {
      calls.push({ at: Date.now(), input });
      if (fail(calls.length)) return Promise.reject(new Error('HTTP request failed: status 503'));
      return Promise.resolve({ entityKey: hash(3000 + calls.length), txHash: hash(4000 + calls.length) });
    });
    const deps: HeartbeatDeps = { seconds: 60, write, onWritten: (beat) => written.push(beat) };
    return { calls, written, write, deps };
  }

  /** Watches with real abortable sleeps on fake timers; `table` can be swapped between steps. */
  function start(sources: { storage?: boolean; tee?: boolean }, first: Record<string, Route>, heartbeat: HeartbeatDeps | undefined) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
    const state = { table: first, passes: 0, errors: [] as string[] };
    const controller = new AbortController();
    const { writer } = fakeWriter();
    const ended = watch(target(sources), 10, {
      fetch: (input, init) => routes(state.table)(input, init),
      writer,
      chainId: 1,
      signal: controller.signal,
      sleep: abortableSleep,
      onReport: () => {
        state.passes += 1;
      },
      onError: (message) => state.errors.push(message),
      heartbeat,
    });
    return { state, controller, ended, writer };
  }

  it('beats after the first pass and then every heartbeatSeconds, apart from --every, until the TEE says released', async () => {
    const hb = beats();
    const { state, ended } = start({ tee: true }, teeRoutes({ stage: 'unlock', listExam: examId, log: logBody({ entries: 1 }) }), hb.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.passes).toBe(1);
    expect(hb.calls.map((c) => c.at)).toEqual([0]);

    state.table = teeRoutes({ stage: 'unlock', listExam: examId, log: logBody({ entries: 2 }) });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(state.passes).toBe(6);
    expect(hb.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(hb.calls.map((c) => c.at)).toEqual([0, 60_000, 120_000]);

    state.table = teeRoutes({ stage: 'released', listExam: examId, log: logBody({ entries: 3 }) });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(ended).resolves.toBe('released');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(hb.calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.errors).toEqual([]);
  });

  it('carries the newest entriesHash seen and the stage of a TEE serving this exam', async () => {
    const hb = beats();
    const { state, controller, ended } = start(
      { storage: true, tee: true },
      { ...storageFiles(logBody({ entries: 2 }), jwt('c3Rv')), ...teeRoutes({ stage: 'unlock', listExam: examId, log: logBody({ entries: 1 }) }) },
      hb.deps,
    );
    await vi.advanceTimersByTimeAsync(0);
    // The storage log has more entries than the TEE's, so it is the newest.
    expect(hb.calls[0]?.input).toEqual({ examId, registry, chainId: 1, entriesHash: hash(102), stage: 'unlock' });
    expect(hb.written[0]).toMatchObject({ entriesHash: hash(102), stage: 'unlock', entityKey: hash(3001), txHash: hash(4001) });

    state.table = { ...storageFiles(logBody({ entries: 2 }), jwt('c3Rv')), ...teeRoutes({ stage: 'unlock', listExam: examId, log: logBody({ entries: 4 }) }) };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hb.calls[1]?.input).toMatchObject({ entriesHash: hash(104), stage: 'unlock' });

    // An unreachable TEE leaves the last stage it read, and storage alone never shrinks the log.
    state.table = storageFiles(logBody({ entries: 2 }), jwt('c3Rv'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hb.calls[2]?.input).toMatchObject({ entriesHash: hash(104), stage: 'unlock' });

    controller.abort();
    await expect(ended).resolves.toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says null for the stage of a TEE serving another exam, and for a log when none was seen', async () => {
    const hb = beats();
    const { controller, ended } = start({ tee: true }, teeRoutes({ stage: 'failed', listExam: otherExam, log: logBody({ exam: otherExam }) }), hb.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(hb.calls[0]?.input).toMatchObject({ entriesHash: null, stage: null });
    controller.abort();
    await expect(ended).resolves.toBe('stopped');
  });

  it('prints a failed heartbeat and tries again next tick, without stopping the passes', async () => {
    const hb = beats((n) => n === 1);
    const { state, controller, ended } = start({ tee: true }, teeRoutes({ stage: 'unlock', listExam: examId, log: logBody() }), hb.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.errors).toEqual(['heartbeat failed, trying again in 60s: Error: HTTP request failed: status 503']);
    expect(hb.written).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.passes).toBe(7);
    expect(hb.calls.map((c) => c.at)).toEqual([0, 60_000]);
    expect(hb.written).toHaveLength(1);
    controller.abort();
    await expect(ended).resolves.toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes none when the first pass already ends the watch, or with --no-heartbeat', async () => {
    const done = beats();
    const first = start({ tee: true }, teeRoutes({ stage: 'released', listExam: examId, log: logBody() }), done.deps);
    await vi.advanceTimersByTimeAsync(0);
    await expect(first.ended).resolves.toBe('released');
    expect(done.write).not.toHaveBeenCalled();

    const heartbeat = vi.fn();
    const off = start({ tee: true }, teeRoutes({ stage: 'unlock', listExam: examId, log: logBody() }), undefined);
    Object.assign(off.writer, { heartbeat });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(off.state.passes).toBe(31);
    expect(heartbeat).not.toHaveBeenCalled();
    off.controller.abort();
    await expect(off.ended).resolves.toBe('stopped');
  });
});
