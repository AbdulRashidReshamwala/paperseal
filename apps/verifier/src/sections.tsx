import { chain as chainSpec, type Hex } from '@paperseal/protocol';
import { Badge, Button, Hash, Row, Rows } from '@paperseal/ui';
import type { ReactNode } from 'react';

import { dayTime, REPOSITORY, sepoliaName, utcTime, vouchNote, type View } from './custody';
import { etherscan, sourceWords, stateWords, type Copies, type Copy, type Moment, type People, type Person, type Piece } from './facts';
import type { BoardName, ExamNameRead, Version } from './identity';
import type { Polled } from './poll';
import { evidenceTable } from './record';

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function Fold({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="vf-connection vf-fold">
      <summary>{summary}</summary>
      <div className="vf-fold-body">{children}</div>
    </details>
  );
}

/** A record section: its heading and one line on what it holds. The page's contents link to its id. */
export function Section({ id, title, intro, children }: { id: string; title: string; intro: ReactNode; children: ReactNode }) {
  return (
    // Focusable from script only, so the contents can move a keyboard or screen reader here.
    <section id={id} className="vf-section" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <h2 id={`${id}-title`}>{title}</h2>
      <p className="vf-intro">{intro}</p>
      {children}
    </section>
  );
}

/** A state in words, in its tone's colour. The word carries it; the colour only helps a scan. */
function Toned({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="vf-toned" data-tone={tone}>
      {children}
    </span>
  );
}

const boardBadge: Record<BoardName['state'], { tone: string; word: string } | null> = {
  confirmed: { tone: 'ok', word: 'Name confirmed both ways' },
  unconfirmed: { tone: 'warn', word: 'Name not confirmed' },
  none: null,
  unread: { tone: 'neutral', word: 'Not read' },
};

function BoardValue({ board, name }: { board: Hex; name: Polled<BoardName> }) {
  const read = name.state === 'ready' ? name.value : null;
  const badge = read ? boardBadge[read.state] : null;
  return (
    <>
      <span className="vf-line">
        {read && 'name' in read ? <strong>{read.name}</strong> : null}
        {badge ? <Toned tone={badge.tone}>{badge.word}</Toned> : null}
      </span>
      <span className="vf-line">
        <Hash value={board} label="exam board account" />
        <Out href={`${etherscan}/address/${board}`}>Open on Etherscan</Out>
      </span>
      {read?.state === 'none' ? <span className="vf-aside">This board has no ENS name.</span> : null}
    </>
  );
}

/** The exam's name, shown only when one is listed: a name that passed, failed or could not be read. */
function examNameValue(examName: Polled<ExamNameRead>, openedName: string | null): ReactNode {
  const name = openedName ?? (examName.state === 'ready' ? examName.value.name : null);
  const failed = examName.state === 'ready' ? examName.value.failed : 0;
  // A read that failed says nothing about whether the exam has a name.
  const unread = examName.state === 'ready' && examName.value.unread !== undefined;
  if (name) {
    return (
      <>
        <strong>{name}</strong>
        <span className="vf-aside">{sepoliaName} The board’s own name and address are what vouch for it.</span>
      </>
    );
  }
  if (failed > 0) {
    return (
      <>
        <span>No name is listed for this exam.</span>
        <span className="vf-aside">A listed name did not pass its checks, so it is not shown.</span>
      </>
    );
  }
  return unread ? <span>Could not be read</span> : null;
}

function PersonLine({ person, zone, role }: { person: Person; zone: string | undefined; role?: boolean }) {
  return (
    <li>
      <span className="vf-line">
        <span className="vf-name">{person.name}</span>
        <Toned tone={person.state.tone}>{person.state.word}</Toned>
      </span>
      {person.releases ? (
        <span className="vf-when">{person.released ? `Released ${dayTime(person.released.at, zone)}` : 'No release recorded'}</span>
      ) : null}
      {role ? <span className="vf-aside">{person.role}</span> : null}
      {person.state.note ? <span className="vf-aside">{person.state.note}</span> : null}
    </li>
  );
}

export interface PeopleProps {
  found: People;
  zone: string | undefined;
  board: Hex | null;
  boardName: Polled<BoardName>;
  examName: Polled<ExamNameRead>;
  /** A name this page already opened and checked. */
  openedName: string | null;
}

