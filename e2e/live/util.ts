import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const stamp = (at: Date = new Date()): string => at.toISOString();

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

/** Writes via a temp file and a rename, so a reader never sees half a file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

const transientText =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|timed out|timeout|rate.?limit|too many requests|temporarily|bad gateway|service unavailable|gateway time-?out|network error|HTTP request failed|status: (429|5\d\d)/i;

/**
 * True for a failure of the network or an RPC node, never for a check. A check failure is an error
 * this code throws itself (it has none of these words), so it is never retried.
 */
export function isTransient(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const e = current as { name?: string; message?: string; status?: number; code?: unknown; cause?: unknown; shortMessage?: string };
    if (typeof e.status === 'number' && (e.status === 429 || e.status === 408 || e.status >= 500)) return true;
    if (e.name === 'HttpRequestError' || e.name === 'TimeoutError' || e.name === 'AbortError') return true;
    if (typeof e.code === 'number' && (e.code === -32005 || e.code === -32603 || e.code === 429)) return true;
    if (transientText.test(`${e.message ?? ''} ${e.shortMessage ?? ''}`)) return true;
    current = e.cause;
  }
  return false;
}

export async function retryTransient<T>(run: () => Promise<T>, options: { attempts?: number; baseMs?: number } = {}): Promise<T> {
  const attempts = options.attempts ?? 6;
  const base = options.baseMs ?? 1500;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      await sleep(Math.min(base * 2 ** (attempt - 1), 30_000));
    }
  }
}

export class PollTimeoutError extends Error {
  constructor(what: string, timeoutMs: number, last: string) {
    super(`timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for ${what}${last ? `; last: ${last}` : ''}`);
    this.name = 'PollTimeoutError';
  }
}

/**
 * Calls `probe` until it returns something other than undefined, null or false. A transient failure
 * is noted and the poll goes on; any other error ends it at once, because that is a check failing.
 */
export async function poll<T>(
  what: string,
  probe: () => Promise<T | undefined | null | false>,
  options: { timeoutMs: number; intervalMs?: number; onWait?: (note: string) => void },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last = '';
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
      last = 'not yet';
    } catch (error) {
      if (!isTransient(error)) throw error;
      last = errorText(error);
    }
    if (Date.now() >= deadline) throw new PollTimeoutError(what, options.timeoutMs, last);
    options.onWait?.(`${what}: ${last}`);
    await sleep(options.intervalMs ?? 10_000);
  }
}

export const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
export const short = (value: string, keep = 12): string => (value.length <= keep * 2 + 3 ? value : `${value.slice(0, keep)}...${value.slice(-8)}`);
