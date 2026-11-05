import { OnChainBytesError, type ExamRegistry } from '@paperseal/chain';
import { decodeApprovedList, fromHex, toHex, type Hex } from '@paperseal/protocol';
import { Badge, Connected, Row, Rows, Screen } from '@paperseal/ui';
import type { ReleaseLogResponse } from '@paperseal/tee-client';
import { useMemo } from 'react';

import { publishedTokenChecker } from '../../shared/attest';
import { storageUrl } from '../../shared/config';
import { useCurrentExamId } from '../../shared/currentExam';
import { registry } from '../../shared/registry';
import { storageFetcher } from '../../shared/storage';
import { tee } from '../../shared/tee';
import { verifyReleaseLog, type LogVerdict } from './logCheck';

const pass = (ok: boolean) => <Badge tone={ok ? 'ok' : 'bad'}>{ok ? 'Pass' : 'Fail'}</Badge>;

/**
 * Names for passkeys, from the on-chain approved list. `getApprovedListEntries` has already
 * hashed the bytes against the chain's `listHash`, so these names are not the TEE's say-so.
 * Without them an entry is shown by its key, and `problem` says why.
 */
async function readOwners(reader: ExamRegistry, exam: Hex): Promise<{ owners: Map<string, string>; problem: string | null }> {
  const owners = new Map<string, string>();
  try {
    const encoded = await reader.getApprovedListEntries(exam);
    if (!encoded) return { owners, problem: 'No approved list is posted on-chain, so entries are shown by passkey.' };
    for (const entry of decodeApprovedList(fromHex(encoded))) owners.set(toHex(entry.passkeyPublicKey), entry.owner);
    return { owners, problem: null };
  } catch (error) {
    const reason =
      error instanceof OnChainBytesError
        ? `The on-chain list's bytes could not be trusted: ${error.message}`
        : `The on-chain list could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return { owners: new Map(), problem: `${reason} Entries are shown by passkey.` };
  }
}

export interface LogViewProps {
  log: ReleaseLogResponse;
  /** Owner names by lowercase passkey, from the hash-checked on-chain list. */
  owners: ReadonlyMap<string, string>;
  problem: string | null;
  verdict: LogVerdict;
}

/** The verdict, then the entries, which are muted unless the whole verdict passes. */
export function LogView({ log, owners, problem, verdict }: LogViewProps) {
  return (
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
      {problem ? <Badge tone="warn">{problem}</Badge> : null}
      {verdict.pass ? null : (
        <Badge tone="bad">The log did not verify, so the entries below are not shown as fact.</Badge>
      )}
      {log.entries.length === 0 ? (
        'No releases yet.'
      ) : (
        <Rows>
          {log.entries.map((entry) => (
            <Row
              key={entry.passkeyPublicKey}
              label={owners.get(entry.passkeyPublicKey.toLowerCase()) ?? entry.passkeyPublicKey}
              muted={!verdict.pass}
            >
              round {entry.round}
            </Row>
          ))}
        </Rows>
      )}
    </>
  );
}

/** The signed release log, checked, with each entry named by the on-chain list's owner for its passkey. */
export function UnlockLog() {
  const exam = useCurrentExamId();
  const load = useMemo(() => {
    const client = tee;
    const reader = registry;
    if (!client || !reader || !exam) return null;
    return async () => {
      const [log, named] = await Promise.all([client.releaseLog(), readOwners(reader, exam)]);
      let token: string | null = null;
      if (storageUrl) {
        try {
          token = new TextDecoder().decode(await storageFetcher(storageUrl, exam)('release-token.jwt'));
        } catch {
          token = null;
        }
      }
      const verdict = await verifyReleaseLog(log, { examId: exam }, token, publishedTokenChecker({ registry: reader, examId: exam }));
      return { log, ...named, verdict };
    };
  }, [exam]);

  return (
    <Screen title="Unlock log" lede="The TEE's signed release log, checked against the attested key that signed it.">
      <Connected
        title="Release log"
        notConnected="Set VITE_TEE_URL, VITE_RPC_URL and VITE_REGISTRY_ADDRESS, and select an exam, to read the release log."
        load={load}
      >
        {(loaded) => <LogView {...loaded} />}
      </Connected>
    </Screen>
  );
}
