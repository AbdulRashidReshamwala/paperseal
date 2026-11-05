import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTeeClient, TeeApiError, type TeeClient } from './index';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function client(response: () => Response) {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(response()),
  );
  return { fetch, tee: createTeeClient({ baseUrl: 'http://tee.test/', fetch }) };
}

const hex = '0x00' as const;
const calls: [string, string, (tee: TeeClient) => Promise<unknown>][] = [
  ['GET', '/v1/attestation', (t) => t.attestation()],
  ['GET', '/v1/status', (t) => t.status()],
  ['POST', '/v1/register/challenge', (t) => t.registerChallenge({ holderId: 'h' })],
  ['POST', '/v1/register', (t) => t.register({ holderId: 'h' } as never)],
  ['POST', '/v1/onboard/list', (t) => t.onboardList({ examId: hex } as never)],
  ['POST', '/v1/questions', (t) => t.question({ examId: hex } as never)],
  ['POST', '/v1/lock', (t) => t.lock()],
  ['POST', '/v1/build', (t) => t.build()],
  ['GET', '/v1/outbox', (t) => t.outbox()],
  ['POST', '/v1/release/challenge', (t) => t.releaseChallenge({ holderId: 'h' })],
  ['POST', '/v1/release/share', (t) => t.releaseShare({ examId: hex, holderId: 'h', sealed: hex })],
  ['GET', '/v1/release/log', (t) => t.releaseLog()],
];

describe('routes', () => {
  it.each(calls)('%s %s', async (method, path, call) => {
    const { fetch, tee } = client(() => ok({ value: 1 }));
    expect(await call(tee)).toEqual({ value: 1 });
    expect(fetch.mock.calls[0]?.[0]).toBe(`http://tee.test${path}`);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe(method);
    if (method === 'POST') expect(fetch.mock.calls[0]?.[1]?.body).toBeTypeOf('string');
  });

  it('covers every route in docs/ARCHITECTURE.md', () => {
    const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/ARCHITECTURE.md'), 'utf8');
    const routes = [...doc.matchAll(/`(GET|POST) (\/v1\/[^`]+)`/g)].map((m) => `${String(m[1])} ${String(m[2])}`);
    expect(routes.length).toBeGreaterThan(0);
    expect(calls.map(([method, path]) => `${method} ${path}`).sort()).toEqual(routes.sort());
  });
});

describe('errors', () => {
  it('parses the spec error shape', async () => {
    const { tee } = client(
      () => new Response(JSON.stringify({ error: { code: 'bad_share', message: 'no' } }), { status: 400 }),
    );
    const error = await tee.status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeeApiError);
    expect(error).toMatchObject({ status: 400, code: 'bad_share', message: 'no' });
  });

  it('reports a non-conforming error body', async () => {
    const { tee } = client(() => new Response('oops', { status: 502 }));
    await expect(tee.status()).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('reports a non-JSON success body', async () => {
    const { tee } = client(() => new Response('oops', { status: 200 }));
    await expect(tee.status()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
