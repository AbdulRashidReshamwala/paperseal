import type { Hex } from '@paperseal/protocol';
import { Button, Page, PrimaryAction, RoleHeader, Stage } from '@paperseal/ui';
import { useCallback, useState } from 'react';
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
import { Fold } from './Parts';
import { formatWhen } from './plan';

const examIdOf = (text: string): Hex | null => (/^0x[0-9a-fA-F]{64}$/.test(text.trim()) ? (text.trim().toLowerCase() as Hex) : null);

/** A quiet way back to an exam published from another browser, which this one cannot list. */
function OpenById() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Fold summary="Open an exam by its ID">
      <form
        className="board-open-id"
        onSubmit={(event) => {
          event.preventDefault();
          const id = examIdOf(text);
          if (id) void navigate(`/board/exam/${id}`);
          else setError('That is not an exam ID. It starts with 0x and is 66 characters long.');
        }}
      >
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
        <Button type="submit">Open</Button>
      </form>
    </Fold>
  );
}

/** The list before its first reads: one empty row for each real one, so nothing jumps when they arrive. */
function ListSkeleton(props: { rows: readonly HomeRow[] }) {
  return (
    <div className="board-skeleton">
      <span className="ps-sr" role="status">
        Checking…
      </span>
      <ul className="board-home-list" aria-hidden="true">
        {props.rows.map((row) => (
          <li key={row.key} className="board-row">
            <div className="board-list-text">
              <strong className="board-skeleton-bar board-skeleton-title" />
              <span className="board-skeleton-bar" />
              <span className="board-skeleton-bar board-skeleton-line" />
            </div>
            <div className="board-list-actions">
              <span className="board-skeleton-bar board-skeleton-button" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a published exam's row says about it: the exam's date, and its plain status. */
function ExamLine(props: { snapshot: Snapshot | null; failed: boolean; now: number }) {
  const { snapshot, failed, now } = props;
  if (!snapshot && failed) return <span>Status not available right now</span>;
  if (!snapshot) {
    return (
      <span role="status">
        <span className="board-skeleton-bar" aria-hidden="true" />
        <span className="ps-sr">Checking…</span>
      </span>
    );
  }
  const settings = snapshot.found?.exam.settings;
  return (
    <>
      <span className="board-row-status">{examStatus(snapshot, now).label}</span>
      {settings ? <span>Exam on {formatWhen(Number(settings.examStart))}</span> : null}
    </>
  );
}

/**
 * `/board`: every exam and draft this browser knows, newest first, under the one way to start a new
 * one. Each published exam is read on its own, a few at a time, and a failed read only affects its
 * row. The heading, the create button and Open by ID show at once. The list itself is a skeleton
 * until every exam has a first read or `HOME_LIST_DEADLINE_MS` passes, whichever is first; a row
 * still unread by then shows a skeleton bar for its status.
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
      <li key={row.key} className="board-row">
        <div className="board-list-text">
          <strong>{title}</strong>
          <span className="board-row-status">Draft</span>
          <span>
            Edited {editedWords(draft.updatedAt, now)}. {row.progress}.
          </span>
        </div>
        <div className="board-list-actions">
          {asking === draft.id ? (
            <>
              <span>Delete this draft?</span>
              <Button
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
    return (
      <li key={row.key} className={acts ? 'board-row board-row-act' : 'board-row'}>
        <div className="board-list-text">
          <strong>{title}</strong>
          <ExamLine snapshot={snapshot} failed={failed} now={now} />
          {exam.name ? null : <span>Reference {exam.id.slice(2, 10)}</span>}
        </div>
        <div className="board-list-actions">
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
      <Stage
        title="Your exams"
        {...(rows.length === 0 ? { lede: 'You have no exams yet.' } : {})}
        action={create}
        next="Creating an exam opens the form. Nothing is published until you review it."
      >
        {rows.length > 0 && !settled ? <ListSkeleton rows={rows} /> : null}
        {rows.length > 0 && settled ? (
          <ul className="board-home-list" aria-label="Your exams and drafts">
            {rows.map((row) => (row.kind === 'draft' ? draftRow(row) : examRow(row)))}
          </ul>
        ) : null}
        <p className="board-note">Drafts and this list are saved only in this browser. Exams published from another browser are not listed here.</p>
        <OpenById />
      </Stage>
    </Page>
  );
}
