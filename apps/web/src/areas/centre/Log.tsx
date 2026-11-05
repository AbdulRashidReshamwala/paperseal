import { decodeApprovedList, fromHex, toHex } from '@paperseal/protocol';
import { Badge, Connected, Row, Rows, Screen } from '@paperseal/ui';
import { useMemo } from 'react';

import { publishedTokenChecker } from '../../shared/attest';
import { storageUrl } from '../../shared/config';
import { examId, registry } from '../../shared/registry';
import { storageFetcher } from '../../shared/storage';
import { tee } from '../../shared/tee';
import { verifyReleaseLog } from './logCheck';

const pass = (ok: boolean) => <Badge tone={ok ? 'ok' : 'bad'}>{ok ? 'Pass' : 'Fail'}</Badge>;

/** The signed release log, checked, with each entry named by the approved list's owner for its passkey. */
export function UnlockLog() {
  const load = useMemo(() => {
    const client = tee;
    const reader = registry;
    const exam = examId;
    if (!client || !reader || !exam) return null;
    return async () => {
      const [log, status] = await Promise.all([client.releaseLog(), client.status()]);
      const owners = new Map<string, string>();
      if (status.approvedList) {
        try {
          for (const entry of decodeApprovedList(fromHex(status.approvedList.entries))) {
            owners.set(toHex(entry.passkeyPublicKey), entry.owner);
          }
        } catch {
          // An unreadable list leaves entries unnamed. The key is still shown.
        }
      }
      let token: string | null = null;
      if (storageUrl) {
        try {
          token = new TextDecoder().decode(await storageFetcher(storageUrl, exam)('release-token.jwt'));
        } catch {
          token = null;
        }
      }
      const verdict = await verifyReleaseLog(log, { examId: exam }, token, publishedTokenChecker({ registry: reader, examId: exam }));
      return { log, owners, verdict };
    };
  }, []);

  return (
    <Screen title="Unlock log" lede="The TEE's signed release log, checked against the attested key that signed it.">
      <Connected
        title="Release log"
        notConnected="Set VITE_TEE_URL, VITE_RPC_URL, VITE_REGISTRY_ADDRESS and VITE_EXAM_ID to read the release log."
        load={load}
      >
        {({ log, owners, verdict }) => (
          <>
            <Rows>
              <Row label="Log verification">{pass(verdict.pass)}</Row>
              <Row label="Entries hash">{pass(verdict.entriesHash)}</Row>
              <Row label="TEE signature under the log's key">{pass(verdict.signature)}</Row>
              <Row label="release-token.jwt attests that key">
                {pass(verdict.token.passed)}
                {verdict.token.failures.length > 0 ? ` ${verdict.token.failures.join('; ')}` : ''}
              </Row>
              <Row label="Log is for this exam">{pass(verdict.exam)}</Row>
            </Rows>
            {log.entries.length === 0 ? (
              'No releases yet.'
            ) : (
              <Rows>
                {log.entries.map((entry) => (
                  <Row key={entry.passkeyPublicKey} label={owners.get(entry.passkeyPublicKey.toLowerCase()) ?? entry.passkeyPublicKey}>
                    round {entry.round}
                  </Row>
                ))}
              </Rows>
            )}
          </>
        )}
      </Connected>
    </Screen>
  );
}
