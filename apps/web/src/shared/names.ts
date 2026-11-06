import { createEnsLookup, readDirectory, readPartyRecords, type Directory, type EnsLookup, type PartyRecords } from '@paperseal/chain';
import { useMemo } from 'react';

import { appEnv } from './runtime-config';
import { usePoll } from './usePoll';

/*
 * The directory of permanent party names, from "Party Names" in spec/api.md. It is read through this
 * app's own RPC, on chain only. The list is a menu: each name counts only by its own records.
 */

const env = appEnv();

export const DIRECTORY_POLL_MS = 30_000;

/** The parent name whose `ens.records.directory` record lists the parties. */
export const directoryName: string = env.VITE_DIRECTORY_NAME?.trim() || 'paperseal-demo.eth';

/** How this app reads ENS. Null until VITE_RPC_URL is set. */
export const nameLookup: EnsLookup | null = env.VITE_RPC_URL ? createEnsLookup({ rpcUrl: env.VITE_RPC_URL }) : null;

export interface DirectoryRead {
  directory: Directory;
  /** Each listed name's records, in the directory's order. */
  records: PartyRecords[];
}

/** Reads the directory, then each listed name. One unread name never fails the others. */
export async function readDirectoryRecords(lookup: EnsLookup, name: string = directoryName): Promise<DirectoryRead> {
  const directory = await readDirectory(name, { lookup });
  const names = directory.state === 'found' ? directory.names : [];
  return { directory, records: await Promise.all(names.map((party) => readPartyRecords(party, { lookup }))) };
}

/** The directory, read now and every `DIRECTORY_POLL_MS`. Null until the first read comes back. */
export function useDirectory(lookup: EnsLookup | null = nameLookup): { read: DirectoryRead | null; retry: () => void } {
  const load = useMemo(() => (lookup ? () => readDirectoryRecords(lookup) : null), [lookup]);
  const { value, refresh } = usePoll(load, DIRECTORY_POLL_MS);
  return { read: value, retry: refresh };
}
