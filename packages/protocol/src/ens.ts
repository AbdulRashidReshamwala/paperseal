import { normalize } from 'viem/ens';

import ensSpec from '../../../spec/ens.json';

/*
 * Exam names, from "Exam Names" in spec/api.md. An exam's name is one ENS label that is already
 * normalised under ENSIP-15, so `examIdFromName(name)` is also its ENS `labelhash`. A name that
 * normalises to something else is refused rather than fixed, because it would hash to a different
 * `examId` than the one ENS finds.
 */

/** spec/ens.json, imported rather than copied: the text record keys and the `ccipRead` setting. */
export const ens = ensSpec;

const example = 'jee-main-2026';

/** ENSIP-15 errors quote characters between bidi marks; drop those so the message reads plainly. */
const plainReason = (message: string): string => message.replace(/[‎‏]/g, '').trim();

/** Null for a valid exam name, else a short sentence saying what is wrong with it. */
export function examNameProblem(name: string): string | null {
  if (name.length === 0) return 'The exam name is empty.';
  if (name.includes('.')) return `The exam name can't contain a dot. Use hyphens instead, like ${example}.`;
  let normalised: string;
  try {
    normalised = normalize(name);
  } catch (error) {
    const reason = error instanceof Error ? plainReason(error.message) : '';
    const hint = `Use lowercase letters, digits and hyphens, like ${example}.`;
    return reason.length > 0 && reason.length <= 80 ? `${hint} (${reason})` : hint;
  }
  if (normalised !== name) {
    return `The exam name must already be in normalised form. Did you mean ${normalised}?`;
  }
  return null;
}

/** `<label>.<parent>` split at the first dot. Null if there is no dot or either part is empty. */
export function splitExamEnsName(name: string): { label: string; parent: string } | null {
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return { label: name.slice(0, dot), parent: name.slice(dot + 1) };
}
