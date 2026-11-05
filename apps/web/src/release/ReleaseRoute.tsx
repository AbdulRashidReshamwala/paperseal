import { fromHex, toHex, type Hex } from '@paperseal/protocol';
import { useEffect, useMemo, useState } from 'react';

import { attestationChecker } from '../shared/attest';
import { storageUrl } from '../shared/config';
import { useCurrentExamId } from '../shared/currentExam';
import { listEntryFor, useHolderCredential, type HolderRole } from '../shared/holder';
import { browserKeys, describeError } from '../shared/Register';
import { registry } from '../shared/registry';
import { storageFetcher } from '../shared/storage';
import { tee } from '../shared/tee';
import type { ReleaseContext } from './flow';
import { ReleaseScreen, type Prerequisite } from './ReleaseScreen';

type ListEntry = { state: 'idle' } | { state: 'found'; key: Hex } | { state: 'not_a_holder' } | { state: 'failed'; message: string };

/** The release screen for /centre and /keyholder. No context exists until every item is ready. */
export function ReleaseRoute(props: { role: HolderRole }) {
  const examId = useCurrentExamId();
  const credential = useHolderCredential(props.role);
  // The derived key that names the share file comes from the on-chain list, not from the browser.
  // `at` ties each answer to the exam and key it was read for, so a stale answer is never used.
  const [entry, setEntry] = useState<{ at: string; result: ListEntry } | null>(null);
  const at = examId && credential ? `${examId}:${credential.passkeyPublicKey}` : null;
  useEffect(() => {
    if (!registry || !examId || !credential || !at) return;
    let live = true;
    listEntryFor(registry, examId, credential.passkeyPublicKey).then(
      (found) => {
        if (!live) return;
        setEntry({
          at,
          result:
            found && found.derivedPublicKey.length > 0
              ? { state: 'found', key: toHex(found.derivedPublicKey) }
              : { state: 'not_a_holder' },
        });
      },
      (error: unknown) => {
        // A failed read is shown, never swallowed: the list may be on-chain but unreadable.
        if (live) setEntry({ at, result: { state: 'failed', message: describeError(error) } });
      },
    );
    return () => {
      live = false;
    };
  }, [examId, credential, at]);

  const result: ListEntry = entry && entry.at === at ? entry.result : { state: 'idle' };
  const derivedKey = result.state === 'found' ? result.key : null;

  const prerequisites: Prerequisite[] = [
    { label: 'TEE connected', met: tee !== null },
    { label: 'ExamRegistry and exam ID set', met: registry !== null && examId !== null },
    { label: 'Public storage set', met: storageUrl !== null },
    { label: 'Security key registered in this browser', met: credential !== null },
    {
      label:
        result.state === 'failed'
          ? `Your key is a key holder on the on-chain list (the list could not be read: ${result.message})`
          : 'Your key is a key holder on the on-chain list',
      met: derivedKey !== null,
    },
  ];
  const context = useMemo((): ReleaseContext | null => {
    if (!tee || !registry || !examId || !storageUrl || !credential || !derivedKey) return null;
    const reader = registry;
    const id: Hex = examId;
    return {
      examId: id,
      credentialId: fromHex(credential.credentialId),
      passkeyPublicKey: credential.passkeyPublicKey,
      derivedPublicKey: derivedKey,
      keys: browserKeys(),
      tee,
      checkAttestation: attestationChecker({ registry: reader, examId: id }),
      readOnChainListHash: async () => {
        const list = await reader.getApprovedList(id);
        if (!list) throw new Error('No approved list has been posted on-chain.');
        return list.listHash;
      },
      readBuild: async () => {
        const build = await reader.getBuild(id);
        if (!build) throw new Error('No paper has been committed on-chain yet.');
        return build;
      },
      fetchFile: storageFetcher(storageUrl, id),
    };
  }, [examId, credential, derivedKey]);
  return <ReleaseScreen prerequisites={prerequisites} context={context} />;
}
