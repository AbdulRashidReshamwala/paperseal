import spec from '../../../spec/constants.json';

/** spec/constants.json, imported rather than copied. */
export const constants = spec;

export const { threshold, drand, chain, crypto, padding, attestation, webauthn, domainTags } = spec;

export type DomainTagName = keyof typeof spec.domainTags;

/**
 * `webauthn.requireHardwareAttestation`. False for the demo, so the TEE doesn't check the
 * attestation chain, and the verifier page shows the value. When true, an attestation check
 * that isn't implemented must reject the registration.
 */
export const requireHardwareAttestation: boolean = spec.webauthn.requireHardwareAttestation;
