import spec from '../../../spec/constants.json';
import registryCode from '../../../spec/registry.json';

/** spec/constants.json, imported rather than copied. */
export const constants = spec;

export const { threshold, drand, chain, crypto, padding, attestation, webauthn, domainTags, limits, schedule } = spec;

/** spec/registry.json, the code pin `make abi` writes. See "Registry Code" in spec/api.md. */
export { registryCode };

export type DomainTagName = keyof typeof spec.domainTags;

/**
 * `webauthn.requireSecurityKeyAttestation`, about the security keys' maker and not the TEE's
 * attestation token. False for the demo, so the TEE doesn't check a key's attestation chain, and the verifier page shows the value. When true, an attestation check
 * that isn't implemented must reject the registration.
 */
export const requireSecurityKeyAttestation: boolean = spec.webauthn.requireSecurityKeyAttestation;
