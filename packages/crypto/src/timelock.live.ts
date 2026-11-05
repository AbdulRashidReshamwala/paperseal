import { drand, roundAtSeconds } from '@paperseal/protocol';
import { Buffer, timelockEncrypt } from 'tlock-js';
import { expect, it } from 'vitest';

import { quicknetClient, timelockDecrypt } from './timelock';

/**
 * On demand: `pnpm --filter @paperseal/crypto test:live`. It talks to the real drand network
 * and takes about a minute. Sealing is the TEE's job, so the test seals with tlock-js directly.
 */
it('timelock-encrypts to a round one minute ahead and decrypts after it', async () => {
  const client = quicknetClient();
  const info = await client.chain().info();
  expect(info.hash).toBe(drand.chainHash);
  expect(info.public_key).toBe(drand.publicKey);

  const round = roundAtSeconds(Math.floor(Date.now() / 1000) + 60) + 1;
  const dueAt = (drand.genesisTime + (round - 1) * drand.periodSeconds) * 1000;
  const secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const armoured = await timelockEncrypt(round, Buffer.from(secret), client);
  expect(armoured).toContain('BEGIN AGE ENCRYPTED FILE');

  // Before the round is published the beacon can't be fetched, so the ciphertext stays shut.
  await expect(timelockDecrypt(armoured, client)).rejects.toThrow();

  const wait = dueAt - Date.now() + 2000;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  // The relay can lag a moment behind the round time.
  let opened: Uint8Array | undefined;
  for (let attempt = 0; attempt < 10 && !opened; attempt++) {
    opened = await timelockDecrypt(armoured, client).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return undefined;
    });
  }
  expect(opened).toEqual(secret);
}, 150_000);
