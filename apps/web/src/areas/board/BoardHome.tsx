import type { Hex } from '@paperseal/protocol';
import { Button, Logo, Page, PrimaryAction, RoleHeader } from '@paperseal/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useCurrentExamId } from '../../shared/currentExam';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import { useBoardForm, useReader } from './BoardForm';
import { editedWords, listDrafts, removeDraft } from './draftStore';
import { readSnapshot, type Snapshot } from './examState';
import { listKnownExams } from './examsStore';
import { useNow } from './hooks';
import { useListSettled, useRowReads } from './homeReads';
import { examStatus, homeRows, type HomeRow } from './homeStatus';
import { formatWhen } from './plan';

const examIdOf = (text: string): Hex | null => (/^0x[0-9a-fA-F]{64}$/.test(text.trim()) ? (text.trim().toLowerCase() as Hex) : null);

/** A quiet way back to an exam published from another browser, which this one cannot list. */
function OpenById() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setText('');
    setError(null);
  };
  return (
    <>
      <button
        type="button"
        className="board-home-link"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open an exam by its ID
      </button>
      {open ? (
        <dialog
          className="board-home-dialog"
          aria-labelledby="board-home-dialog-title"
          ref={(dialog) => {
            if (dialog && !dialog.open) dialog.showModal();
          }}
          onClose={close}
          onClick={(event) => {
            // A press on the backdrop lands on the dialog itself, outside its form.
            if (event.target === event.currentTarget) close();
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const id = examIdOf(text);
              if (id) void navigate(`/board/exam/${id}`);
              else setError('That is not an exam ID. It starts with 0x and is 66 characters long.');
            }}
          >
            <h2 id="board-home-dialog-title">Open an exam by its ID</h2>
            <p>Use this for an exam published from another browser.</p>
            <label className="ps-field">
              <span>Exam ID</span>
              <input
                className="ps-input"
                value={text}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setText(event.target.value);
                  setError(null);
                }}
              />
              {error ? <span className="ps-field-error">{error}</span> : null}
            </label>
            <div className="board-home-dialog-actions">
              <Button onClick={close}>Cancel</Button>
              <PrimaryAction type="submit">Open</PrimaryAction>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  );
}

