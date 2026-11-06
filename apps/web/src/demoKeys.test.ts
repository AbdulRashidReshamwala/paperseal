// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { credentialsOption, demoBar } from './shared/demoKeys';

/*
 * Demo keys sign with a public seed, and that must never be possible in a real build. These tests are
 * the guard, like mockMode.test.ts: the app is on real keys by default, a production build holds no trace
 * of the demo, a build with the flag set is refused, and so is a build in the demo's mode.
 */

const root = resolve(import.meta.dirname, '../');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function production(): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'paperseal-build-'));
  try {
    await build({ root, mode: 'production', logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    return files(out)
      .filter((file) => /\.(js|css|html)$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe('demo keys', () => {
  it('are off in the default mode, even with the flag set', () => {
    vi.stubEnv('VITE_DEMO_KEYS', '1');
    expect(demoBar()).toBeNull();
    expect(credentialsOption()).toEqual({});
  });

  it('leave no trace in a production build', async () => {
    const text = await production();
    expect(text.length).toBeGreaterThan(1000);
    for (const trace of ['Acting as', 'data-demo-label', 'paperseal-demo.persona', 'paperseal-demo.touch', 'demo-keys', 'VITE_DEMO_KEYS', 'public seed', 'Demo keys']) {
      expect(text).not.toContain(trace);
    }
  }, 180_000);

  it('refuse to build, or serve, outside the demo with the flag set', async () => {
    vi.stubEnv('VITE_DEMO_KEYS', '1');
    await expect(production()).rejects.toThrow(/must never reach a real build/);
  }, 60_000);

  it('refuse to build in the demo’s mode', async () => {
    const out = mkdtempSync(join(tmpdir(), 'paperseal-build-'));
    try {
      await expect(build({ root, mode: 'demo-keys', logLevel: 'silent', build: { outDir: out } })).rejects.toThrow(/cannot be built/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
