import { resolveExamName } from '@paperseal/chain';
import type { Hex } from '@paperseal/protocol';
import { Badge, Button, Check, Field, Mono, Panel, RoleHeader, Row, Rows, shortenHash, type Tone } from '@paperseal/ui';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';

import { dayTime } from './custody';
import {
  examStatus,
  findParticipant,
  isAbandoned,
  loadExamHistory,
  roleWords,
  statusWords,
  type ExamHistory,
  type ExamStatus,
  type HistoryExam,
  type ParticipantSearch,
  type UnreadExam,
} from './history';
import { useLatestRound, useNow } from './live';
import { OwnConnection } from './page';
import { usePoll, type Polled } from './poll';
import { readTransport } from './rpc';
import { arkivWriters, useConnections } from './settings';

const statusTones: Record<ExamStatus, Tone> = {
  setup: 'neutral',
  questions: 'neutral',
  waiting: 'neutral',
  sealed: 'ok',
  'under-way': 'ok',
  finished: 'ok',
  'never-ran': 'neutral',
};

/** How often the public clock is read here. It only moves an exam from one status to the next. */
const CLOCK_POLL_MS = 30_000;

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

const readTime = (at: number) => new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium' }).format(at);

/** The exam's own page: by its name once that passed the name check, by its ID otherwise. */
function ExamLink({ examId, name }: { examId: Hex; name: string | null }) {
  if (name) return <Link to={`/name/${encodeURIComponent(name)}`}>{name}</Link>;
  return (
    <Link to={`/exam/${examId}`} aria-label={`Exam ${examId}`} title={examId}>
      <Mono>{shortenHash(examId)}</Mono>
    </Link>
  );
}

function Unread({ children, message }: { children: ReactNode; message: string }) {
  return (
    <div className="vf-gap">
      <Check status="not-checked">
        {children}
        <details>
          <summary>Details</summary>
          {message}
        </details>
      </Check>
    </div>
  );
}

/** An exam that could not be read yet: no stage or time is claimed, and nothing has failed. */
function UnreadRow({ exam, children }: { exam: UnreadExam; children: ReactNode }) {
  return (
    <Row label={<ExamLink examId={exam.examId} name={null} />}>
      <Check status="not-checked">
        {children}
        <details>
          <summary>Details</summary>
          {exam.reason}
        </details>
      </Check>
    </Row>
  );
}

const missingNote = 'This list shows the exams these writers have indexed. An exam missing here may still exist.';

function copyWords(copies: HistoryExam['copies']): string {
  if (!copies) return 'Copies not read';
  if (copies.arkiv && copies.swarm) return 'Copies on Arkiv and Swarm';
  if (copies.arkiv) return 'Copy on Arkiv';
  return copies.swarm ? 'Copy on Swarm' : 'No copies yet';
}

function ExamRow({ exam, status }: { exam: HistoryExam; status: ExamStatus }) {
  return (
    <Row label={<ExamLink examId={exam.examId} name={exam.name} />}>
      <Badge tone={statusTones[status]}>{statusWords[status]}</Badge>
      <span>Starts {dayTime(Number(exam.examStart))}</span>
      {exam.people === null ? null : <span>{plural(exam.people, 'person', 'people')}</span>}
      <span>{copyWords(exam.copies)}</span>
      {exam.behind ? <span className="vf-aside">The Arkiv copy is behind.</span> : null}
    </Row>
  );
}

const statusOrder: readonly ExamStatus[] = ['setup', 'questions', 'waiting', 'sealed', 'under-way', 'finished'];

