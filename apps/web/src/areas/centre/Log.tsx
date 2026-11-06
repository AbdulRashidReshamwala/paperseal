import { OnChainBytesError, type ExamRegistry } from '@paperseal/chain';
import { decodeApprovedList, fromHex, roundTimeSeconds, toHex, type Hex } from '@paperseal/protocol';
import type { ReleaseLogResponse } from '@paperseal/tee-client';
import { Check, Row, Rows } from '@paperseal/ui';
import { useMemo } from 'react';

import { publishedTokenChecker } from '../../shared/attest';
import { storageUrl } from '../../shared/config';
import { useCurrentExamId } from '../../shared/currentExam';
import { registry } from '../../shared/registry';
import { storageFetcher } from '../../shared/storage';
import { tee } from '../../shared/tee';
import { usePoll } from '../../shared/usePoll';
import { verifyReleaseLog, type LogVerdict } from './logCheck';

/** How long to wait before reading a log that could not be read. */
const LOG_RETRY_MS = 15000;

/** When a key holder released, as a clock time. The log holds a round, which has a fixed time. */
const releasedAt = (round: string): string => {
  const at = new Date(roundTimeSeconds(Number(round)) * 1000);
  return `Released ${at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })}`;
};

const result = (ok: boolean) => <Check status={ok ? 'pass' : 'fail'} />;

/**
 * Names for passkeys, from the on-chain approved list. `getApprovedListEntries` has already
 * hashed the bytes against the chain's `listHash`, so these names are not the TEE's say-so.
 * Without them an entry is shown by its key, and `problem` says why.
 */
async function readOwners(reader: ExamRegistry, exam: Hex): Promise<{ owners: Map<string, string>; problem: string | null }> {
  const owners = new Map<string, string>();
  try {
    const encoded = await reader.getApprovedListEntries(exam);
    if (!encoded) return { owners, problem: 'The list of people for this exam could not be found, so entries show a security key code instead of a name.' };
    for (const entry of decodeApprovedList(fromHex(encoded))) owners.set(toHex(entry.passkeyPublicKey), entry.owner);
    return { owners, problem: null };
  } catch (error) {
    const reason =
      error instanceof OnChainBytesError
        ? `The list of people could not be trusted: ${error.message}`
        : `The list of people could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return { owners: new Map(), problem: `${reason} Entries show a security key code instead of a name.` };
  }
}

export interface LogViewProps {
  log: ReleaseLogResponse;
  /** Owner names by lowercase passkey, from the hash-checked on-chain list. */
  owners: ReadonlyMap<string, string>;
  problem: string | null;
  verdict: LogVerdict;
}

/** Who released, then each check, with entries muted unless the whole verdict passes. */
export function LogView({ log, owners, problem, verdict }: LogViewProps) {
  return (
    <>
      {problem ? <p className="centre-log-note">{problem}</p> : null}
      {verdict.pass ? null : <p className="centre-log-note">This log could not be confirmed, so do not rely on the entries below.</p>}
      {log.entries.length === 0 ? (
        <p className="centre-log-note">No releases yet.</p>
      ) : (
        <Rows>
          {log.entries.map((entry) => (
            <Row
              key={entry.passkeyPublicKey}
              label={owners.get(entry.passkeyPublicKey.toLowerCase()) ?? entry.passkeyPublicKey}
              muted={!verdict.pass}
            >
              {releasedAt(entry.round)}
            </Row>
          ))}
        </Rows>
      )}
      <Rows>
        <Row label="The list of releases is complete">{result(verdict.entriesHash)}</Row>
        <Row label="Signed by Paper Seal">{result(verdict.signature)}</Row>
        <Row label="Paper Seal is the approved version">
          {result(verdict.token.passed)}
          {verdict.token.failures.length > 0 ? ` ${verdict.token.failures.join('; ')}` : ''}
        </Row>
        <Row label="The log is for this exam">{result(verdict.exam)}</Row>
      </Rows>
    </>
  );
}

const logRead = (loaded: { verdict: LogVerdict }) => loaded.verdict.pass;

/** The sealed machine's signed release log, folded away, with one clear result on the fold. */
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
  const { value: loaded, error, settled } = usePoll(load, LOG_RETRY_MS, logRead);

  return (
    <details className="centre-log">
      <summary>
        Unlock log
        {loaded ? <Check status={loaded.verdict.pass ? 'pass' : 'fail'} /> : <Check status={settled ? 'not-checked' : 'pending'} />}
      </summary>
      {loaded ? <LogView {...loaded} /> : null}
      {!loaded && error ? <p className="centre-log-note">The log can't be read right now. This page keeps trying.</p> : null}
      {!load ? <p className="centre-log-note">This page can't reach Paper Seal, so the log can't be read.</p> : null}
    </details>
  );
}
