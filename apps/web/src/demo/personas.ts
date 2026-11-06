import { directoryName } from '../shared/names';

/*
 * The people a tab can act as: e2e/live/roster.ts, plus the exam board. Each tab has its own person, held
 * in sessionStorage. Everything the app keeps in this browser sits under `paperseal.`, so `scopeStorage`
 * files those keys under the tab's person. Switching changes the person and reloads, which also clears
 * everything held in memory. The app's own storage code stays as it is, and never knows.
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

const byId = (id: string | null) => personas.find((persona) => persona.id === id);
const scopedKey = (persona: Persona, key: string) =>
  key.startsWith(prefix) && !shared.has(key) ? `paperseal-demo.of.${persona.id}.${key}` : key;

export function activePersona(tab: Storage = globalThis.sessionStorage): Persona {
  return byId(tab.getItem(activeKey)) ?? defaultPersona;
}

/** Keeps a browser's data from when one person was shared by every tab. */
function adoptOldStorage(local: Storage, set: Storage['setItem'], get: Storage['getItem'], remove: Storage['removeItem']): void {
  const keys = Array.from({ length: local.length }, (_, index) => local.key(index)).filter((key) => key !== null);
  const old = byId(get.call(local, activeKey)) ?? defaultPersona;
  for (const key of keys) {
    if (key.startsWith(prefix) && !shared.has(key)) {
      set.call(local, scopedKey(old, key), get.call(local, key) ?? '');
      remove.call(local, key);
    }
  }
  for (const persona of personas) {
    const slot = get.call(local, slotKey(persona.id));
    if (slot === null) continue;
    try {
      const entries = Object.entries(JSON.parse(slot) as Record<string, string>);
      for (const [key, value] of entries) set.call(local, scopedKey(persona, key), value);
    } catch {
      // A slot that can't be read holds nothing worth keeping.
    }
    remove.call(local, slotKey(persona.id));
  }
  remove.call(local, activeKey);
}

/** Runs once, before the app first touches storage. From here each tab's `paperseal.` keys are its person's. */
export function scopeStorage(): void {
  const local = globalThis.localStorage;
  const { getItem, setItem, removeItem } = Storage.prototype;
  adoptOldStorage(local, setItem, getItem, removeItem);
  const key = (store: Storage, name: string) => (store === local ? scopedKey(activePersona(), name) : name);
  Storage.prototype.getItem = function (name) {
    return getItem.call(this, key(this, name));
  };
  Storage.prototype.setItem = function (name, value) {
    setItem.call(this, key(this, name), value);
  };
  Storage.prototype.removeItem = function (name) {
    removeItem.call(this, key(this, name));
  };
  seedPerson(activePersona(), local);
}

/** A person starts with their name filled in, as if they had used it here before. */
function seedPerson(persona: Persona, local: Storage): void {
  if (persona.owner && local.getItem('paperseal.party-name') === null) local.setItem('paperseal.party-name', persona.owner);
}

/** Makes this tab `next`. Other tabs keep their own person. */
export function changePersona(next: Persona, tab: Storage = globalThis.sessionStorage): void {
  tab.setItem(activeKey, next.id);
  seedPerson(next, globalThis.localStorage);
}

/** Becomes `next`, on their page. The reload drops whatever the last person had in memory. */
export function becomePersona(next: Persona): void {
  changePersona(next);
  globalThis.location.hash = `#${next.path}`;
  globalThis.location.reload();
}
