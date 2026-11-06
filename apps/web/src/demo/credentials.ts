import { plantedKey, softwareCredentials } from '@paperseal/keys/demo';

import { activePersona } from './personas';
import { touchForShow } from './touch';

/*
 * What `createWebAuthnKeys` calls in demo mode. It answers as the active person's planted key, after
 * the touch for show. All of the key handling stays in the real code, which sees a security key.
 */
export function demoCredentials(): Pick<CredentialsContainer, 'create' | 'get'> {
  async function key() {
    const persona = activePersona();
    if (!persona.keyed) throw new DOMException('The exam board has no security key here. It uses its wallet.', 'NotAllowedError');
    await touchForShow();
    return softwareCredentials(await plantedKey(persona.id), globalThis.location.origin);
  }
  return {
    create: async (options) => (await key()).create(options),
    get: async (options) => (await key()).get(options),
  };
}
