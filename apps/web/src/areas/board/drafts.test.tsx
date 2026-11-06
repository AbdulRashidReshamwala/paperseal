// @vitest-environment jsdom
import { examIdFromName } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentExamId } from '../../shared/currentExam';
import BoardArea from './BoardArea';
import { draftProgress, draftTitle, editedWords, isBlank, listDrafts, loadDraft, removeDraft, saveDraft, type DraftContent } from './draftStore';
import { listKnownExams, rememberExam } from './examsStore';
import { defaultPlan } from './plan';
import type { PublishEnvironment } from './publishFlow';

const DRAFTS = 'paperseal.board.drafts';
const OLD = 'paperseal.board.draft';
const content = (name: string, extra: Partial<DraftContent> = {}): DraftContent => ({
  plan: { ...defaultPlan, name },
  publish: { version: '', rpcHost: 'rpc.example.org' },
  draftStep: 'create',
  ...extra,
});
const stored = () => JSON.parse(localStorage.getItem(DRAFTS) ?? '[]') as { id: string; plan: { name: string }; updatedAt: number }[];

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the list of drafts', () => {
  it('moves the one draft an older version kept into the list, and keeps nothing twice', () => {
    localStorage.setItem(OLD, JSON.stringify(content('jee-main-2026', { draftStep: 'review' })));
    const drafts = listDrafts(5_000);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ plan: { name: 'jee-main-2026' }, draftStep: 'review', updatedAt: 5_000 });
    expect(localStorage.getItem(OLD)).toBeNull();
    expect(listDrafts()).toHaveLength(1);
  });

  it('keeps the old draft when the list cannot be written, and drops one that cannot be used', () => {
    localStorage.setItem(OLD, JSON.stringify(content('kept')));
    const real = localStorage;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => real.getItem(key),
      setItem: () => {
        throw new Error('full');
      },
      removeItem: (key: string) => {
        real.removeItem(key);
      },
    });
    expect(listDrafts()).toEqual([]);
    expect(real.getItem(OLD)).not.toBeNull();
    vi.unstubAllGlobals();
    localStorage.setItem(OLD, '{"plan":3}');
    expect(listDrafts()).toEqual([]);
    expect(localStorage.getItem(OLD)).toBeNull();
  });

  it('saves each draft under its own id, newest first, and leaves an unchanged one alone', () => {
    saveDraft('a', content('first'), 1_000);
    saveDraft('b', content('second'), 2_000);
    saveDraft('a', content('first'), 3_000);
    expect(listDrafts().map((draft) => [draft.id, draft.updatedAt])).toEqual([
      ['b', 2_000],
      ['a', 1_000],
    ]);
    saveDraft('a', content('first, edited'), 4_000);
    expect(listDrafts().map((draft) => draft.id)).toEqual(['a', 'b']);
    expect(loadDraft('a')?.plan.name).toBe('first, edited');
    expect(loadDraft('missing')).toBeNull();
  });

  it('never keeps an empty draft', () => {
    saveDraft('a', content(''));
    expect(isBlank(content(''))).toBe(true);
    expect(listDrafts()).toEqual([]);
    saveDraft('a', content('x'));
    removeDraft('a');
    expect(listDrafts()).toEqual([]);
  });

  it('ignores damaged storage and keeps the drafts that are fine', () => {
    for (const bad of ['not json', '{}', '[1,"x",null]', '[{"id":"a","plan":{"name":3}}]']) {
      localStorage.setItem(DRAFTS, bad);
      expect(listDrafts()).toEqual([]);
    }
    localStorage.setItem(DRAFTS, JSON.stringify([{ ...content('good'), id: 'ok', updatedAt: 1 }, { ...content('bad id'), id: '../x' }, { id: 'b', plan: {} }]));
    expect(listDrafts().map((draft) => draft.id)).toEqual(['ok']);
    saveDraft('new', content('after damage'));
    expect(stored().map((draft) => draft.id).sort()).toEqual(['new', 'ok']);
  });

  it('works with storage that is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(listDrafts()).toEqual([]);
    expect(() => {
      saveDraft('a', content('x'));
      removeDraft('a');
    }).not.toThrow();
  });

  it('names a draft and says how far it got in plain words', () => {
    expect(draftTitle(content(''))).toBe('Untitled exam');
    expect(draftTitle(content('  maths  '))).toBe('maths');
    expect(draftProgress(content('x'))).toBe('Still being filled in');
    expect(draftProgress(content('x', { draftStep: 'review' }))).toBe('At the review');
    const now = new Date(2027, 5, 10, 15, 30).getTime();
    expect(editedWords(now - 20_000, now)).toBe('just now');
    expect(editedWords(now - 60_000, now)).toBe('1 minute ago');
    expect(editedWords(now - 12 * 60_000, now)).toBe('12 minutes ago');
    expect(editedWords(new Date(2027, 5, 10, 9, 5).getTime(), now)).toBe('today at 09:05');
    expect(editedWords(new Date(2027, 5, 9, 22, 0).getTime(), now)).toBe('yesterday at 22:00');
    expect(editedWords(new Date(2027, 5, 1, 8, 0).getTime(), now)).toMatch(/^on /);
  });
});

