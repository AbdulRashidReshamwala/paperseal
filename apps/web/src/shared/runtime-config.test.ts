import { chain } from '@paperseal/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appEnv, runtimeConfig, setRuntimeConfig } from './runtime-config';
import { releasesRepo } from './teeReleases';

const registry = `0x${'1'.repeat(40)}`;
const examId = `0x${'a'.repeat(64)}`;

const file = {
  teeUrl: 'https://tee.board.example',
  rpcUrl: 'https://rpc.board.example',
  registry,
  chainId: chain.chainId,
  storageUrl: 'https://storage.googleapis.com/board-bucket',
  storageBucket: 'board-bucket',
  repository: 'board/paperseal',
  examId,
};

afterEach(() => {
  setRuntimeConfig({});
  vi.unstubAllEnvs();
});

describe('appEnv', () => {
  it('takes each setting from config.json when its VITE_ value is unset', () => {
    setRuntimeConfig(file);
    expect(appEnv({})).toMatchObject({
      VITE_TEE_URL: file.teeUrl,
      VITE_RPC_URL: file.rpcUrl,
      VITE_REGISTRY_ADDRESS: registry,
      VITE_STORAGE_URL: file.storageUrl,
      VITE_TEE_STORAGE_BUCKET: 'board-bucket',
      VITE_RELEASES_REPO: 'board/paperseal',
      VITE_EXAM_ID: examId,
    });
    expect(releasesRepo()).toBe('board/paperseal');
  });

  it('lets a VITE_ value win over config.json, and a blank one fall through', () => {
    setRuntimeConfig(file);
    vi.stubEnv('VITE_TEE_URL', 'https://tee.dev.example');
    vi.stubEnv('VITE_RPC_URL', '  ');
    const env = appEnv();
    expect(env.VITE_TEE_URL).toBe('https://tee.dev.example');
    expect(env.VITE_RPC_URL).toBe(file.rpcUrl);
  });

  it('leaves a setting with neither value unset, and passes other settings through', () => {
    expect(appEnv({ VITE_VERIFIER_URL: 'https://verify.example' })).toMatchObject({
      VITE_TEE_URL: undefined,
      VITE_REGISTRY_ADDRESS: undefined,
      VITE_VERIFIER_URL: 'https://verify.example',
    });
  });
});

describe('setRuntimeConfig', () => {
  it('ignores an invalid config.json', () => {
    for (const raw of [null, 'teeUrl', [file], 42]) {
      setRuntimeConfig(raw);
      expect(runtimeConfig()).toEqual({});
    }
    setRuntimeConfig({ teeUrl: 'javascript:alert(1)', registry: '0x12', storageBucket: 7, repository: 'just-a-name', rpcUrl: file.rpcUrl });
    expect(runtimeConfig()).toEqual({ rpcUrl: file.rpcUrl });
    expect(appEnv({}).VITE_TEE_URL).toBeUndefined();
  });

  it("drops the chain fields of a file for another chain, and keeps the rest", () => {
    setRuntimeConfig({ ...file, chainId: chain.chainId + 1, chainName: 'elsewhere' });
    const config = runtimeConfig();
    expect(config).not.toHaveProperty('chainId');
    expect(config).not.toHaveProperty('chainName');
    expect(config).not.toHaveProperty('rpcUrl');
    expect(config).not.toHaveProperty('registry');
    expect(config.teeUrl).toBe(file.teeUrl);
    expect(appEnv({}).VITE_REGISTRY_ADDRESS).toBeUndefined();
  });
});
