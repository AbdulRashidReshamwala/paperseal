import { normalize } from 'viem/ens';

import ensSpec from '../../../spec/ens.json';

import { fromHex, utf8ToBytes } from './bytes';
import { limits } from './constants';
import { ApprovedListError, roles, setterOwner, type ApprovedListEntry } from './encoding';
import type { Hex } from './types';

/*
 * Exam names, from "Exam Names" in spec/api.md. An exam's name is one ENS label that is already
 * normalised under ENSIP-15, so `examIdFromName(name)` is also its ENS `labelhash`. A name that
 * normalises to something else is refused rather than fixed, because it would hash to a different
 * `examId` than the one ENS finds.
 */

/** spec/ens.json, imported rather than copied: the text record keys and the `ccipRead` setting. */
export const ens = ensSpec;

const example = 'jee-main-2026';

/** Null for a valid exam name, else a short sentence saying what is wrong with it. */
export function examNameProblem(name: string): string | null {
  if (name.length === 0) return 'The exam name is empty.';
  if (name.includes('.')) return `The exam name can't contain a dot. Use hyphens instead, like ${example}.`;
  let normalised: string;
  try {
    normalised = normalize(name);
  } catch {
    return `Use lowercase letters, digits and hyphens, like ${example}.`;
  }
  return normalised === name ? null : `Use lowercase letters, digits and hyphens. Did you mean ${normalised}?`;
}

/** `<label>.<parent>` split at the first dot. Null if there is no dot or either part is empty. */
export function splitExamEnsName(name: string): { label: string; parent: string } | null {
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return { label: name.slice(0, dot), parent: name.slice(dot + 1) };
}

/*
 * Names for key holders and centres, from "Party Names" in spec/api.md. A party's `owner` is a
 * permanent ENS name. Setters never have one. The name's `ens.records.passkey` text record holds
 * `passkeyRecordValue` of its security key, and `ens.records.credential` that key's credential ID, so
 * a browser that never saw the key can find it. Nothing here is read by the TEE or `ExamRegistry`.
 */

/** Whether `text` is written like an ENS name: no spaces, and at least two parts around dots. */
export function looksLikeEnsName(text: string): boolean {
  return /^[^\s.]+(\.[^\s.]+)+$/.test(text);
}

/** Null when `text` is a normalised ENS name that fits an `owner`, else a sentence saying what is wrong. */
export function ensNameProblem(text: string): string | null {
  if (utf8ToBytes(text).length > limits.ownerBytes) return `The name is longer than ${String(limits.ownerBytes)} bytes.`;
  let normalised: string;
  try {
    normalised = normalize(text);
  } catch {
    return 'This is not a valid ENS name. Use lowercase letters, digits and hyphens, like maths-board.example.eth.';
  }
  return normalised === text ? null : `Use the normalised form of this name. Did you mean ${normalised}?`;
}

/** The one plain line shown for any `owner` of a key holder or centre that is not an ENS name. */
export const ensNameExample = 'iit-delhi.eth';
export const notAnEnsNameSentence = `Use an ENS name, like ${ensNameExample}.`;

/**
 * Null when `text` is a normalised ENS name fit to be a key holder's or centre's `owner`. Else a
 * sentence: the plain line for anything not written like an ENS name, or "Did you mean ..." for one
 * that is not normalised. There are no plain names for these roles (spec/api.md, "Party Names").
 */
export function partyNameProblem(text: string): string | null {
  if (!looksLikeEnsName(text)) return notAnEnsNameSentence;
  return ensNameProblem(text);
}

/** Refuses a list where a key holder or centre `owner` is not an ENS name. Setters are skipped: their `owner` is a hash. */
export function checkPartyNames(entries: readonly ApprovedListEntry[]): void {
  entries.forEach((entry, index) => {
    if (entry.role === roles.setter) return;
    if (ownerEnsName(entry.owner) === null) {
      throw new ApprovedListError(`entry ${String(index)} owner ${JSON.stringify(entry.owner)} is not an ENS name`);
    }
  });
}

