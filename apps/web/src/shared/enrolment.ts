import { passkeyRecordValue, type Hex, type KeyCard } from '@paperseal/protocol';

/*
 * What this browser remembers of keys it enrolled, and of the name it last registered under. All of it
 * is public. The chain holds what matters, so losing this only means typing a name once, and resending
 * no attestation object. See "Party Names" in spec/api.md.
 */

export interface Enrolment {
  credentialId: Hex;
  passkeyPublicKey: Hex;
  attestationObject: Hex;
}

const enrolmentsKey = 'paperseal.enrolments';
const nameKey = 'paperseal.party-name';

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

const hex = (value: unknown): value is Hex => typeof value === 'string' && /^0x([0-9a-f]{2})*$/.test(value);

/** This browser's enrolments, oldest first. Anything that doesn't read is dropped. */
export function loadEnrolments(): Enrolment[] {
  try {
    const parsed = JSON.parse(storage()?.getItem(enrolmentsKey) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Partial<Enrolment>[]).filter(
      (item): item is Enrolment => hex(item.credentialId) && hex(item.passkeyPublicKey) && hex(item.attestationObject),
    );
  } catch {
    return [];
  }
}

export function saveEnrolment(enrolment: Enrolment): void {
  storage()?.setItem(enrolmentsKey, JSON.stringify([...loadEnrolments(), enrolment]));
}

export function keyCardOf(enrolment: Enrolment): KeyCard {
  return {
    passkey: passkeyRecordValue(enrolment.passkeyPublicKey),
    credentialId: enrolment.credentialId,
    attestationObject: enrolment.attestationObject,
  };
}

export function loadPartyName(): string {
  return storage()?.getItem(nameKey) ?? '';
}

export function savePartyName(name: string): void {
  storage()?.setItem(nameKey, name);
}