/** Who ran the exam and who was on its list, as people. Setters only ever appear as codes. */
export function PeopleSection({ found, zone, board, boardName, examName, openedName }: PeopleProps) {
  const released = [...found.holders, ...found.centres].filter((person) => person.released);
  const nameValue = examNameValue(examName, openedName);
  return (
    <Section id="vf-people" title="People" intro="Who could take part. No one person can open the paper.">
      <dl className="vf-ledger">
        {board ? (
          <div>
            <dt>Exam board</dt>
            <dd>
              <BoardValue board={board} name={boardName} />
            </dd>
          </div>
        ) : null}
        {nameValue ? (
          <div>
            <dt>Exam name</dt>
            <dd>{nameValue}</dd>
          </div>
        ) : null}
        <div>
          <dt>Key holders</dt>
          <dd>
            {found.holders.length > 0 ? (
              <ul className="vf-names">
                {found.holders.map((person) => (
                  <PersonLine key={person.key} person={person} zone={zone} />
                ))}
              </ul>
            ) : (
              <span className="ps-empty">No key holders are on the list.</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Centres</dt>
          <dd>
            <Fold summary={`Show the ${String(found.centres.length)} centres`}>
              <ul className="vf-names">
                {found.centres.map((person) => (
                  <PersonLine key={person.key} person={person} zone={zone} role />
                ))}
              </ul>
            </Fold>
          </dd>
        </div>
        <div>
          <dt>Setters</dt>
          <dd>
            <Fold summary={`Show the ${String(found.setters.length)} setters, listed by code`}>
              <p className="vf-evidence-text">Setters are never named. Each one is listed by a code.</p>
              <Rows>
                {found.setters.map((code, at) => (
                  <Row key={code} label={`Setter ${String(at + 1)}`}>
                    <Hash value={code} label={`Setter ${String(at + 1)}`} />
                  </Row>
                ))}
              </Rows>
            </Fold>
          </dd>
        </div>
        {released.length > 0 ? (
          <div>
            <dt>Release times</dt>
            <dd>
              <Fold summary="Show when each release came in">
                <Rows>
                  {released.map((person) => (
                    <Row key={person.key} label={person.name}>
                      <span>Public clock round {String(person.released?.round)}</span>
                      <span>{utcTime(person.released?.at ?? 0)}</span>
                    </Row>
                  ))}
                </Rows>
              </Fold>
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="vf-aside">{found.verified ? 'Release times come from the signed record of releases.' : 'No signed record of releases has been checked yet.'}</p>
      {found.names.length > 0 ? (
        <Fold summary="About these names">
          <p className="vf-evidence-text">
            {vouchNote(found.names)} {sepoliaName}
          </p>
        </Fold>
      ) : null}
    </Section>
  );
}

/** The sealed machine's release, for the proof of the step that published the exam. */
export function MachineRow({ version }: { version: Polled<Version> }) {
  const found = version.state === 'ready' && version.value.state === 'found' ? version.value : null;
  return (
    <Rows>
      <Row label="Sealed machine">
        {found ? (
          <>
            <strong>{found.version}</strong> <Out href={found.url}>Read the release</Out>
          </>
        ) : (
          <span>{version.state === 'loading' ? 'Finding the release.' : 'No published release was matched.'}</span>
        )}
      </Row>
    </Rows>
  );
}

/** The exam's own record and the code it ran, for anyone who wants to look them up. */
export function RecordFold(props: { examId: Hex; registry: Hex; commit: Hex; imageDigest: Hex }) {
  const { registry, commit, imageDigest } = props;
  return (
    <Fold summary="Show the exam record and code">
      <Rows>
        <Row label="Exam ID">
          <Hash value={props.examId} label="This exam's ID" />
        </Row>
        <Row label="Exam record">
          <Hash value={registry} label="Exam record" />
          <Out href={`${etherscan}/address/${registry}`}>Open on Etherscan</Out>
        </Row>
        <Row label="Chain">Sepolia, chain {chainSpec.chainId}</Row>
        <Row label="Code version, the commit">
          <Hash value={commit} label="Commit" />
          <Out href={`https://github.com/${REPOSITORY}/commit/${commit.slice(2)}`}>Read this code</Out>
        </Row>
        <Row label="Software image">
          <Hash value={imageDigest} label="Software image" />
        </Row>
      </Rows>
    </Fold>
  );
}

/** Every moment's exact time and public clock round. The plain times are on the steps above. */
export function ClockFold({ moments }: { moments: readonly Moment[] }) {
  return (
    <Fold summary="Show public clock rounds and exact times">
      <Rows>
        {moments.map((moment) => (
          <Row key={moment.id} label={moment.label}>
            <span>{utcTime(moment.at)}</span>
            {moment.round === null ? null : <span>Round {String(moment.round)}</span>}
          </Row>
        ))}
      </Rows>
    </Fold>
  );
}

function CopyRow({ copy, zone }: { copy: Copy; zone: string | undefined }) {
  const state = stateWords[copy.state];
  return (
    <Row label={sourceWords[copy.source]}>
      <Badge tone={state.tone}>{state.word}</Badge>
      {copy.used ? <Badge tone="ok">Used by this page</Badge> : null}
      {copy.at === undefined ? null : <span>{dayTime(copy.at, zone)}</span>}
      {copy.note ? <span className="vf-aside">{copy.note}</span> : null}
      {copy.links?.map((link) => (
        <Out key={link.href} href={link.href}>
          {link.text}
        </Out>
      ))}
      {copy.reference ? <Hash value={copy.reference.value} label={copy.reference.label} /> : null}
    </Row>
  );
}

function PieceBlock({ piece, zone }: { piece: Piece; zone: string | undefined }) {
  const checked = piece.copies.filter((copy) => copy.state === 'checked').length;
  return (
    <section className="vf-piece">
      <h3 className="vf-evidence-heading">{piece.label}</h3>
      <p className="vf-aside">
        {piece.about} {checked === 0 ? 'No copy is checked yet.' : `Checked in ${String(checked)} ${checked === 1 ? 'place' : 'places'}.`}
      </p>
      <Rows>
        {piece.copies.map((copy) => (
          <CopyRow key={copy.source} copy={copy} zone={zone} />
        ))}
      </Rows>
    </section>
  );
}

/** Each piece against each place that keeps it, in the same words as the details below it. */
function EvidenceTable({ found }: { found: Copies }) {
  const table = evidenceTable(found);
  return (
    <table className="vf-matrix">
      <caption className="ps-sr">Where each piece of evidence is kept, and whether that copy is checked</caption>
      <thead>
        <tr>
          <td />
          {table.sources.map((source) => (
            <th key={source.id} scope="col">
              {source.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row) => (
          <tr key={row.id}>
            <th scope="row">{row.label}</th>
            {row.cells.map((cell, at) =>
              cell.kind === 'none' ? (
                <td key={table.sources[at]?.id} className="vf-none">
                  <span aria-hidden="true">–</span>
                  <span className="ps-sr">Not kept here</span>
                </td>
              ) : (
                <td key={table.sources[at]?.id} data-tone={cell.tone}>
                  {cell.word}
                  {cell.used ? <span className="vf-used">used here</span> : null}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface EvidenceProps {
  found: Copies;
  zone: string | undefined;
  view: Pick<View, 'now'>;
  onRetry: () => void;
  /** The exam's own record and code, once the record is read. */
  record: ReactNode;
}

/** Where every piece of evidence lives, and which copy this page used. */
export function EvidenceSection({ found, zone, view, onRetry, record }: EvidenceProps) {
  const { feed } = found;
  const failed = feed.state === 'unread' || found.pieces.some((piece) => piece.copies.some((copy) => copy.state === 'unread'));
  return (
    <Section
      id="vf-evidence"
      title="Evidence"
      intro="No single place has to be trusted. Each copy is checked against the public record, so a copy can go missing but can’t pass with changed contents."
    >
      <EvidenceTable found={found} />
      <p className="vf-legend">
        The exam record on Sepolia holds the fingerprint every copy must match, not the files. “Used here” marks the copy this page read, and “–” means that
        place does not keep it.
      </p>
      <Fold summary="Show every copy in detail">
        {found.pieces.map((piece) => (
          <PieceBlock key={piece.id} piece={piece} zone={zone} />
        ))}
        {failed ? (
          <p className="vf-more">
            <Button onClick={onRetry}>Read again</Button>
          </p>
        ) : null}
        <h3 className="vf-evidence-heading">The relay that writes these copies</h3>
        <Rows>
          <Row label="Feed">{feed.text}</Row>
          <Row label="Latest heartbeat">
            {feed.heartbeat ? (
              <span>
                {dayTime(feed.heartbeat.at, zone)}
                {feed.heartbeat.stage ? `, at the ${feed.heartbeat.stage} stage, as it says` : ''}
              </span>
            ) : (
              <span>None kept. A heartbeat lasts a day.</span>
            )}
          </Row>
          {feed.lastWrite === undefined ? null : (
            <Row label="Last wrote">
              <span>{dayTime(feed.lastWrite, zone)}</span>
              <span className="vf-aside">{view.now - feed.lastWrite < 120 ? 'Just now.' : null}</span>
            </Row>
          )}
        </Rows>
      </Fold>
      {record}
    </Section>
  );
}
