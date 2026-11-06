import { Button } from '@paperseal/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { draftProgress, draftTitle, editedWords, listDrafts, removeDraft } from './draftStore';
import { listKnownExams } from './examsStore';

/**
 * Below the create form, and quiet: the drafts saved in this browser, and the exams it has published.
 * Neither list shows when it is empty. Deleting a draft takes one confirm.
 */
export function BoardLists(props: { exceptDraftId: string | null }) {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState(() => listDrafts().filter((draft) => draft.id !== props.exceptDraftId));
  const [exams] = useState(listKnownExams);
  const [asking, setAsking] = useState<string | null>(null);

  return (
    <>
      {drafts.length > 0 ? (
        <section className="board-list" aria-labelledby="board-drafts">
          <h2 id="board-drafts">Your drafts</h2>
          <p className="board-note">Drafts are saved only in this browser.</p>
          <ul>
            {drafts.map((draft) => {
              const title = draftTitle(draft);
              return (
                <li key={draft.id}>
                  <div className="board-list-text">
                    <strong>{title}</strong>
                    <span>
                      Edited {editedWords(draft.updatedAt)}. {draftProgress(draft)}.
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
            })}
          </ul>
        </section>
      ) : null}
      {exams.length > 0 ? (
        <section className="board-list" aria-labelledby="board-exams">
          <h2 id="board-exams">Your exams</h2>
          <ul>
            {exams.map((exam) => {
              const title = exam.name ?? 'An exam without a saved name';
              return (
                <li key={exam.id}>
                  <div className="board-list-text">
                    <strong>{title}</strong>
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
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
