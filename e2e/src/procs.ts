import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/*
 * Every process the recordings start goes through here, in its own process group, so that
 * killing it also kills what it spawned (pnpm, vite, esbuild). Nothing is left running.
 */

interface Managed {
  child: ChildProcess;
  label: string;
  log: string[];
}
const managed = new Set<Managed>();

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  label: string;
}

export function spawnManaged(command: string, args: string[], options: SpawnOptions): Managed {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry: Managed = { child, label: options.label, log: [] };
  const keep = (chunk: Buffer) => {
    entry.log.push(chunk.toString('utf8'));
    if (entry.log.length > 200) entry.log.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.once('exit', () => {
    managed.delete(entry);
  });
  managed.add(entry);
  return entry;
}

function signalGroup(entry: Managed, signal: NodeJS.Signals): void {
  const pid = entry.child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Stops one process group, escalating to SIGKILL after a few seconds. */
export async function stop(entry: Managed): Promise<void> {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
    signalGroup(entry, 'SIGKILL');
    managed.delete(entry);
    return;
  }
  const exited = new Promise<void>((resolve) => entry.child.once('exit', () => { resolve(); }));
  signalGroup(entry, 'SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  signalGroup(entry, 'SIGKILL');
  managed.delete(entry);
}

export async function stopAll(): Promise<void> {
  await Promise.all([...managed].map(stop));
}

const killSync = () => {
  for (const entry of managed) signalGroup(entry, 'SIGKILL');
};
process.on('exit', killSync);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    killSync();
    process.exit(1);
  });
}

export function recentLog(entry: Managed): string {
  return entry.log.join('').slice(-2000);
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no free port'));
      });
    });
  });
}

export async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 60_000, entry?: Managed): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry && (entry.child.exitCode !== null || entry.child.signalCode !== null)) {
      throw new Error(`${entry.label} exited while waiting for ${what}:\n${recentLog(entry)}`);
    }
    try {
      if (await probe()) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${what}${entry ? `:\n${recentLog(entry)}` : ''}`);
}

export const httpOk = (url: string) => async () => (await fetch(url)).ok;
