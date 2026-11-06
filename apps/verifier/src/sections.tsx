import { chain as chainSpec, type Hex } from '@paperseal/protocol';
import { Badge, Button, CopyButton, Hash, Mono, Panel, Row, Rows, type Tone } from '@paperseal/ui';
import { Fragment, type ReactNode } from 'react';

import { dayTime, REPOSITORY, sepoliaName, utcTime, vouchNote, type View } from './custody';
import { etherscan, sourceWords, stateWords, type Copies, type Copy, type Moment, type People, type Person, type Piece } from './facts';
import type { BoardName, ExamNameRead, Version } from './identity';
import type { Polled } from './poll';

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function Fold({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="vf-connection vf-fold">
      <summary>{summary}</summary>
      <div className="vf-fold-body">{children}</div>
    </details>
  );
}

const boardBadge: Record<BoardName['state'], { tone: Tone; word: string } | null> = {
  confirmed: { tone: 'ok', word: 'Name confirmed both ways' },
  unconfirmed: { tone: 'warn', word: 'Name not confirmed' },
  none: null,
  unread: { tone: 'neutral', word: 'Not read' },
};

function BoardRow({ board, name }: { board: Hex; name: Polled<BoardName> }) {
  const read = name.state === 'ready' ? name.value : null;
  const badge = read ? boardBadge[read.state] : null;
  return (
    <Row label="Exam board">
      {read && 'name' in read ? <strong>{read.name}</strong> : null}
      {badge ? <Badge tone={badge.tone}>{badge.word}</Badge> : null}
      <Out href={`${etherscan}/address/${board}`}>
        <Mono>{board}</Mono>
      </Out>
      {read?.state === 'none' ? <span className="vf-aside">This board has no ENS name.</span> : null}
    </Row>
  );
}

export interface IdentityProps {
  examId: Hex;
  board: Hex | null;
  registry: Hex;
  commit: Hex;
  imageDigest: Hex;
  boardName: Polled<BoardName>;
  examName: Polled<ExamNameRead>;
  /** A name this page already opened and checked. */
  openedName: string | null;
  version: Polled<Version>;
  /** The address to share for this exam. */
  shareLink: string;
}

/** Who ran this exam, and what it ran on. */
export function IdentitySection(props: IdentityProps) {
  const { board, registry, commit, imageDigest, version, examName } = props;
  const name = props.openedName ?? (examName.state === 'ready' ? examName.value.name : null);
  const found = version.state === 'ready' && version.value.state === 'found' ? version.value : null;
  const failed = examName.state === 'ready' ? examName.value.failed : 0;
  const plainCommit = commit.slice(2);
  return (
    <Panel title="Who ran this exam">
      <Rows>
        {board ? <BoardRow board={board} name={props.boardName} /> : null}
        <Row label="Exam name">
          {name ? <strong>{name}</strong> : <span>No name is listed for this exam.</span>}
          {!name && failed > 0 ? <span className="vf-aside">A listed name did not pass its checks, so it is not shown.</span> : null}
        </Row>
        <Row label="Sealed machine">
          {found ? (
            <>
              <strong>{found.version}</strong> <Out href={found.url}>Read the release</Out>
            </>
          ) : (
            <span>{version.state === 'loading' ? 'Finding the release.' : 'No published release was matched.'}</span>
          )}
        </Row>
        <Row label="Share this exam">
          <span className="vf-link">
            <Mono>{props.shareLink}</Mono>
          </span>
          <CopyButton text={props.shareLink}>Copy link</CopyButton>
        </Row>
      </Rows>
      {name ? <p className="vf-aside">{sepoliaName} The board’s own name and address are what vouch for it.</p> : null}
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
            <Out href={`https://github.com/${REPOSITORY}/commit/${plainCommit}`}>Read this code</Out>
          </Row>
          <Row label="Software image">
            <Hash value={imageDigest} label="Software image" />
          </Row>
        </Rows>
      </Fold>
    </Panel>
  );
}

function PersonRow({ person, zone }: { person: Person; zone: string | undefined }) {
  return (
    <Row label={person.name}>
      <Badge tone={person.state.tone}>{person.state.word}</Badge>
      {person.releases ? (
        person.released ? (
          <span>Released {dayTime(person.released.at, zone)}</span>
        ) : (
          <span>No release recorded</span>
        )
      ) : null}
      {person.state.note ? <span className="vf-aside">{person.state.note}</span> : null}
    </Row>
  );
}

/** The list of people for this exam, as people. Setters only ever appear as codes. */
export function PeopleSection({ found, zone }: { found: People; zone: string | undefined }) {
  const released = [...found.holders, ...found.centres].filter((person) => person.released);
  return (
    <Panel title="People on this exam">
      <h3 className="vf-evidence-heading">Key holders</h3>
      {found.holders.length > 0 ? (
        <Rows>
          {found.holders.map((person) => (
            <PersonRow key={person.key} person={person} zone={zone} />
          ))}
        </Rows>
      ) : (
        <p className="ps-empty">No key holders are on the list.</p>
      )}
      <Fold summary={`Show the ${String(found.centres.length)} centres`}>
        <Rows>
          {found.centres.map((person) => (
            <Fragment key={person.key}>
              <PersonRow person={person} zone={zone} />
              <Row label={<span className="vf-aside">{person.role}</span>}>{''}</Row>
            </Fragment>
          ))}
        </Rows>
      </Fold>
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
      {released.length > 0 ? (
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
      ) : null}
      <p className="vf-aside">
        {found.verified ? 'Release times come from the signed record of releases.' : 'No signed record of releases has been checked yet.'}{' '}
        {found.names.length > 0 ? `${vouchNote(found.names)} ${sepoliaName}` : ''}
      </p>
    </Panel>
  );
}

/** The exam's times, as they happened. */
export function TimelineSection({ moments, zone }: { moments: readonly Moment[]; zone: string | undefined }) {
  return (
    <Panel title="When it happened">
      <Rows>
        {moments.map((moment) => (
          <Row key={moment.id} label={moment.label} muted={!moment.happened}>
            <span>
              {dayTime(moment.at, zone)}
              {moment.happened ? '' : ', due'}
            </span>
            {moment.note ? <span className="vf-aside">{moment.note}</span> : null}
          </Row>
        ))}
      </Rows>
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
    </Panel>
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

/** Where every piece of evidence lives, and which copy this page used. */
export function CopiesSection({ found, zone, view, onRetry }: { found: Copies; zone: string | undefined; view: Pick<View, 'now'>; onRetry: () => void }) {
  const { feed } = found;
  const failed = feed.state === 'unread' || found.pieces.some((piece) => piece.copies.some((copy) => copy.state === 'unread'));
  return (
    <Panel title="Where the evidence lives">
      <p className="vf-evidence-text">
        No single place has to be trusted. Each copy is checked against the public record, so a copy can go missing but can’t pass with changed contents.
      </p>
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
    </Panel>
  );
}

/** Three plain facts under the headline, for a viewer who reads nothing else. */
export function Glance({ items }: { items: readonly { label: string; value: string }[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="vf-glance">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
