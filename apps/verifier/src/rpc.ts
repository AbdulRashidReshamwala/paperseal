import { BaseError, http, type Transport } from 'viem';

/** How many reads go to the public record at once. Page loads fan out, and a public source limits bursts. */
export const READS_AT_ONCE = 4;
/** How many times one read is sent before its failure is passed on. */
export const READ_TRIES = 3;
/** The pause after a source says it is busy: 1, 2, 4, then 8 seconds, until a read answers. */
const FIRST_PAUSE_MS = 1000;
const MAX_PAUSE_MS = 8000;
/** The longest wait this page takes on a source's word. A longer one is not waited out: reads fail at once until it ends. */
const MAX_RETRY_AFTER_MS = MAX_PAUSE_MS;

/** Whether a failed read's message says the source is limiting requests. */
export const sourceBusy = (message: string): boolean => /\b429\b|exceeds defined limit|too many requests|rate.?limit/i.test(message);

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_CODES = new Set([-1, -32005, -32007, -32603, 429]);

/** A failure that says nothing about the record: asking again may answer. A revert is an answer, and is not retried. */
function worthRetrying(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return Boolean(
    error.walk((cause) => {
      const { code, status } = cause as { code?: unknown; status?: unknown };
      return (typeof code === 'number' && RETRY_CODES.has(code)) || (typeof status === 'number' && RETRY_STATUS.has(status));
    }),
  );
}

const isBusy = (error: unknown) => error instanceof Error && sourceBusy(error.message);

/** How long a limited source asks to be left alone, from its `Retry-After` seconds, or 0 if it does not say. */
function retryAfterMs(error: unknown): number {
  if (!(error instanceof BaseError)) return 0;
  let seconds = 0;
  error.walk((cause) => {
    const { headers } = cause as { headers?: { get?: (name: string) => string | null } };
    seconds ||= Number(headers?.get?.('Retry-After')) || 0;
    return false;
  });
  return Math.max(seconds, 0) * 1000;
}

function waitWords(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? 'in about a minute' : `in about ${String(minutes)} minutes`;
}

const blockNumber = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);

/** An answer that can't change: a call at a named block, or the logs of one named block. Empty logs are not kept. */
function lasting(method: string, params: unknown, answer: unknown): boolean {
  if (!Array.isArray(params)) return false;
  if (method === 'eth_call') return blockNumber(params[1]);
  if (method !== 'eth_getLogs') return false;
  const { fromBlock, toBlock } = (params[0] ?? {}) as { fromBlock?: unknown; toBlock?: unknown };
  return blockNumber(fromBlock) && fromBlock === toBlock && Array.isArray(answer) && answer.length > 0;
}

const pauseFor = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface Read {
  method: string;
  params?: unknown;
}

/**
 * Sends reads to one source so that a load asks as little as it can. Identical reads under way are
 * sent once, an answer that can't change is kept for this visit, and only `READS_AT_ONCE` go at a time.
 * A read that gets no answer is sent again, up to `READ_TRIES` times, and a source that says it is busy
 * pauses every read to it. A failure that remains is passed on unchanged. A source that asks for a
 * longer wait than a read can sit through is not asked again until that ends: reads fail at once and
 * say so, because a read left waiting would outlive its load, and all of them would land together.
 */
export function politeReads(
  send: (read: Read) => Promise<unknown>,
  sleep: (ms: number) => Promise<void> = pauseFor,
  { source = 'This source', now = Date.now }: { source?: string; now?: () => number } = {},
) {
  const kept = new Map<string, unknown>();
  const underWay = new Map<string, Promise<unknown>>();
  const queue: (() => void)[] = [];
  let active = 0;
  let strikes = 0;
  let pausing = false;
  let pause: Promise<void> = Promise.resolve();
  let limitedUntil = 0;

  const limited = () => new Error(`${source} has reached its rate limit. It can be read again ${waitWords(limitedUntil - now())}.`);

  const enter = async () => {
    if (active < READS_AT_ONCE) active += 1;
    else {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    let seen: Promise<void>;
    do {
      seen = pause;
      await seen;
    } while (seen !== pause);
  };
  const leave = () => {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  };
  const holdOff = () => {
    strikes += 1;
    if (pausing) return;
    pausing = true;
    pause = sleep(Math.min(FIRST_PAUSE_MS * 2 ** (strikes - 1), MAX_PAUSE_MS)).then(() => {
      pausing = false;
    });
  };

  const attempt = async (read: Read): Promise<unknown> => {
    for (let tries = 1; ; tries += 1) {
      await enter();
      try {
        if (now() < limitedUntil) throw limited();
        const answer = await send(read);
        strikes = 0;
        return answer;
      } catch (error) {
        const wait = retryAfterMs(error);
        if (wait > MAX_RETRY_AFTER_MS) limitedUntil = Math.max(limitedUntil, now() + wait);
        if (now() < limitedUntil) throw limited();
        if (isBusy(error)) holdOff();
        if (tries >= READ_TRIES || !worthRetrying(error)) throw error;
      } finally {
        leave();
      }
    }
  };

  return (read: Read): Promise<unknown> => {
    const key = JSON.stringify([read.method, read.params]);
    if (kept.has(key)) return Promise.resolve(kept.get(key));
    const held = underWay.get(key);
    if (held) return held;
    const reading = attempt(read)
      .then((answer) => {
        if (lasting(read.method, read.params, answer)) kept.set(key, answer);
        return answer;
      })
      .finally(() => {
        underWay.delete(key);
      });
    underWay.set(key, reading);
    return reading;
  };
}

const transports = new Map<string, Transport>();

/** The one way this page reads an RPC. Every client of one URL shares it, so they share its limits. */
export function readTransport(rpcUrl: string, source?: string): Transport {
  const known = transports.get(rpcUrl);
  if (known) return known;
  const base = http(rpcUrl, { retryCount: 0 });
  let reads: ReturnType<typeof politeReads> | undefined;
  const transport: Transport = (options) => {
    const inner = base(options);
    reads ??= politeReads((read) => inner.request(read as Parameters<typeof inner.request>[0]), undefined, source === undefined ? {} : { source });
    return { ...inner, request: reads as unknown as typeof inner.request };
  };
  transports.set(rpcUrl, transport);
  return transport;
}
