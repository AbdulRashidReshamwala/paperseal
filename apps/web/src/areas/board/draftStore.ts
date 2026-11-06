import type { PublishInput } from './form';
import { validParties } from './parties';
import { demoTimes } from '../../shared/demoKeys';
import { defaultPlan, draftSteps, evaluatePlan, type DraftStep, type PlanInput } from './plan';

/*
 * The board's unfinished exams, kept in this browser so a reload or a closed tab loses nothing. Each
 * draft holds only what was typed on the form: no keys, no invites and nothing secret. A draft is
 * removed once its exam is published. Anything that does not look like a draft is ignored, never
 * half-used. The single draft an older version kept under `paperseal.board.draft` moves into the list.
 */

const KEY = 'paperseal.board.drafts';
const OLD_KEY = 'paperseal.board.draft';

export interface DraftContent {
  plan: PlanInput;
  publish: PublishInput;
  draftStep: DraftStep;
}

export interface StoredDraft extends DraftContent {
  id: string;
  /** Milliseconds since 1970, when the form last changed. */
  updatedAt: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

const isText = (value: unknown): value is string => typeof value === 'string';
const validId = (value: unknown): value is string => isText(value) && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** The form a draft holds, or null when what was stored does not look like one. */
function parseContent(value: unknown): DraftContent | null {
  if (!value || typeof value !== 'object') return null;
  const { plan, publish, draftStep } = value as { plan?: Record<string, unknown>; publish?: Record<string, unknown>; draftStep?: unknown };
  if (!plan || !publish) return null;
  const topics = plan.topics;
  if (
    !['name', 'examStart', 'durationMinutes', 'releaseMinutes', 'maxSetterPercent', 'minBankMultiple', 'lockTime'].every((field) => isText(plan[field])) ||
    !Array.isArray(topics) ||
    topics.length === 0 ||
    !topics.every((topic: unknown) => {
      const entry = topic as Record<string, unknown> | null;
      return Boolean(entry) && isText(entry?.name) && isText(entry?.questions);
    }) ||
    !isText(publish.version) ||
    !isText(publish.rpcHost)
  ) {
    return null;
  }
  return {
    plan: { ...(plan as unknown as PlanInput), typedName: isText(plan.typedName) ? plan.typedName : '', parties: validParties(plan.parties) },
    publish: { version: publish.version, rpcHost: publish.rpcHost },
    draftStep: draftSteps.includes(draftStep as DraftStep) ? (draftStep as DraftStep) : 'create',
  };
}

export function newDraftId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function write(drafts: readonly StoredDraft[]): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(KEY, JSON.stringify(drafts));
    return true;
  } catch {
    // Not stored: the form still works for this visit.
    return false;
  }
}

function readStored(): StoredDraft[] {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const drafts: StoredDraft[] = [];
    for (const entry of list as unknown[]) {
      const content = parseContent(entry);
      const { id, updatedAt } = (entry ?? {}) as { id?: unknown; updatedAt?: unknown };
      if (!content || !validId(id) || seen.has(id)) continue;
      seen.add(id);
      drafts.push({ ...content, id, updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0 });
    }
    return drafts;
  } catch {
    return [];
  }
}

/** True while nothing has been typed, so an empty form never becomes a draft. */
export function isBlank(content: Pick<DraftContent, 'plan' | 'publish'>): boolean {
  // Demo mode fills the times in by itself, which alone doesn't make a draft worth keeping.
  const plan = demoTimes() ? { ...content.plan, examStart: '', lockTime: '', durationMinutes: defaultPlan.durationMinutes, releaseMinutes: defaultPlan.releaseMinutes } : content.plan;
  return JSON.stringify(plan) === JSON.stringify(defaultPlan) && content.publish.version === '';
}

/** The one draft an older version kept, moved into the list. A draft that cannot be used is dropped. */
function migrate(now: number): void {
  const store = storage();
  let raw: string | null | undefined;
  try {
    raw = store?.getItem(OLD_KEY);
  } catch {
    return;
  }
  if (!store || raw === null || raw === undefined) return;
  let content: DraftContent | null;
  try {
    content = parseContent(JSON.parse(raw));
  } catch {
    content = null;
  }
  if (content && !isBlank(content)) {
    // The old copy stays until the new one is in place.
    if (!write([...readStored(), { ...content, id: newDraftId(), updatedAt: now }])) return;
  }
  try {
    store.removeItem(OLD_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Every saved draft, newest first. */
export function listDrafts(now = Date.now()): StoredDraft[] {
  migrate(now);
  return readStored().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadDraft(id: string): StoredDraft | null {
  return listDrafts().find((draft) => draft.id === id) ?? null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Saves the form as this draft. A form that has not changed keeps its last edited time. */
export function saveDraft(id: string, content: DraftContent, now = Date.now()): void {
  if (!validId(id) || isBlank(content)) return;
  const all = listDrafts(now);
  const before = all.find((draft) => draft.id === id);
  if (before && same(before.plan, content.plan) && same(before.publish, content.publish) && before.draftStep === content.draftStep) return;
  write([...all.filter((draft) => draft.id !== id), { ...content, id, updatedAt: now }]);
}

export function removeDraft(id: string): void {
  write(readStored().filter((draft) => draft.id !== id));
}

export const draftTitle = (draft: Pick<StoredDraft, 'plan'>): string => draft.plan.name.trim() || 'Untitled exam';

/** How far a draft got, in words the board would use. */
export function draftProgress(draft: DraftContent): string {
  if (draft.draftStep === 'review') return 'At the review';
  const { blueprint, schedule } = evaluatePlan(draft.plan);
  return blueprint.criteria && blueprint.examId && schedule.settings ? 'Ready to review' : 'Still being filled in';
}

const clock = (date: Date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** When a draft was last edited, in plain words. */
export function editedWords(updatedAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - updatedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const then = new Date(updatedAt);
  const today = new Date(now);
  if (then.toDateString() === today.toDateString()) return `today at ${clock(then)}`;
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return `yesterday at ${clock(then)}`;
  return `on ${then.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`;
}
