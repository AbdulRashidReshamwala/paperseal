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
 * Names for key holders and centres, from "Party Names" in spec/api.md. A party's `owner` may be an
 * ENS name. Setters never have one. The name is a label, and for a neutral key holder it can also be
 * a proof: the name's `ens.records.passkey` text record holds `passkeyRecordValue` of the passkey
 * public key that registered under it. Nothing here is read by the TEE or `ExamRegistry`.
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
