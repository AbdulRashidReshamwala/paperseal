import spec from '../../../spec/constants.json';

/** spec/constants.json, imported rather than copied. */
export const constants = spec;

export const { threshold, drand, chain, crypto, padding, attestation, webauthn, domainTags } = spec;

export type DomainTagName = keyof typeof spec.domainTags;
