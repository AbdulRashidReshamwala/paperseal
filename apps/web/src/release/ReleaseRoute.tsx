import { fromHex, type Hex } from '@paperseal/protocol';
import { useEffect, useMemo, useState } from 'react';

import { attestationChecker } from '../shared/attest';
import { storageUrl } from '../shared/config';
import { holderCredential, listEntryFor } from '../shared/holder';
import { browserKeys } from '../shared/Register';
import { examId, registry } from '../shared/registry';
import { storageFetcher } from '../shared/storage';
import { tee } from '../shared/tee';
import type { ReleaseContext } from './flow';
import { ReleaseScreen, type Prerequisite } from './ReleaseScreen';

/** The release screen for /centre and /keyholder. No context exists until every item is ready. */
export function ReleaseRoute() {
  const credential = useMemo(() => holderCredential(), []);
  // The derived key that names the share file comes from the on-chain list, not from the browser.
  const [derivedKey, setDerivedKey] = useState<Hex | null>(null);
  useEffect(() => {
    if (!registry || !examId || !credential) return;
    let live = true;
    listEntryFor(registry, examId, credential.passkeyPublicKey).then(
      (entry) => {
        if (live && entry && entry.derivedPublicKey.length > 0) {
          setDerivedKey(`0x${Array.from(entry.derivedPublicKey, (b) => b.toString(16).padStart(2, '0')).join('')}`);
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [credential]);

  const prerequisites: Prerequisite[] = [
    { label: 'TEE connected', met: tee !== null },
    { label: 'ExamRegistry and exam ID set', met: registry !== null && examId !== null },
    { label: 'Public storage set', met: storageUrl !== null },
    { label: 'Security key registered in this browser', met: credential !== null },
    { label: 'Your key is a key holder on the on-chain list', met: derivedKey !== null },
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
  }, [credential, derivedKey]);
  return <ReleaseScreen prerequisites={prerequisites} context={context} />;
}