describe('the exams this browser knows', () => {
  const a = examIdFromName('maths-2027');
  const b = examIdFromName('physics-2027');

  it('keeps a published exam with its name, newest first, once', () => {
    rememberExam({ id: a, name: 'maths-2027' });
    rememberExam({ id: b, name: 'physics-2027' });
    rememberExam({ id: a, name: 'maths-2027' });
    expect(listKnownExams()).toEqual([
      { id: a, name: 'maths-2027' },
      { id: b, name: 'physics-2027' },
    ]);
  });

  it('still finds an exam from before names were kept, from the pointer and from its invites', () => {
    setCurrentExamId(a);
    localStorage.setItem(`paperseal.invites.${b}`, '[]');
    expect(listKnownExams()).toEqual([
      { id: a, name: null },
      { id: b, name: null },
    ]);
    localStorage.setItem('paperseal.board.exams', 'damaged');
    expect(listKnownExams()).toHaveLength(2);
  });
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
const environment = { createRegistry: null } as unknown as PublishEnvironment;
function renderBoard(path = '/board') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/board/*" element={<BoardArea environment={environment} tee={null} />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId('where').textContent;
const nameField = () => screen.getByLabelText<HTMLInputElement>(/^Exam name/);
const type = (value: string) => {
  fireEvent.change(nameField(), { target: { value } });
};

describe('/board and its drafts', () => {
  it('opens the create page with an empty form and no lists when nothing is saved', () => {
    renderBoard();
    expect(screen.getByText('Create the exam')).toBeTruthy();
    expect(nameField().value).toBe('');
    expect(screen.queryByText('Your drafts')).toBeNull();
    expect(screen.queryByText('Your exams')).toBeNull();
    expect(listDrafts()).toEqual([]);
  });

  it('saves no draft until something is typed, then autosaves it into the list under a route id', () => {
    renderBoard();
    expect(listDrafts()).toEqual([]);
    const input = nameField();
    type('maths-2027');
    expect(stored()).toHaveLength(1);
    expect(stored()[0]?.plan.name).toBe('maths-2027');
    expect(where()).toBe(`/board/draft/${stored()[0]?.id ?? ''}`);
    type('maths-2028');
    expect(stored()).toHaveLength(1);
    expect(stored()[0]?.plan.name).toBe('maths-2028');
    // The page is the same one, so typing is never interrupted.
    expect(nameField()).toBe(input);
  });

  it('removes the draft again when everything typed is cleared', () => {
    renderBoard();
    type('x');
    expect(stored()).toHaveLength(1);
    type('');
    expect(stored()).toEqual([]);
    type('y');
    expect(stored()).toHaveLength(1);
  });

  it('never restores a draft into the form unless the route names it', () => {
    saveDraft('abc', content('maths-2027'));
    renderBoard();
    expect(nameField().value).toBe('');
    expect(screen.getByText('Your drafts')).toBeTruthy();
    expect(screen.getByText('maths-2027')).toBeTruthy();
    expect(screen.getByText('Drafts are saved only in this browser.')).toBeTruthy();
  });

  it('continues a draft, with its form, and a reload stays on it', () => {
    saveDraft('abc', content('maths-2027'));
    saveDraft('def', content('physics-2027'));
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Continue maths-2027' }));
    expect(where()).toBe('/board/draft/abc');
    expect(nameField().value).toBe('maths-2027');
    expect(screen.getByText('physics-2027')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue maths-2027' })).toBeNull();
    cleanup();
    renderBoard('/board/draft/abc');
    expect(nameField().value).toBe('maths-2027');
  });

  it('continues a draft at the step it reached', () => {
    saveDraft('abc', { ...content('maths-2027'), draftStep: 'review' });
    renderBoard('/board/draft/abc');
    // The form is not complete enough to review, so it falls back to the form with its words kept.
    expect(nameField().value).toBe('maths-2027');
  });

  it('opening a draft does not change when it was last edited', () => {
    saveDraft('abc', content('maths-2027'), 1_000);
    renderBoard('/board/draft/abc');
    expect(stored()[0]?.updatedAt).toBe(1_000);
  });

  it('goes to the create page when the route names a draft that is not here', () => {
    renderBoard('/board/draft/gone');
    expect(where()).toBe('/board');
    expect(screen.getByText('Create the exam')).toBeTruthy();
    expect(listDrafts()).toEqual([]);
  });

  it('deletes a draft after one confirm, and Keep it changes nothing', () => {
    saveDraft('abc', content('maths-2027'));
    saveDraft('def', content('physics-2027'));
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Delete maths-2027' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(listDrafts()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Delete maths-2027' }));
    expect(listDrafts()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete maths-2027' }));
    expect(listDrafts().map((draft) => draft.id)).toEqual(['def']);
    expect(screen.queryByText('maths-2027')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete physics-2027' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete physics-2027' }));
    expect(screen.queryByText('Your drafts')).toBeNull();
  });

  it('shows a draft without a name as Untitled exam', () => {
    saveDraft('abc', { ...content(''), plan: { ...defaultPlan, topics: [{ name: 'Mechanics', questions: '5' }] } });
    renderBoard();
    expect(screen.getByText('Untitled exam')).toBeTruthy();
  });

  it('lists the exams this browser published, separately, and opens one', () => {
    const id = examIdFromName('maths-2027');
    rememberExam({ id, name: 'maths-2027' });
    renderBoard();
    expect(screen.getByText('Your exams')).toBeTruthy();
    expect(screen.queryByText('Your drafts')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open maths-2027' }));
    expect(where()).toBe(`/board/exam/${id}`);
  });

  it('moves a draft from an older version into the list the first time /board opens', () => {
    localStorage.setItem(OLD, JSON.stringify(content('old-draft')));
    renderBoard();
    expect(screen.getByText('old-draft')).toBeTruthy();
    expect(nameField().value).toBe('');
  });

  it('opens with an empty form and no list when the saved drafts are damaged', () => {
    localStorage.setItem(DRAFTS, '{{{');
    renderBoard();
    expect(nameField().value).toBe('');
    expect(screen.queryByText('Your drafts')).toBeNull();
  });
});
