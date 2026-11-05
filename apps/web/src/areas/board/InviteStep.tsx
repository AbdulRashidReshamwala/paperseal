import type { Hex } from '@paperseal/protocol';
import { roundAtSeconds } from '@paperseal/protocol';
import { Badge, Button, Field, Mono, Panel, Row, Rows } from '@paperseal/ui';
import { useState } from 'react';

import {
  createInvite,
  exportInvites,
  InviteError,
  inviteMessage,
  loadInvites,
  saveInvites,
  type Invite,
  type InviteStore,
  type RandomBytes,
} from './invites';

/**
 * The invite step. The board enters a setter's name, and the app makes a salt and shows the
 * commitment and salt to give to the setter. Names and salts stay in this browser only. The
 * approved list on-chain shows the commitment, never the name.
 */
export function InviteStep(props: {
  examId: Hex | null;
  /** The end round from ExamRegistry, or null when it can't be read. */
  endRound: number | null;
  /** Unix milliseconds. Defaults to the clock. */
  now?: () => number;
  random?: RandomBytes;
}) {
  const { examId } = props;
  const [store, setStore] = useState<InviteStore>(() => (examId ? loadInvites(examId) : { invites: [], exportedAt: null }));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Invite | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  if (!examId) {
    return (
      <Panel title="Invite a setter">
        No exam is selected. Publish an exam or set VITE_EXAM_ID, because each commitment is for one exam.
      </Panel>
    );
  }

  const update = (next: InviteStore) => {
    saveInvites(examId, next);
    setStore(next);
  };

  const invite = () => {
    try {
      const created = createInvite(examId, name, store.invites, props.random);
      update({ ...store, invites: [...store.invites, created] });
      setShown(created);
      setName('');
      setError(null);
    } catch (cause) {
      if (!(cause instanceof InviteError)) throw cause;
      setError(cause.message);
    }
  };

  const nowSeconds = Math.floor((props.now ?? (() => Date.now()))() / 1000);
  const ended = props.endRound !== null && roundAtSeconds(nowSeconds) >= props.endRound;
  const exportedBefore = store.exportedAt !== null;

  return (
    <>
      <Panel title="Invite a setter">
        <p>
          The approved list is public, so a setter goes on it as a salted hash of their name, not the name. This
          page makes the salt and the hash. Give both to the setter, who registers with the hash as their name. The
          name and salt stay in this browser only until you publish them after the end round.
        </p>
        <Field label="Setter's name" value={name} onChange={setName} error={error ?? undefined} />
        <Button disabled={name.trim() === ''} onClick={invite}>
          Create invite
        </Button>
        {shown ? (
          <Rows>
            <Row label="Commitment, to register with">
              <Mono>{shown.commitment}</Mono>
            </Row>
            <Row label="Salt, to keep">
              <Mono>{shown.salt}</Mono>
            </Row>
            <Row label="Give to the setter">
              <pre>{inviteMessage(shown)}</pre>
            </Row>
          </Rows>
        ) : null}
      </Panel>
      <Panel title="Invites kept in this browser">
        <Badge tone="warn">Local only. These names are not on-chain.</Badge>
        {store.invites.length === 0 ? (
          <p>{exportedBefore ? 'The names and salts were exported and removed from this browser.' : 'No invites yet.'}</p>
        ) : (
          <Rows>
            {store.invites.map((entry) => (
              <Row key={entry.commitment} label={entry.name}>
                <Mono>{entry.commitment}</Mono>
              </Row>
            ))}
          </Rows>
        )}
      </Panel>
      <Panel title="Publish the names after the end round">
        <p>
          After the end round, export each name and salt as JSON and publish it. Anyone can then recompute the hashes
          on the verifier page and check them against the list. You can export once: save the JSON, then remove it
          from this browser.
        </p>
        {exported !== null ? (
          <>
            <textarea className="ps-input" readOnly rows={8} value={exported} aria-label="Names and salts to publish" />
            <Button
              onClick={() => {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(new Blob([exported], { type: 'application/json' }));
                link.download = `setters-${examId}.json`;
                link.click();
                URL.revokeObjectURL(link.href);
              }}
            >
              Download JSON
            </Button>{' '}
            <Button
              onClick={() => {
                update({ invites: [], exportedAt: nowSeconds * 1000 });
                setExported(null);
                setShown(null);
              }}
            >
              I saved it: remove names and salts from this browser
            </Button>
          </>
        ) : (
          <Button
            disabled={!ended || store.invites.length === 0 || exportedBefore}
            onClick={() => {
              setExported(exportInvites(store.invites));
            }}
          >
            Export names and salts
          </Button>
        )}
        {exported === null && !ended ? (
          <p>
            <Badge tone="neutral">Not yet</Badge>{' '}
            {props.endRound === null
              ? 'The end round could not be read from ExamRegistry, so export stays closed.'
              : `Export opens when drand publishes round ${String(props.endRound)}.`}
          </p>
        ) : null}
      </Panel>
    </>
  );
}
