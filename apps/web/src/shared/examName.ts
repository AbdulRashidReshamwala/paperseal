import { resolveExamName, type EnsLookup } from '@paperseal/chain';
import { examIdFromName, looksLikeEnsName, splitExamEnsName, type Hex } from '@paperseal/protocol';

/*
 * An exam's ENS name outside the board. A name in a link or an invite is only a hint, kept per exam in
 * this browser. It counts once `resolveExamName` passes in full and it names this app's registry, and
 * until then the page shows the short exam ID.
 */

const KEY = 'paperseal.examNames';
const verified = new Map<string, Hex>();
const reading = new Map<Hex, Promise<string | null>>();

function hints(): Record<string, string> {
  try {
    return JSON.parse(globalThis.localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

const labelOf = (name: string): string | null => splitExamEnsName(name)?.label ?? null;

/** Keeps `name` for its exam, unless it hashes to another exam. */
export function rememberExamNameHint(examId: Hex, name: string): void {
  const label = labelOf(name);
  if (!label || examIdFromName(label).toLowerCase() !== examId.toLowerCase()) return;
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ ...hints(), [examId.toLowerCase()]: name }));
  } catch {
    // Not stored: the page shows the short exam ID.
  }
}

export const shortExamId = (examId: string): string => `${examId.slice(0, 6)}…${examId.slice(-4)}`;

export const verifiedIdOf = (name: string): Hex | null => verified.get(name) ?? null;

export function verifiedNameOf(examId: Hex): string | null {
  for (const [name, id] of verified) if (id === examId.toLowerCase()) return name;
  return null;
}

/** The exam name in `/setter/<name>`, `/keyholder/<name>` or `/centre/<name>`. */
export function examNameInPath(pathname: string): string | null {
  const segment = pathname.split('/')[2];
  return segment && looksLikeEnsName(segment) ? segment : null;
}

export type NameCheck = { ok: true; examId: Hex } | { ok: false; retry: boolean };

/** Every check in `resolveExamName`, and the name must be on this app's registry. */
export async function checkExamName(lookup: EnsLookup | null, registry: string | null, name: string): Promise<NameCheck> {
  if (!lookup || !registry) return { ok: false, retry: false };
  const resolved = await resolveExamName(name, { lookup });
  if (!resolved.ok) return { ok: false, retry: resolved.failed === 'unreadable' };
  if (resolved.value.registry.toLowerCase() !== registry.toLowerCase()) return { ok: false, retry: false };
  const examId = resolved.value.examId.toLowerCase() as Hex;
  verified.set(name, examId);
  rememberExamNameHint(examId, name);
  return { ok: true, examId };
}

/** The exam's name if the hint kept for it passes. One read at a time per exam. */
export function verifyExamHint(lookup: EnsLookup | null, registry: string | null, examId: Hex): Promise<string | null> {
  const id = examId.toLowerCase() as Hex;
  const hint = hints()[id];
  if (!hint) return Promise.resolve(null);
  const running = reading.get(id);
  if (running) return running;
  const read = checkExamName(lookup, registry, hint)
    .then((check) => (check.ok && check.examId === id ? hint : null))
    .finally(() => reading.delete(id));
  reading.set(id, read);
  return read;
}
