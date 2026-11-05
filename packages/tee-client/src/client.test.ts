import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTeeClient, isReleaseNotOpen, TeeApiError, type TeeClient } from './index';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function client(response: () => Response) {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(response()),
  );
  return { fetch, tee: createTeeClient({ baseUrl: 'http://tee.test/', fetch }) };
}

const calls: [string, string, (tee: TeeClient) => Promise<unknown>][] = [
  ['GET', '/v1/attestation', (t) => t.attestation()],
  ['GET', '/v1/status', (t) => t.status()],
  ['GET', '/v1/registrations', (t) => t.registrations()],
  ['POST', '/v1/register/challenge', (t) => t.registerChallenge()],
  ['POST', '/v1/register', (t) => t.register({ owner: 'o' } as never)],
  ['POST', '/v1/questions/challenge', (t) => t.questionChallenge()],
  ['POST', '/v1/questions', (t) => t.question({ ciphertext: '0x00' } as never)],
  ['GET', '/v1/outbox', (t) => t.outbox()],
  ['POST', '/v1/release/challenge', (t) => t.releaseChallenge()],
  ['POST', '/v1/release/share', (t) => t.releaseShare({ sealed: '0x00' } as never)],
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

  it('sends an empty object to the challenge routes', async () => {
    for (const route of ['registerChallenge', 'questionChallenge', 'releaseChallenge'] as const) {
      const { fetch, tee } = client(() => ok({ challenge: '0x00' }));
      await tee[route]();
      expect(fetch.mock.calls[0]?.[1]?.body).toBe('{}');
    }
  });

  it('sends request bodies as given', async () => {
    const { fetch, tee } = client(() => ok({}));
    const body = { passkeyPublicKey: '0x04', challenge: '0x01', sealed: '0x02' } as const;
    await tee.releaseShare(body);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual(body);
  });

  // docs/ARCHITECTURE.md is not this package's to edit. Its route list is out of date, see the report.
  it('covers exactly the routes in the TEE API table of spec/api.md', () => {
    const spec = readFileSync(resolve(import.meta.dirname, '../../../spec/api.md'), 'utf8');
    const table = spec.slice(spec.indexOf('## TEE API\n'), spec.indexOf('## Unlock Instance'));
    const routes = [...table.matchAll(/^\| `(GET|POST) (\/v1\/[^`]+)`/gm)].map((m) => `${String(m[1])} ${String(m[2])}`);
    expect(routes).toHaveLength(11);
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

  it('recognises the too_early refusal of a release challenge', async () => {
    const { tee } = client(
      () => new Response(JSON.stringify({ error: { code: 'too_early', message: 'not yet' } }), { status: 425 }),
    );
    const error = await tee.releaseChallenge().catch((e: unknown) => e);
    expect(isReleaseNotOpen(error)).toBe(true);
    expect(isReleaseNotOpen(new TeeApiError(400, 'bad_share', 'no'))).toBe(false);
    expect(isReleaseNotOpen(new Error('network'))).toBe(false);
  });
});
