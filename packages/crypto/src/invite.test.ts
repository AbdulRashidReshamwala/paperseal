import { toHex } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { inviteTag } from './index';

describe('inviteTag', () => {
  it('is HMAC-SHA-256(inviteSecret, passkeyPublicKey), as WebCrypto computes it', async () => {
    const secret = new Uint8Array(32).fill(0x5a);
    const passkey = new Uint8Array(65).fill(0x11);
    passkey[0] = 0x04;
    const key = await globalThis.crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, passkey));
    expect(toHex(inviteTag(secret, passkey))).toBe(toHex(mac));
  });
});
