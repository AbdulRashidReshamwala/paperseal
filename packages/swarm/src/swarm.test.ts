import { describe, expect, it, vi } from 'vitest';

import {
  collectionTar,
  createSwarmClient,
  formatBzz,
  InvalidPathError,
  minAmount,
  minDepth,
  stampCost,
  swarm,
  SwarmApiError,
  SwarmReadError,
} from './index';

const apiUrl = 'http://bee.test:1633';
const batchId = 'f56af59cc2c785a3b45bbf3e46c3c4b20f80379339ef337b5bbf45ebe5629a66';
const reference = '36b7efd913ca4cf880b8eeac5093fa27b0825906c600685b6abdd6566e6cfe8f';

/** A client whose `fetch` returns `response` and records every call. */
function mockClient(response: () => Response | Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  return { client: createSwarmClient({ apiUrl: `${apiUrl}/`, fetch }), fetch };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The URL and init of the only `fetch` call. */
function onlyCall(fetch: ReturnType<typeof mockClient>['fetch']): { url: string; init: RequestInit } {
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  return { url: String(url), init: init ?? {} };
}

describe('uploadCollection', () => {
  const files = [
    { path: 'manifest.json', bytes: new TextEncoder().encode('{}') },
    { path: 'paper.bin', bytes: new Uint8Array([1, 2, 3]) },
  ];

  it.each([
    [undefined, 'false'],
    [false, 'false'],
    [true, 'true'],
  ])('posts the tar to /bzz with exactly the collection headers and no Swarm-Encrypt (deferred %s)', async (deferred, header) => {
    const { client, fetch } = mockClient(() => jsonResponse({ reference }, 201));
    const options = deferred === undefined ? { batchId } : { batchId, deferred };
    expect(await client.uploadCollection(files, options)).toEqual({ reference });

    const { url, init } = onlyCall(fetch);
    expect(url).toBe(`${apiUrl}/bzz`);
    expect(init.method).toBe('POST');
    expect(init.headers).toStrictEqual({
      'Content-Type': 'application/x-tar',
      'Swarm-Collection': 'true',
      'Swarm-Postage-Batch-Id': batchId,
      'Swarm-Deferred-Upload': header,
    });
    const names = Object.keys(init.headers as Record<string, string>).map((name) => name.toLowerCase());
    expect(names).not.toContain('swarm-encrypt');
    expect(init.body).toEqual(await collectionTar(files));
  });

  it('rejects an encrypted or malformed reference in the response', async () => {
    for (const bad of [reference + reference, reference.toUpperCase(), `0x${reference}`]) {
      const { client } = mockClient(() => jsonResponse({ reference: bad }, 201));
      await expect(client.uploadCollection(files, { batchId })).rejects.toThrow(SwarmApiError);
    }
  });

  it('checks the batch ID and paths before sending', async () => {
    const { client, fetch } = mockClient(() => jsonResponse({ reference }, 201));
    await expect(client.uploadCollection(files, { batchId: `0x${batchId}` })).rejects.toThrow(TypeError);
    await expect(client.uploadCollection(files, { batchId: batchId.toUpperCase() })).rejects.toThrow(TypeError);
    const bad = [{ path: '/etc/passwd', bytes: new Uint8Array(1) }];
    await expect(client.uploadCollection(bad, { batchId })).rejects.toThrow(InvalidPathError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns a Bee error into a SwarmApiError with its status and message', async () => {
    const { client } = mockClient(() => jsonResponse({ code: 402, message: 'batch not usable' }, 402));
    const error = await client.uploadCollection(files, { batchId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwarmApiError);
    expect(error).toMatchObject({ status: 402, endpoint: 'POST /bzz' });
    expect((error as Error).message).toContain('batch not usable');
  });
});

describe('download', () => {
  it('returns the bytes on 200, from the encoded path', async () => {
    const { client, fetch } = mockClient(() => new Response(new Uint8Array([9, 8, 7]), { status: 200 }));
    expect(await client.download(reference, 'key-priv/0x04ab cd.bin')).toEqual(new Uint8Array([9, 8, 7]));
    const { url, init } = onlyCall(fetch);
    expect(url).toBe(`${apiUrl}/bzz/${reference}/key-priv/0x04ab%20cd.bin`);
    expect(init.method).toBe('GET');
  });

  it('returns null on 404', async () => {
    const { client } = mockClient(() => jsonResponse({ code: 404, message: 'Not Found' }, 404));
    expect(await client.download(reference, 'manifest.json')).toBeNull();
  });

  it('throws SwarmReadError with the status on 500', async () => {
    const { client } = mockClient(() => jsonResponse({ code: 500, message: 'retrieval failed' }, 500));
    const error = await client.download(reference, 'manifest.json').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwarmReadError);
    expect(error).toBeInstanceOf(SwarmApiError);
    expect(error).toMatchObject({ status: 500, endpoint: `GET /bzz/${reference}/manifest.json` });
    expect((error as Error).message).toContain('retrieval failed');
  });

  it('throws SwarmReadError with status 0 when the node is unreachable', async () => {
    const { client } = mockClient(() => Promise.reject(new TypeError('fetch failed')));
    const error = await client.download(reference, 'manifest.json').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwarmReadError);
    expect(error).toMatchObject({ status: 0 });
  });

  it('rejects an encrypted reference and a bad path without a request', async () => {
    const { client, fetch } = mockClient(() => new Response(null, { status: 200 }));
    await expect(client.download(reference + reference, 'manifest.json')).rejects.toThrow(TypeError);
    await expect(client.download(reference, '../manifest.json')).rejects.toThrow(InvalidPathError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('stamps', () => {
  it('buys an immutable batch at /stamps/{amount}/{depth}', async () => {
    const { client, fetch } = mockClient(() => jsonResponse({ batchID: batchId, txHash: '0x51c7' }, 201));
    expect(await client.buyStamp({ amount: 100_000_000n, depth: 20, label: 'exam backup' })).toBe(batchId);
    const { url, init } = onlyCall(fetch);
    expect(url).toBe(`${apiUrl}/stamps/100000000/20?label=exam%20backup`);
    expect(init.method).toBe('POST');
    expect(init.headers).toStrictEqual({ Immutable: 'true' });
  });

  it('refuses a depth below the minimum or a non-positive amount without a request', async () => {
    const { client, fetch } = mockClient(() => jsonResponse({}));
    await expect(client.buyStamp({ amount: 1n, depth: minDepth - 1 })).rejects.toThrow(RangeError);
    await expect(client.buyStamp({ amount: 0n, depth: minDepth })).rejects.toThrow(RangeError);
    await expect(client.buyStamp({ amount: 1n, depth: 17.5 })).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('parses /stamps', async () => {
    const { client } = mockClient(() =>
      jsonResponse({
        stamps: [
          {
            batchID: batchId.toUpperCase(),
            utilization: 0,
            usable: true,
            label: '',
            depth: 17,
            amount: '432072000',
            bucketDepth: 16,
            blockNumber: 38498819,
            immutableFlag: true,
            exists: true,
            batchTTL: 82943,
          },
        ],
      }),
    );
    expect(await client.stamps()).toEqual([
      {
        batchId,
        usable: true,
        label: '',
        depth: 17,
        bucketDepth: 16,
        amount: 432072000n,
        utilization: 0,
        immutable: true,
        exists: true,
        ttlSeconds: 82943,
        blockNumber: 38498819,
      },
    ]);
  });

  it('treats a missing or null stamp list as empty', async () => {
    expect(await mockClient(() => jsonResponse({ stamps: null })).client.stamps()).toEqual([]);
  });
});

describe('node status', () => {
  it('parses /health, /addresses, /wallet and /chainstate', async () => {
    const bodies: Record<string, unknown> = {
      '/health': { status: 'ok', version: '2.8.3-8e9bb914', apiVersion: '8.2.1' },
      '/addresses': {
        overlay: 'dbbf',
        underlay: null,
        ethereum: '0x1a33',
        chain_address: '0x1a33',
        publicKey: '020e',
        pssPublicKey: '03d6',
      },
      '/wallet': {
        bzzBalance: '100000000000000000',
        nativeTokenBalance: '5000000000000000000',
        chainID: 11155111,
        walletAddress: '0x1a33',
      },
      '/chainstate': { chainTip: 12077612, block: 0, totalAmount: '0', currentPrice: '24000' },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => jsonResponse(bodies[new URL(String(url)).pathname]));
    const client = createSwarmClient({ apiUrl, fetch });

    expect(await client.health()).toEqual({ status: 'ok', version: '2.8.3-8e9bb914', apiVersion: '8.2.1' });
    expect(await client.addresses()).toEqual({
      overlay: 'dbbf',
      underlay: [],
      ethereum: '0x1a33',
      chainAddress: '0x1a33',
      publicKey: '020e',
      pssPublicKey: '03d6',
    });
    expect(await client.wallet()).toEqual({
      bzzBalance: 10n ** 17n,
      nativeTokenBalance: 5n * 10n ** 18n,
      chainId: 11155111,
      walletAddress: '0x1a33',
    });
    const chain = await client.chainState();
    expect(chain).toEqual({ chainTip: 12077612, block: 0, totalAmount: 0n, currentPrice: 24000n });
    expect(minAmount(chain)).toBe(24000n * 17280n);
    expect(minAmount({ ...chain, minimumValidityBlocks: 100 })).toBe(2_400_000n);
  });

  it('reports a 503 while the node syncs as a SwarmApiError', async () => {
    const { client } = mockClient(() =>
      jsonResponse({ code: 503, message: 'Node is syncing. This endpoint is unavailable. Try again later.' }, 503),
    );
    await expect(client.wallet()).rejects.toMatchObject({ name: 'SwarmApiError', status: 503 });
  });

  it('rejects a malformed body', async () => {
    const { client } = mockClient(() => jsonResponse({ bzzBalance: 12 }));
    await expect(client.wallet()).rejects.toThrow('field bzzBalance');
  });

  it('defaults to the spec API URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ status: 'ok', version: '', apiVersion: '' }));
    await createSwarmClient({ fetch }).health();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${swarm.defaultApiUrl}/health`);
  });
});

describe('stampCost', () => {
  it('is 2^depth * amount PLUR', () => {
    // The docs' own example: depth 24, amount 1e9 is 16777216000000000 PLUR, 1.6777216 xBZZ.
    expect(stampCost({ amount: 1_000_000_000n, depth: 24 })).toEqual({ plur: 16_777_216_000_000_000n, bzz: '1.6777216' });
    // The smallest batch at the docs' 24-hour minimum for a price of 24000.
    expect(stampCost({ amount: 24000n * 17280n, depth: minDepth })).toEqual({
      plur: 54_358_179_840_000n,
      bzz: '0.005435817984',
    });
  });

  it('formats whole and fractional BZZ', () => {
    expect(formatBzz(0n)).toBe('0');
    expect(formatBzz(10n ** 16n)).toBe('1');
    expect(formatBzz(1n)).toBe('0.0000000000000001');
    expect(formatBzz(25n * 10n ** 15n)).toBe('2.5');
  });

  it('refuses a depth below the minimum', () => {
    expect(minDepth).toBe(17);
    expect(() => stampCost({ amount: 1n, depth: 16 })).toThrow(RangeError);
    expect(() => stampCost({ amount: -1n, depth: 17 })).toThrow(RangeError);
  });
});