/** The list before its first reads: the real row grid with bars in it, so nothing jumps when the rows arrive. */
function ListSkeleton(props: { rows: readonly HomeRow[] }) {
  return (
    <div className="board-skeleton">
      <span className="ps-sr" role="status">
        Checking…
      </span>
      <ul className="board-home-list" aria-hidden="true">
        {props.rows.map((row) => (
          <li key={row.key} className="board-row">
            <div className="board-home-name">
              <strong className="board-skeleton-bar board-skeleton-title" />
              {row.kind === 'draft' || !row.exam.name ? <span className="board-skeleton-bar" /> : null}
            </div>
            <div className="board-home-status">
              <span className="board-skeleton-bar board-home-bar-pill" />
            </div>
            <div className="board-home-date">
              <span className="board-skeleton-bar" />
            </div>
            <div className="board-home-actions">
              <span className="board-skeleton-bar board-home-bar-button" />
              {row.kind === 'draft' ? <span className="board-skeleton-bar board-home-bar-text" /> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A status in words, with a dot that only repeats what the word says. */
function Pill(props: { tone: 'neutral' | 'draft' | 'act' | 'quiet'; children: ReactNode }) {
  return (
    <span className="board-home-pill" data-tone={props.tone}>
      {props.children}
    </span>
  );
}

/** A published exam's plain status. */
function ExamPill(props: { snapshot: Snapshot | null; failed: boolean; now: number }) {
  const { snapshot, failed, now } = props;
  if (!snapshot && failed) return <Pill tone="quiet">Unavailable</Pill>;
  if (!snapshot) {
    return (
      <span role="status">
        <span className="board-skeleton-bar board-home-bar-pill" aria-hidden="true" />
        <span className="ps-sr">Checking…</span>
      </span>
    );
  }
  const status = examStatus(snapshot, now);
  const tone = status.needsBoard ? 'act' : snapshot.found ? 'neutral' : 'quiet';
  return <Pill tone={tone}>{status.label}</Pill>;
}

/**
 * `/board`: every exam and draft this browser knows, newest first, under the one way to start a new
 * one. Each published exam is read on its own, a few at a time, and a failed read only affects its
 * row. The heading, the create button and Open by ID show at once. The list itself is a skeleton
 * until every exam has a first read or `HOME_LIST_DEADLINE_MS` passes, whichever is first; a row
 * still unread by then shows a skeleton bar for its status. This page has its own layout in place of
 * `Stage`, and every style for it sits under `.board-home`.
 */
export function BoardHome() {
  const navigate = useNavigate();
  const reader = useReader();
  const { tee } = useBoardForm();
  const current = useCurrentExamId();
  const now = useNow(30_000);
  const [drafts, setDrafts] = useState(listDrafts);
  const [exams] = useState(listKnownExams);
  const [asking, setAsking] = useState<string | null>(null);
  const rows = homeRows(drafts, exams);

  // Paper Seal serves one exam at a time, so only the current exam is asked what it says.
  const load = useCallback(
    (examId: Hex, previous: Snapshot | null) => (reader ? readSnapshot({ registry: reader, tee: examId === current ? tee : null, examId }, previous) : Promise.reject(new Error('no registry'))),
    [reader, tee, current],
  );
  const examIds = exams.map((exam) => exam.id);
  const reads = useRowReads(examIds, reader ? load : null, TEE_STATUS_POLL_MS);
  const settled = useListSettled(examIds, reads, reader !== null);

  const create = (
    <PrimaryAction
      onClick={() => {
        void navigate('/board/new');
      }}
    >
      Create an exam
    </PrimaryAction>
  );

  const draftRow = (row: Extract<HomeRow, { kind: 'draft' }>) => {
    const { draft, title } = row;
    return (
      <li key={row.key} className={asking === draft.id ? 'board-row board-home-asking' : 'board-row'}>
        <div className="board-home-name">
          <strong>{title}</strong>
          <span>{row.progress}</span>
        </div>
        <div className="board-home-status">
          <Pill tone="draft">Draft</Pill>
        </div>
        <div className="board-home-date">Edited {editedWords(draft.updatedAt, now)}</div>
        <div className="board-home-actions">
          {asking === draft.id ? (
            <>
              <span>Delete this draft?</span>
              <Button
                className="ps-button board-home-confirm"
                aria-label={`Yes, delete ${title}`}
                onClick={() => {
                  removeDraft(draft.id);
                  setDrafts((previous) => previous.filter((other) => other.id !== draft.id));
                  setAsking(null);
                }}
              >
                Yes, delete
              </Button>
              <Button
                className="ps-button board-home-text"
                onClick={() => {
                  setAsking(null);
                }}
              >
                Keep it
              </Button>
            </>
          ) : (
            <>
              <Button
                aria-label={`Continue ${title}`}
                onClick={() => {
                  void navigate(`/board/draft/${draft.id}`);
                }}
              >
                Continue
              </Button>
              <Button
                className="ps-button board-home-text"
                aria-label={`Delete ${title}`}
                onClick={() => {
                  setAsking(draft.id);
                }}
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </li>
    );
  };

  const examRow = (row: Extract<HomeRow, { kind: 'exam' }>) => {
    const { exam, title } = row;
    const read = reads.get(exam.id);
    const snapshot = read?.state === 'ready' ? read.snapshot : null;
    const failed = !reader || read?.state === 'failed';
    const acts = snapshot ? examStatus(snapshot, now).needsBoard : false;
    const settings = snapshot?.found?.exam.settings;
    return (
      <li key={row.key} className={acts ? 'board-row board-row-act' : 'board-row'}>
        <div className="board-home-name">
          <strong>{title}</strong>
          {exam.name ? null : <span>Reference {exam.id.slice(2, 10)}</span>}
        </div>
        <div className="board-home-status">
          <ExamPill snapshot={snapshot} failed={failed} now={now} />
        </div>
        <div className="board-home-date">{settings ? `Exam on ${formatWhen(Number(settings.examStart))}` : null}</div>
        <div className="board-home-actions">
          <Button
            aria-label={`Open ${title}`}
            onClick={() => {
              void navigate(`/board/exam/${exam.id}`);
            }}
          >
            Open
          </Button>
        </div>
      </li>
    );
  };

  return (
    <Page header={<RoleHeader role="Exam board" />}>
      <section className="board-home">
        <div className="board-home-top">
          <div>
            <h1>Your exams</h1>
            <p>Manage your exams and drafts.</p>
          </div>
          <div className="board-home-action">{create}</div>
        </div>
        <div className="board-home-surface">
          {rows.length === 0 ? (
            <div className="board-home-empty">
              <Logo size={72} decorative />
              <p>You have no exams yet.</p>
            </div>
          ) : null}
          {rows.length > 0 ? (
            <div className="board-home-head" aria-hidden="true">
              <span>Exam</span>
              <span>Status</span>
              <span>Date</span>
            </div>
          ) : null}
          {rows.length > 0 && !settled ? <ListSkeleton rows={rows} /> : null}
          {rows.length > 0 && settled ? (
            <ul className="board-home-list" aria-label="Your exams and drafts">
              {rows.map((row) => (row.kind === 'draft' ? draftRow(row) : examRow(row)))}
            </ul>
          ) : null}
        </div>
        <div className="board-home-foot">
          <p>Drafts and this list are saved only in this browser. Exams published from another browser are not listed here.</p>
          <OpenById />
        </div>
      </section>
    </Page>
  );
}
