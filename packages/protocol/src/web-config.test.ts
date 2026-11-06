import { describe, expect, it } from 'vitest';

import { loadWebConfig, parseWebConfig, pick } from './web-config';

describe('web config', () => {
  it('keeps valid fields and drops bad ones', () => {
    expect(
      parseWebConfig({ rpcUrl: 'https://rpc.example.org', registry: '0xnope', chainId: 11155111, storageBucket: 'b', extra: 1, teeUrl: 'https://tee.example.org\nx' }),
    ).toEqual({ rpcUrl: 'https://rpc.example.org', chainId: 11155111 });
  });

  it('treats a missing or broken file as empty', async () => {
    expect(await loadWebConfig('./config.json', () => Promise.resolve(new Response('nope', { status: 404 })))).toEqual({});
    expect(await loadWebConfig('./config.json', () => Promise.resolve(new Response('{not json')))).toEqual({});
    expect(await loadWebConfig('./config.json', () => Promise.reject(new Error('offline')))).toEqual({});
  });

  it('prefers the VITE_ value, then config.json, then the default', () => {
    expect(pick('https://a', 'https://b')).toBe('https://a');
    expect(pick(' ', 'https://b')).toBe('https://b');
    expect(pick(undefined, undefined, 'x')).toBe('x');
  });
});
