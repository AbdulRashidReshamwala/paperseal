import { directoryName } from '../shared/names';

/*
 * The people one tab can act as: e2e/live/roster.ts, plus the exam board. Everything the app keeps in
 * this browser sits under `paperseal.`, so a person is that set of keys. Switching puts one person's set
 * away and brings the next one's back, then reloads, which also clears everything held in memory. The
 * app's own storage code stays as it is, and never knows.
 */

export interface Persona {
  id: string;
  label: string;
  /** The page this person starts on. */
  path: string;
  /** Holds a planted key. The exam board uses its wallet instead. */
  keyed: boolean;
  /** The ENS name a key holder or centre is invited under. */
  owner?: string;
}

const count = (n: number) => Array.from({ length: n }, (_, index) => index + 1);
const party = (id: string, label: string, path: string): Persona => ({ id, label, path, keyed: true, owner: `${id}.${directoryName}` });

export const personas: readonly Persona[] = [
  { id: 'board', label: 'Exam board', path: '/board', keyed: false },
  ...count(2).map((n) => ({ id: `setter-${String(n)}`, label: `Setter ${String(n)}`, path: '/setter', keyed: true })),
  ...count(3).map((n) => party(`neutral-${String(n)}`, `Key holder ${String(n)}`, '/keyholder')),
  ...count(8).map((n) => party(`centre-${String(n)}`, `Centre ${String(n)}`, '/centre')),
];

const defaultPersona = personas[0] as Persona;

/** Not under `paperseal.`, so these never move with a person. */
export const activeKey = 'paperseal-demo.persona';
const slotKey = (id: string) => `paperseal-demo.person.${id}`;

const prefix = 'paperseal.';
/** Which exam this tab shows. It is only a pointer to public data, and every person follows the same exam. */
const shared = new Set(['paperseal.examId']);

export function activePersona(storage: Storage = globalThis.localStorage): Persona {
  const id = storage.getItem(activeKey);
  return personas.find((persona) => persona.id === id) ?? defaultPersona;
}

/** A person starts with their name filled in, as if they had used it here before. */
const firstVisit = (persona: Persona): Record<string, string> => (persona.owner ? { 'paperseal.party-name': persona.owner } : {});

function readSlot(storage: Storage, persona: Persona): Record<string, string> {
  try {
    return (JSON.parse(storage.getItem(slotKey(persona.id)) ?? 'null') as Record<string, string> | null) ?? firstVisit(persona);
  } catch {
    return firstVisit(persona);
  }
}

/** Puts the active person's storage away and brings out `next`'s. */
export function changePersona(next: Persona, storage: Storage = globalThis.localStorage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
    (key): key is string => key?.startsWith(prefix) === true && !shared.has(key),
  );
  const leaving: Record<string, string> = {};
  for (const key of keys) {
    leaving[key] = storage.getItem(key) ?? '';
    storage.removeItem(key);
  }
  storage.setItem(slotKey(activePersona(storage).id), JSON.stringify(leaving));
  for (const [key, value] of Object.entries(readSlot(storage, next))) storage.setItem(key, value);
  storage.setItem(activeKey, next.id);
}

/** Becomes `next`, on their page. The reload drops whatever the last person had in memory. */
export function becomePersona(next: Persona): void {
  changePersona(next);
  globalThis.location.hash = `#${next.path}`;
  globalThis.location.reload();
}
