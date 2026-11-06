import { Button } from '@paperseal/ui';
import type { Hex } from '@paperseal/protocol';
import { useState, type ChangeEvent } from 'react';

import { backupText, mergeInvites, parseBackup, type BoardInvite } from './invites';

/** Saves the text as a file in the browser's downloads. Returns false when the browser can't. */
function saveFile(name: string, text: string): boolean {
  try {
    if (typeof URL.createObjectURL !== 'function') return false;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Invites live in this browser only. This saves them to a file, and brings them back from one, so
 * clearing the browser or changing computer doesn't lose the links already sent.
 */
export function InviteBackup(props: {
  examId: Hex;
  invites: readonly BoardInvite[];
  onRestore: (invites: readonly BoardInvite[]) => void;
}) {
  const [message, setMessage] = useState<{ tone: 'ok' | 'problem'; text: string } | null>(null);

  const save = () => {
    const name = `paperseal-invites-${props.examId.slice(2, 10)}.json`;
    setMessage(
      saveFile(name, backupText(props.examId, props.invites))
        ? { tone: 'ok', text: `Saved as ${name}. Keep it private: it holds everyone’s links.` }
        : { tone: 'problem', text: 'This browser could not save the file. Copy the links one by one instead.' },
    );
  };

  const restore = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    file.text().then(
      (text) => {
        const parsed = parseBackup(text, props.examId);
        if (!parsed.ok) {
          setMessage({ tone: 'problem', text: parsed.reason });
          return;
        }
        const merged = mergeInvites(props.invites, parsed.invites);
        const added = merged.length - props.invites.length;
        props.onRestore(merged);
        setMessage({
          tone: 'ok',
          text: added === 0 ? 'Everything in this backup is already here.' : `Brought back ${String(added)} ${added === 1 ? 'invite' : 'invites'}.`,
        });
      },
      () => {
        setMessage({ tone: 'problem', text: 'That file could not be read. Choose the backup file again.' });
      },
    );
  };

  return (
    <div className="board-backup">
      <p className="board-note">
        Your invites are kept in this browser only. If you clear its data or use another computer, they are lost. Save a backup
        to keep them. The backup is private, because it holds everyone’s links.
      </p>
      <p className="board-actions">
        {props.invites.length > 0 ? <Button onClick={save}>Save a backup</Button> : null}
        <label className="ps-button board-file">
          Restore from a backup
          <input type="file" accept="application/json,.json" onChange={restore} />
        </label>
      </p>
      {message ? (
        <p className={message.tone === 'problem' ? 'board-problem' : 'board-note'} role={message.tone === 'problem' ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
