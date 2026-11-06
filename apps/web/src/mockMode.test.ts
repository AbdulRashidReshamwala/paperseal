// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockMode, mockTrustedRoot, rootOption } from './shared/mockMode';

/*
 * The mock suite trusts a test attestation root, and that must never be possible in a real build. These
 * tests are the guard: the apps trust nothing extra by default, a production build holds no trace of the
 * mock path, a build with the test root set is refused, and so is a build in mock mode.
 */

const SENTINEL = 'bW9jay1yb290LXNlbnRpbmVsLWRvLW5vdC11c2U=';
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

describe('mock mode', () => {
  it('is off in the default mode, even when the root variable is set', () => {
    vi.stubEnv('VITE_MOCK_TRUST_ROOT', SENTINEL);
    expect(mockMode).toBe(false);
    expect(mockTrustedRoot()).toBeUndefined();
    expect(rootOption()).toEqual({});
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

  it('leaves no trace of the mock path in a production build', async () => {
    const text = await production();
    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain('VITE_MOCK_TRUST_ROOT');
    expect(text).not.toContain('Mock data');
    expect(text).not.toContain('data-mock-label');
  }, 180_000);

  it('refuses to build, or serve, outside mock mode with a test root set', async () => {
    vi.stubEnv('VITE_MOCK_TRUST_ROOT', SENTINEL);
    await expect(production()).rejects.toThrow(/must never reach a real build/);
  }, 60_000);

  it('refuses to build in mock mode', async () => {
    const out = mkdtempSync(join(tmpdir(), 'paperseal-build-'));
    try {
      await expect(build({ root, mode: 'mock', logLevel: 'silent', build: { outDir: out } })).rejects.toThrow(/cannot be built/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
