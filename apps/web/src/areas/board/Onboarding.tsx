import { decodeApprovedList, fromHex, toHex, type ApprovedListEntry } from '@paperseal/protocol';
import type { RegistrationEntry } from '@paperseal/tee-client';
import { Badge, Connected, EmptyState, Mono, Panel, Row, Rows, Screen } from '@paperseal/ui';
import { useMemo, useState } from 'react';

import { useCurrentExamId } from '../../shared/currentExam';
import { fromTee, notConnectedToTee } from '../../shared/tee';
import { TeeStatus } from '../../shared/TeeStatus';
import { useBoardForm } from './BoardForm';
import { postApprovedListFlow } from './postFlow';
import { PostPanel } from './PostPanel';
import { roleNames, rolesFor, tryCompose, withRoles } from './registrations';

const loadRegistrations = fromTee((client) => client.registrations());

const loadList = fromTee(async (client) => {
  const { approvedList } = await client.status();
  if (!approvedList) return null;
  try {
    return { entries: decodeApprovedList(fromHex(approvedList.entries)), error: null };
  } catch (error) {
    return { entries: [] as ApprovedListEntry[], error: (error as Error).message };
  }
});

const short = (key: string) => (key === '0x' ? 'none' : `${key.slice(0, 14)}…`);

export function EntryRows(props: { entries: readonly ApprovedListEntry[] }) {
  return (
    <Rows>
      {props.entries.map((entry) => (
        <Row key={toHex(entry.passkeyPublicKey)} label={entry.owner}>
          {roleNames[entry.role] ?? `Role ${String(entry.role)}`}, passkey <Mono>{short(toHex(entry.passkeyPublicKey))}</Mono>, derived{' '}
          <Mono>{short(toHex(entry.derivedPublicKey))}</Mono>
        </Row>
      ))}
    </Rows>
  );
}

/** Registrations the TEE reports, which are the entries of the list it read back from the chain. */
function Registered() {
  return (
    <Connected title="Read back by the TEE" notConnected={notConnectedToTee} load={loadList}>
      {(list) =>
        list === null ? (
          'The TEE has not read an approved list from the chain yet.'
        ) : list.error ? (
          `The TEE's list could not be read: ${list.error}`
        ) : (
          <EntryRows entries={list.entries} />
        )
      }
    </Connected>
  );
}

function Composer(props: { registrations: readonly RegistrationEntry[] }) {
  const { environment } = useBoardForm();
  const examId = useCurrentExamId();
  const [picked, setPicked] = useState<Record<string, number | undefined>>({});
  const entries = useMemo(() => withRoles(props.registrations, picked), [props.registrations, picked]);
  const composed = useMemo(() => (examId && entries.length > 0 ? tryCompose(examId, entries) : null), [examId, entries]);
  const blocked = !examId
    ? 'No exam is selected. Publish an exam or set VITE_EXAM_ID.'
    : entries.length === 0
      ? 'Choose a role for each registration to include.'
      : composed && !composed.ok
        ? composed.reason
        : null;

  return (
    <>
      <Panel title="Choose each role">
        {props.registrations.length === 0 ? (
          'Nobody has registered with the TEE yet.'
        ) : (
          <Rows>
            {props.registrations.map((registration) => (
              <Row key={registration.passkeyPublicKey} label={registration.owner}>
                <select
                  className="ps-input"
                  aria-label={`Role for ${registration.owner}`}
                  value={picked[registration.passkeyPublicKey] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    setPicked({ ...picked, [registration.passkeyPublicKey]: value === '' ? undefined : Number(value) });
                  }}
                >
                  <option value="">Leave out</option>
                  {rolesFor(registration.derivedPublicKey).map((role) => (
                    <option key={role} value={role}>
                      {roleNames[role]}
                    </option>
                  ))}
                </select>{' '}
                <Mono>{short(registration.passkeyPublicKey)}</Mono>
              </Row>
            ))}
          </Rows>
        )}
      </Panel>
      {composed?.ok ? (
        <Panel title="Composed list">
          <Rows>
            <Row label="Entries">{entries.length}</Row>
            <Row label="List hash (approvedList message)">
              <Mono>{composed.list.hash}</Mono>
            </Row>
          </Rows>
          <Badge tone="ok">The list passes the approved list rules.</Badge>
        </Panel>
      ) : (
        <EmptyState title="No list composed">{composed ? composed.reason : 'The list is composed once roles are chosen and the list passes the approved list rules.'}</EmptyState>
      )}
      <PostPanel
        title="Post the approved list"
        label="Post approved list"
        blocked={blocked}
        post={(onStage) => {
          if (!examId || !composed?.ok) return Promise.reject(new Error('There is no composed list to post.'));
          return postApprovedListFlow(environment, { examId, entries: composed.list.encoded }, onStage);
        }}
      />
    </>
  );
}

export function Onboarding() {
  return (
    <Screen title="Onboarding" lede="Registrations the TEE verified, with the role you give each, composed into the approved list and posted from the board wallet.">
      <TeeStatus />
      <Registered />
      <Connected title="Registrations" notConnected={notConnectedToTee} load={loadRegistrations}>
        {({ registrations }) => <Composer registrations={registrations} />}
      </Connected>
    </Screen>
  );
}
