import type { PublishInput } from './form';
import type { DraftStep, PlanInput } from './plan';

/*
 * The board's unfinished exam, kept in this browser so a reload or a closed tab loses nothing. It
 * holds only what was typed on the form: no keys, no invites and nothing secret. It is removed once
 * the exam is published. Anything that does not look like a draft is ignored, never half-used.
 */

const KEY = 'paperseal.board.draft';

export interface Draft {
  plan: PlanInput;
  publish: PublishInput;
  draftStep: DraftStep;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

const isText = (value: unknown): value is string => typeof value === 'string';

export function loadDraft(): Draft | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { plan?: Record<string, unknown>; publish?: Record<string, unknown>; draftStep?: unknown };
    const { plan, publish } = value;
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
      plan: plan as unknown as PlanInput,
      publish: { version: publish.version, rpcHost: publish.rpcHost },
      draftStep: value.draftStep === 'review' ? 'review' : 'create',
    };
  } catch {
    return null;
  }
}

export function saveDraft(draft: Draft): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Not stored: the form still works for this visit.
  }
}

export function clearDraft(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