function ExamList({ history, onReload }: { history: Polled<ExamHistory>; onReload: () => void }) {
  const { drand } = useConnections();
  const latest = useLatestRound(drand, CLOCK_POLL_MS);
  const now = useNow();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ExamStatus | 'all'>('all');
  if (history.state === 'off') return null;
  if (history.state === 'loading') return <p className="ps-empty">Reading the exam history. This takes a few seconds.</p>;
  if (history.state === 'error') {
    return (
      <>
        <Unread message={history.message}>The exam history could not be read. Read it again, or check your sources below.</Unread>
        <Button onClick={onReload}>Read again</Button>
      </>
    );
  }
  // Exams that never ran are left out, and nothing here counts them. Their own pages still open.
  const exams = history.value.exams.filter((exam) => examStatus(exam, latest.round, now) !== 'never-ran');
  const { unread, ignored } = history.value;
  const rowsIgnored = ignored.notOnChain + ignored.differs + ignored.malformed;
  const wanted = search.trim().toLowerCase();
  const shown = exams
    .map((exam) => ({ exam, status: examStatus(exam, latest.round, now) }))
    .filter(({ exam, status }) => (filter === 'all' || status === filter) && (wanted === '' || exam.examId.includes(wanted) || (exam.name ?? '').toLowerCase().includes(wanted)));
  const main = shown;
  const present = statusOrder.filter((status) => exams.some((exam) => examStatus(exam, latest.round, now) === status));
  return (
    <>
      {exams.length === 0 && unread.length === 0 ? (
        <p className="ps-empty">These writers have not indexed any exam on the public record yet.</p>
      ) : (
        <>
          <div className="vf-filters">
            <Field label="Find an exam" hint="By its name or its ID." value={search} onChange={setSearch} />
            <label className="vf-filter">
              <span>Show</span>
              <select
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value as ExamStatus | 'all');
                }}
              >
                <option value="all">All exams</option>
                {present.map((status) => (
                  <option key={status} value={status}>
                    {statusWords[status]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {main.length === 0 ? <p className="ps-empty">No exam matches this.</p> : null}
          <Rows>
            {main.map(({ exam, status }) => (
              <ExamRow key={exam.examId} exam={exam} status={status} />
            ))}
            {filter === 'all'
              ? unread.map((exam) => (
                  <UnreadRow key={exam.examId} exam={exam}>
                    Could not be read yet.
                  </UnreadRow>
                ))
              : null}
          </Rows>
          <p className="vf-aside">Copies are as recorded here. Open an exam to see each one checked.</p>
        </>
      )}
      {unread.length > 0 ? (
        <p className="vf-aside">
          {plural(unread.length, 'exam', 'exams')} could not be read from the public record yet, so{' '}
          {unread.length === 1 ? 'it is' : 'they are'} not checked. This is often a busy source. Read again in a minute.
        </p>
      ) : null}
      <p className="vf-aside">{missingNote}</p>
      {rowsIgnored > 0 ? (
        <details className="vf-connection vf-ignored">
          <summary>{plural(rowsIgnored, 'row was ignored', 'rows were ignored')} because the public record does not match</summary>
          <ul>
            {ignored.notOnChain > 0 ? <li>{plural(ignored.notOnChain, 'row names an exam', 'rows name exams')} not on the public record.</li> : null}
            {ignored.differs > 0 ? (
              <li>{plural(ignored.differs, 'row has', 'rows have')} a different start time or criteria from the public record.</li>
            ) : null}
            {ignored.malformed > 0 ? <li>{plural(ignored.malformed, 'row could', 'rows could')} not be read.</li> : null}
          </ul>
        </details>
      ) : null}
      {ignored.names > 0 ? (
        <p className="vf-aside">
          {plural(ignored.names, 'name did', 'names did')} not pass the name check, so {ignored.names === 1 ? 'that exam shows' : 'those exams show'}{' '}
          its ID.
        </p>
      ) : null}
      <p className="vf-fresh">
        Last read at {readTime(history.readAt)}. <Button onClick={onReload}>Read again</Button>
      </p>
    </>
  );
}

function ParticipantResults({ search, names }: { search: Polled<ParticipantSearch>; names: ReadonlyMap<Hex, string> }) {
  const now = useNow();
  if (search.state === 'off') return null;
  if (search.state === 'loading') return <p className="ps-empty">Looking for this name.</p>;
  if (search.state === 'error') return <Unread message={search.message}>The search could not be finished. Try again.</Unread>;
  const { unchecked, ignored } = search.value;
  const exams = search.value.exams.filter((exam) => !isAbandoned(exam, now));
  const notOnList = ignored.notOnList + ignored.malformed;
  return (
    <>
      {exams.length === 0 && unchecked.length === 0 ? (
        <p className="ps-empty">No exam these writers have indexed lists this name.</p>
      ) : (
        <Rows>
          {exams.map((exam) => (
            <Row key={`${exam.examId}${exam.role}`} label={<ExamLink examId={exam.examId} name={names.get(exam.examId) ?? null} />}>
              <span>{roleWords(exam.role)}</span>
              {exam.examStart === null ? null : <span>Starts {dayTime(Number(exam.examStart))}</span>}
            </Row>
          ))}
          {unchecked.map((exam) => (
            <UnreadRow key={exam.examId} exam={exam}>
              The list of people for this exam could not be read yet.
            </UnreadRow>
          ))}
        </Rows>
      )}
      {unchecked.length > 0 ? (
        <p className="vf-aside">
          {plural(unchecked.length, 'exam', 'exams')} could not be checked yet. Find exams again in a minute to try once more.
        </p>
      ) : null}
      {notOnList > 0 ? (
        <p className="vf-aside">
          {plural(notOnList, 'entry was', 'entries were')} not shown, because the exam&apos;s list on the public record does not hold{' '}
          {notOnList === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
      {ignored.badList > 0 ? (
        <p className="vf-aside">
          {plural(ignored.badList, 'entry was', 'entries were')} not shown, because the exam&apos;s list on the public record did not pass
          its checks.
        </p>
      ) : null}
      <p className="vf-aside">This only finds exams these writers have indexed. An exam missing here may still list this name.</p>
    </>
  );
}

function ParticipantForm({ onSearch }: { onSearch: (owner: string) => void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.trim() === '') {
      setError('Enter a name exactly as it appears on the list of people for the exam.');
      return;
    }
    setError(undefined);
    // Owners are matched exactly, so the name is passed on as typed.
    onSearch(draft);
  }
  return (
    <form className="vf-picker" onSubmit={submit}>
      <Field
        label="Name on the list"
        hint="A key holder or centre, exactly as the exam board wrote it on the list of people for the exam. Setters are listed by a code, never by name."
        value={draft}
        error={error}
        onChange={setDraft}
      />
      <Button type="submit">Find exams</Button>
    </form>
  );
}

/** `#/exams`: the exams the viewer's Arkiv writers have indexed, each checked against the public record. */
/** The exam history from the trusted writers, each exam checked against the public record. Null while there is nothing to read from. */
function useExamHistory(reads: number) {
  const { settings, registry, arkiv } = useConnections();
  const { rpcUrl } = settings;
  const writers = useMemo(() => arkivWriters(settings.arkivWriters, null).map((writer) => writer.address), [settings.arkivWriters]);
  const reader = arkiv?.reader ?? null;
  const loadHistory = useMemo(() => {
    if (!reader || !registry || writers.length === 0) return null;
    void reads;
    return () => loadExamHistory({ reader, registry, writers, checkName: (name) => resolveExamName(name, { transport: readTransport(rpcUrl) }) });
  }, [reader, registry, writers, rpcUrl, reads]);
  return usePoll(loadHistory, null);
}

/** How many exams the start page lists before "See all exams". */
const RECENT_COUNT = 5;

/**
 * The newest exams on the start page, so a visitor with no exam ID still has a way in. Search stays
 * first: a list can't say which exam is the board's real one, so the note says to match the ID.
 */
export function RecentExams() {
  const history = useExamHistory(0);
  const { drand } = useConnections();
  const latest = useLatestRound(drand, CLOCK_POLL_MS);
  const now = useNow();
  if (history.state === 'off') return null;
  const exams =
    history.state === 'ready'
      ? history.value.exams
          .map((exam) => ({ exam, status: examStatus(exam, latest.round, now) }))
          .filter(({ status }) => status !== 'never-ran')
          .sort((a, b) => Number(b.exam.examStart) - Number(a.exam.examStart))
          .slice(0, RECENT_COUNT)
      : [];
  return (
    <Panel title="Recent exams">
      {history.state === 'loading' ? <p className="ps-empty">Reading recent exams. This takes a few seconds.</p> : null}
      {history.state === 'error' ? <p className="ps-empty">Recent exams could not be read just now.</p> : null}
      {history.state === 'ready' && exams.length === 0 ? <p className="ps-empty">No exams have been listed here yet.</p> : null}
      {exams.length > 0 ? (
        <Rows>
          {exams.map(({ exam, status }) => (
            <ExamRow key={exam.examId} exam={exam} status={status} />
          ))}
        </Rows>
      ) : null}
      <p className="vf-aside">
        Listed by the writers this page trusts, and each checked against the public record. Always match the exam ID with your exam
        board&apos;s own announcement.
      </p>
      <p className="vf-more">
        <Link to="/exams">See all exams</Link>, or find the exams a person is listed for.
      </p>
    </Panel>
  );
}

export function HistoryPage() {
  const { settings, registry, arkiv } = useConnections();
  const writers = useMemo(() => arkivWriters(settings.arkivWriters, null).map((writer) => writer.address), [settings.arkivWriters]);
  const reader = arkiv?.reader ?? null;
  // Each press of "Read again" bumps this, which makes a new read below.
  const [reads, setReads] = useState(0);
  // A new object per search, so searching the same name again reads again.
  const [query, setQuery] = useState<{ owner: string } | null>(null);

  const history = useExamHistory(reads);

  const loadSearch = useMemo(() => {
    if (!reader || !registry || writers.length === 0 || query === null) return null;
    const { owner } = query;
    return () => findParticipant({ reader, registry, writers, owner });
  }, [reader, registry, writers, query]);
  const search = usePoll(loadSearch, null);

  const names = useMemo(
    () =>
      new Map(
        history.state === 'ready'
          ? history.value.exams.flatMap((exam) => (exam.name ? [[exam.examId, exam.name] as const] : []))
          : [],
      ),
    [history],
  );

  const ready = registry !== null && reader !== null;
  return (
    <div className="ps-shell vf-page">
      <RoleHeader role="Public record" note="Anyone can check this" />
      <main className="vf-single">
        <section className="vf-start">
          <h1 className="vf-headline">Exam history</h1>
          <p className="vf-lede">
            Choose an exam to see where it is now, or find the exams a person is listed for. Every exam here is checked against the
            public record first.
          </p>
        </section>
        {ready ? null : (
          <Panel title="Choose where to read from first">
            {registry === null ? (
              <p>
                Add where to read the public record and the exam registry location under &quot;Check it yourself&quot; below. Nothing is
                read until then.
              </p>
            ) : null}
            {writers.length === 0 ? (
              <p>
                Add the Arkiv writer addresses your exam board publishes under &quot;Who may write the copy on Arkiv&quot; below. Only
                exams these writers have indexed can be listed, and nothing is read until you add them.
              </p>
            ) : reader === null ? (
              <p>Add where to read the copy on Arkiv below. Nothing is read until then.</p>
            ) : null}
          </Panel>
        )}
        {ready ? (
          <Panel title="Exams on this record">
            <ExamList
              history={history}
              onReload={() => {
                setReads((n) => n + 1);
              }}
            />
          </Panel>
        ) : null}
        {ready ? (
          <Panel title="Find exams by person">
            <ParticipantForm
              onSearch={(owner) => {
                setQuery({ owner });
              }}
            />
            <ParticipantResults search={search} names={names} />
          </Panel>
        ) : null}
        <p className="vf-more">
          <Link to="/">Check one exam by its ID or name</Link>
        </p>
        <section className="vf-section vf-closing">
          <h2>Check it yourself</h2>
          <p>
            You don&apos;t have to trust this page, or whoever hosts it. The list only helps you find exams: each one is checked
            against the public record through the source you choose. Your choices stay in this browser.
          </p>
          <OwnConnection open={!ready} />
        </section>
      </main>
    </div>
  );
}
