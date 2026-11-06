import { loadWebConfig, parseWebConfig, chain, type WebConfig } from '@paperseal/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { repository } from './custody';
import { resolveDefaults, runtimeConfig, setRuntimeConfig } from './runtime-config';

const config: WebConfig = {
  teeUrl: 'https://tee.board.example',
  rpcUrl: 'https://rpc.board.example',
  registry: `0x${'cd'.repeat(20)}`,
  storageUrl: 'https://files.board.example/exams',
  storageBucket: 'board-exams',
  repository: 'board/paperseal',
  examId: `0x${'22'.repeat(32)}`,
  arkivWriters: `0x${'ef'.repeat(20)}`,
  swarmApiUrl: 'https://bee.board.example',
  releaseTag: 'v1.2.3',
};

const memoryStorage = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
};

afterEach(() => {
  setRuntimeConfig({});
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config.json at runtime', () => {
  it('is empty until it is set', () => {
    expect(runtimeConfig()).toEqual({});
  });

  it('supplies every default when no VITE_ value is set', () => {
    expect(resolveDefaults({}, config)).toEqual({
      rpcUrl: config.rpcUrl,
      teeUrl: config.teeUrl,
      storageUrl: config.storageUrl,
      storageBucket: config.storageBucket,
      registryAddress: config.registry,
      examId: config.examId,
      arkivWriters: config.arkivWriters,
      swarmApiUrl: config.swarmApiUrl,
      releaseTag: config.releaseTag,
    });
    expect(repository({}, config)).toBe('board/paperseal');
  });

  it('gives way to a VITE_ value, and a blank one counts as unset', () => {
    const env = { VITE_RPC_URL: 'https://rpc.dev.example', VITE_TEE_STORAGE_BUCKET: 'dev-bucket', VITE_TEE_URL: '  ', VITE_RELEASES_REPO: 'me/fork' };
    const resolved = resolveDefaults(env, config);
    expect(resolved.rpcUrl).toBe('https://rpc.dev.example');
    expect(resolved.storageBucket).toBe('dev-bucket');
    expect(resolved.teeUrl).toBe(config.teeUrl);
    expect(repository(env, config)).toBe('me/fork');
  });

  it('ignores an invalid file, so the built-in defaults stand', async () => {
    const empty = resolveDefaults({}, {});
    const bad = parseWebConfig({ rpcUrl: 'javascript:alert(1)', registry: '0x12', storageBucket: 'Bad Bucket', teeUrl: 42 });
    expect(bad).toEqual({});
    expect(resolveDefaults({}, bad)).toEqual(empty);
    const notJson = async () => new Response('<!doctype html>', { status: 200 });
    expect(await loadWebConfig('./config.json', notJson as typeof fetch)).toEqual({});
    expect(repository({}, bad)).toBe('AbdulRashidReshamwala/paperseal');
  });

  it("drops the file's chain fields when it names another chain, and never switches", () => {
    setRuntimeConfig({ ...config, chainId: 1, chainName: 'mainnet' });
    expect(runtimeConfig()).toEqual(config);
    setRuntimeConfig({ ...config, chainId: chain.chainId, chainName: chain.name });
    expect(runtimeConfig().chainId).toBe(chain.chainId);
  });

  it('is read by the settings defaults when set before they load, and the viewer\'s saved bucket wins', async () => {
    for (const name of ['VITE_RPC_URL', 'VITE_TEE_STORAGE_BUCKET', 'VITE_REGISTRY_ADDRESS', 'VITE_STORAGE_URL']) vi.stubEnv(name, '');
    vi.resetModules();
    const fresh = await import('./runtime-config');
    fresh.setRuntimeConfig(config);
    const { defaultSettings, loadSettings } = await import('./settings');
    expect(defaultSettings).toMatchObject({
      rpcUrl: config.rpcUrl,
      storageBucket: config.storageBucket,
      registryAddress: config.registry,
      storageUrl: config.storageUrl,
    });
    const saved = memoryStorage({ 'paperseal.verifier.settings': JSON.stringify({ ...defaultSettings, storageBucket: 'viewer-bucket' }) });
    expect(loadSettings(saved).storageBucket).toBe('viewer-bucket');
    const broken = memoryStorage({ 'paperseal.verifier.settings': JSON.stringify({ ...defaultSettings, storageBucket: 'Not/A/Bucket' }) });
    expect(loadSettings(broken).storageBucket).toBe(config.storageBucket);
  });

  it('feeds env.ts, so the copy button names the release in config.json', async () => {
    for (const name of ['VITE_RELEASE_TAG', 'VITE_TEE_STORAGE_BUCKET']) vi.stubEnv(name, '');
    vi.resetModules();
    const fresh = await import('./runtime-config');
    fresh.setRuntimeConfig(config);
    const env = await import('./env');
    expect(env.releaseTag).toBe('v1.2.3');
    expect(env.teeStorageBucket).toBe(config.storageBucket);
  });

  it('rejects a malformed bucket in the Connection settings', async () => {
    const { defaultSettings, validateSettings } = await import('./settings');
    expect(validateSettings({ ...defaultSettings, storageBucket: 'Not A Bucket' })).toHaveProperty('storageBucket');
    expect(validateSettings({ ...defaultSettings, storageBucket: 'my-exam-bucket' })).not.toHaveProperty('storageBucket');
  });
});
