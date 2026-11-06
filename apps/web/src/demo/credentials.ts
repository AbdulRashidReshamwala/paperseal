import { createWebAuthnKeys, type Keys } from '@paperseal/keys';
import { plantedKey, softwareCredentials } from '@paperseal/keys/demo';

import { activePersona, type Persona } from './personas';
import { touchForShow } from './touch';

/*
 * What `createWebAuthnKeys` calls in demo mode. It answers as the named person's planted key, with no
 * touch because the board's buttons act for them, or else as the active person's, after the touch for show. All of the key handling stays in the real code, which
 * sees a security key.
 */
export function demoCredentials(named?: Persona): Pick<CredentialsContainer, 'create' | 'get'> {
  async function key() {
    const persona = named ?? activePersona();
    if (!persona.keyed) throw new DOMException('The exam board has no security key here. It uses its wallet.', 'NotAllowedError');
    if (!named) await touchForShow();
    return softwareCredentials(await plantedKey(persona.id), globalThis.location.origin);
  }
  return {
    create: async (options) => (await key()).create(options),
    get: async (options) => (await key()).get(options),
  };
}

/** The real key code, answering as `persona`, whoever this tab is acting as. */
export function keysFor(persona: Persona): Keys {
  return createWebAuthnKeys({ rpId: globalThis.location.hostname, rpName: 'Paper Seal', credentials: demoCredentials(persona) });
}