/**
 * The ENS name an `owner` is, or null for a plain name. An owner is an ENS name only when it is
 * written like one and is already normalised, so every reader reaches the same answer.
 */
export function ownerEnsName(owner: string): string | null {
  return looksLikeEnsName(owner) && ensNameProblem(owner) === null ? owner : null;
}

/**
 * The value of a key holder's `ens.records.passkey` record: the `setterOwner` hash of its passkey
 * public key, lowercase 0x hex. It reuses that message, so spec/constants.json gains no domain tag.
 * The key is public, so the value leaks nothing, and a setter's own list entry carries the same value.
 */
export function passkeyRecordValue(passkeyPublicKey: Uint8Array | Hex): Hex {
  return setterOwner(typeof passkeyPublicKey === 'string' ? fromHex(passkeyPublicKey) : passkeyPublicKey);
}

/** Whether a `ens.records.passkey` record names this value: any hex case, with spaces around it ignored. */
export function passkeyRecordMatches(record: string, value: Hex): boolean {
  return record.trim().toLowerCase() === value;
}

/** The credential ID in a `ens.records.credential` record, as lowercase hex. Null when it isn't hex. */
export function credentialRecordValue(record: string): Hex | null {
  const value = record.trim().toLowerCase();
  return /^0x([0-9a-f]{2})+$/.test(value) ? (value as Hex) : null;
}

/**
 * The names in a `ens.records.directory` record, without repeats. Refuses more than `ens.directoryBytes`
 * bytes, anything but a JSON array of strings, and a name that isn't a normalised ENS name. The list is
 * only a menu: each name is verified by its own records.
 */
export function parseDirectory(text: string): { ok: true; names: string[] } | { ok: false; reason: string } {
  if (utf8ToBytes(text).length > ens.directoryBytes) return { ok: false, reason: `The directory is longer than ${String(ens.directoryBytes)} bytes.` };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'The directory is not valid JSON.' };
  }
  if (!Array.isArray(value)) return { ok: false, reason: 'The directory is not a list of names.' };
  const names = new Set<string>();
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') return { ok: false, reason: 'The directory holds something that is not a name.' };
    const problem = partyNameProblem(item);
    if (problem) return { ok: false, reason: `${item}: ${problem}` };
    names.add(item);
  }
  return { ok: true, names: [...names] };
}

/* ------------------------------------------------------------------ Key cards */

const KEY_CARD_KIND = 'paperseal-key-card';

/** What a person sends the directory owner after enrolling. All of it is public. */
export interface KeyCard {
  /** `passkeyRecordValue` of the new passkey. */
  passkey: Hex;
  credentialId: Hex;
  attestationObject: Hex;
}

export function keyCardText(card: KeyCard): string {
  return JSON.stringify({ kind: KEY_CARD_KIND, version: 1, ...card }, null, 2);
}

/** Reads a key card. Lowercase hex only, and `passkey` is 32 bytes. Throws `Error` in plain words. */
export function parseKeyCard(text: string): KeyCard {
  let value: Partial<KeyCard> & { kind?: unknown; version?: unknown };
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    throw new Error('This is not a key card: it is not valid JSON.');
  }
  if (value.kind !== KEY_CARD_KIND || value.version !== 1) throw new Error('This is not a Paper Seal key card.');
  const { passkey, credentialId, attestationObject } = value;
  if (typeof passkey !== 'string' || !/^0x[0-9a-f]{64}$/.test(passkey)) throw new Error('The card has no valid passkey hash.');
  if (typeof credentialId !== 'string' || !/^0x([0-9a-f]{2})+$/.test(credentialId)) throw new Error('The card has no valid credential ID.');
  if (typeof attestationObject !== 'string' || !/^0x([0-9a-f]{2})*$/.test(attestationObject)) throw new Error('The card has no valid attestation object.');
  return { passkey, credentialId, attestationObject };
}
