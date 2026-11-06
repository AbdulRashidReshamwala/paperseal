import { createServer, type Server } from 'node:http';

import type { Browser } from 'playwright-core';

import { startApp, startChain, type Chain } from '../src/chain';
import { startEnsRpc, type EnsRpc } from '../src/ens';
import { stopAll } from '../src/procs';
import { launchUiChrome } from './kit';
import { startStubTee, type StubTee } from './stubTee';

/*
 * The local layer: a throwaway anvil chain with the real ExamRegistry, a stub TEE and a stub public
 * storage at the apps' network boundary, and the two real apps served by Vite on `localhost` (a
 * passkey needs a real host name, not an IP address).
 */

export interface Storage {
  url: string;
  /** Files served under /<examId>/<name>. Anything else is 404. */
  files: Map<string, Uint8Array>;
  stop: () => Promise<void>;
}

export async function startStorage(): Promise<Storage> {
  const files = new Map<string, Uint8Array>();
  const server: Server = createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\//, '');
    const body = files.get(key);
    const cors = { 'access-control-allow-origin': '*' };
    if (!body) {
      res.writeHead(404, cors);
      res.end('not found');
      return;
    }
    res.writeHead(200, cors);
    res.end(Buffer.from(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('storage has no port');
  return { url: `http://127.0.0.1:${String(address.port)}`, files, stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve(); }); }) };
}

export interface Lab {
  chain: Chain;
  /** The chain's RPC with ENS answered from a table, which is what the apps read. Tests set up the names people are invited under. */
  ens: EnsRpc;
  tee: StubTee;
  storage: Storage;
  web: { url: string };
  verifier: { url: string };
  browser: Browser;
  stop: () => Promise<void>;
}

export async function startLab(): Promise<Lab> {
  const chain = await startChain();
  const ens = await startEnsRpc(chain.rpcUrl);
  const tee = await startStubTee();
  const storage = await startStorage();
  const common = { VITE_RPC_URL: ens.rpcUrl, VITE_REGISTRY_ADDRESS: chain.registry, VITE_STORAGE_URL: storage.url };
  const verifier = await startApp('apps/verifier', { ...common }, { host: 'localhost' });
  const web = await startApp(
    'apps/web',
    { ...common, VITE_TEE_URL: tee.url, VITE_TEE_STORAGE_BUCKET: 'stub-bucket', VITE_VERIFIER_URL: verifier.url },
    { host: 'localhost' },
  );
  const browser = await launchUiChrome();
  // Warm Vite's dependency optimiser once, so a reload cannot happen in the middle of a test.
  for (const base of [web.url, verifier.url]) {
    const warm = await browser.newPage();
    await warm.goto(base);
    await warm.waitForLoadState('networkidle');
    if (base === web.url) {
      for (const area of ['board', 'setter', 'keyholder', 'centre', 'join']) {
        await warm.goto(`${base}/#/${area}`);
        await warm.waitForLoadState('networkidle');
      }
    }
    await warm.close();
  }
  return {
    chain,
    ens,
    tee,
    storage,
    web,
    verifier,
    browser,
    stop: async () => {
      await browser.close().catch(() => undefined);
      await web.stop();
      await verifier.stop();
      await storage.stop();
      await tee.stop();
      await ens.stop();
      await chain.stop();
      await stopAll();
    },
  };
}
