/**
 * The Swarm backup of an exam's public files, read as spec/arkiv.md "Backups", "Reading" says. It
 * is only a second copy: a file comes from it when the bucket can't give it, or gives one that
 * fails its hash, and only once it passes the same checks a bucket file would.
 */
import type { ArkivReader } from '@paperseal/arkiv';
import { parseManifest, storageManifestHash, storageNames, toHex, type Hex, type Manifest } from '@paperseal/protocol';
import type { SwarmClient } from '@paperseal/swarm';

import type { Build } from './attest';
import { sameHex } from './checks';
import { releaseTokenName, type StorageReader } from './storage';

/** The one Arkiv read a backup needs. `createArkivReader` from `@paperseal/arkiv` gives it. */
export type BackupRowSource = Pick<ArkivReader, 'backupRows'>;
type BackupRow = Awaited<ReturnType<ArkivReader['backupRows']>>[number];

/** Swarm content never changes under a reference, so what was read once is kept for the visit. */
export interface BackupCache {
  files: Map<string, Promise<Uint8Array | null>>;
}

export const createBackupCache = (): BackupCache => ({ files: new Map() });

/** Where backups are found and read. Null anywhere it is used means backups are off. */
export interface BackupSource {
  rows: BackupRowSource;
  swarm: Pick<SwarmClient, 'download'>;
  /** The viewer's own Swarm API, for links. */
  swarmApiUrl: string;
  writers: readonly Hex[];
  examId: Hex;
  registry: Hex;
  cache: BackupCache;
}

/** Why the bucket's own copy was not used. */
export type BucketGap = 'missing' | 'unreadable' | 'mismatch';

/** A file that came from the backup, and where. */
export interface BackupFile {
  name: string;
  swarmRef: string;
  entityKey: Hex;
  phase: 'build' | 'unlock';
  /** `<Swarm API>/bzz/<reference>/<name>`. */
  url: string;
  /** Whether its hash is in the manifest the Build covers. Unlock files are checked by the page instead. */
  inManifest: boolean;
  bucket: BucketGap;
}

/**
 * A file the bucket could not give, and the backup did not give either. Never a failure. `not-read`
 * means Arkiv or Swarm did not answer, or every backup copy of an unlock file failed the page's
 * check; `none` means no usable backup holds the file.
 */
export interface BackupMiss {
  name: string;
  kind: 'not-read' | 'none';
  reason: string;
}

/** A backup copy of an unlock file that failed the page's check, so it was not used. Never a failure. */
export interface BackupRejection {
  name: string;
  swarmRef: string;
  entityKey: Hex;
  reason: string;
}

export interface BackupUse {
  served: BackupFile[];
  missed: BackupMiss[];
  /** Collections whose manifest did not match the Build, and files that did not match their manifest. */
  ignored: { collections: number; files: number };
  /** Backup copies of unlock files that failed the page's check, in the order they were tried. */
  rejected: BackupRejection[];
}

/** What the page's own check made of one copy of an unlock file. `reason` says why it did not pass. */
export interface Judged<T> {
  pass: boolean;
  value: T;
  reason?: string;
}

export type Judge<T> = (bytes: Uint8Array) => Promise<Judged<T>>;

export interface CheckedOptions {
  /** False when the file is only tried to check another one, so nothing about it is reported. */
  record?: boolean;
}

export interface BackedStorage extends StorageReader {
  /** What the backup was used for so far. */
  use: () => BackupUse;
  /**
   * An unlock file, which no manifest lists (spec/arkiv.md "Backups", "Reading", rule 3). The bucket's
   * copy is judged and its verdict stands, pass or fail. Without one, each backup copy is judged in
   * turn, newest row first, and the first that passes is used. A copy that fails is only recorded
   * as rejected. Null when no copy passes, which is "not read" and never a failure.
   */
  checked: <T>(name: string, judge: Judge<T>, options?: CheckedOptions) => Promise<T | null>;
}

/**
 * Files written at unlock. No manifest lists them; the signed release log lists the `key-priv`
 * files' hashes (spec/api.md "Storage"). A copy from a backup is used only once it passes the
 * page's own checks, through `checked`.
 */
export const isUnlockFile = (name: string) =>
  name === storageNames.releaseLog || name === releaseTokenName || name === storageNames.keyPriv || name.startsWith('key-priv/');

async function sha256(bytes: Uint8Array): Promise<Hex> {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

interface Collection {
  row: BackupRow;
  manifest: Manifest;
  manifestBytes: Uint8Array;
}

/**
 * Wraps the bucket for one read of the record. With no backup it is the bucket itself, and with no
 * Build to check a collection against it reads no backup. Otherwise the bucket is still read first,
 * and Swarm only when the bucket can't give a file or gives one whose hash is wrong.
 */
export function withBackup(bucket: StorageReader, backup: BackupSource | null, build: Build | null): BackedStorage {
  const served = new Map<string, BackupFile>();
  const missed = new Map<string, Omit<BackupMiss, 'name'>>();
  const ignoredRefs = new Set<string>();
  const ignoredFiles = new Set<string>();
  const rejected = new Map<string, BackupRejection>();
  const use = (): BackupUse => ({
    served: [...served.values()],
    missed: [...missed].map(([name, miss]) => ({ name, ...miss })),
    ignored: { collections: ignoredRefs.size, files: ignoredFiles.size },
    rejected: [...rejected.values()],
  });
  if (!backup || backup.writers.length === 0) return { ...bucket, use, checked: (name, judge) => bucketChecked(bucket, name, judge) };

  // Each bucket file is read once per read of the record, even when its hash is checked here too.
  const bucketReads = new Map<string, Promise<Uint8Array | null>>();
  const fromBucket = (name: string) => {
    let read = bucketReads.get(name);
    if (!read) {
      read = bucket.get(name);
      bucketReads.set(name, read);
    }
    return read;
  };
  const { swarm, cache, swarmApiUrl } = backup;
  const api = swarmApiUrl.replace(/\/+$/, '');

  const download = (reference: string, path: string): Promise<Uint8Array | null> => {
    const key = `${reference}/${path}`;
    const known = cache.files.get(key);
    if (known) return known;
    const read = swarm.download(reference, path);
    cache.files.set(key, read);
    // Only bytes are kept. A file not found yet, or a node that did not answer, is asked again later.
    read.then(
      (bytes) => {
        if (bytes === null) cache.files.delete(key);
      },
      () => cache.files.delete(key),
    );
    return read;
  };

  // Rows are read once per read of the record, and only if something needs them.
  let rows: Promise<BackupRow[]> | null = null;
  const backupRows = () => (rows ??= backup.rows.backupRows(backup.examId, backup.writers, { registry: backup.registry }));

  /** The collection's manifest, only if it is the one the Build records. Null if it is not usable. */
  async function collection(row: BackupRow, onChain: Hex): Promise<Collection | null> {
    // Rule 2: the row's claim, and then the bytes, must both match the Build.
    if (!sameHex(row.manifestHash, onChain)) {
      ignoredRefs.add(row.swarmRef);
      return null;
    }
    const bytes = await download(row.swarmRef, storageNames.manifest);
    if (!bytes) return null;
    if (!sameHex(toHex(storageManifestHash(bytes)), onChain)) {
      ignoredRefs.add(row.swarmRef);
      return null;
    }
    try {
      return { row, manifest: parseManifest(bytes), manifestBytes: bytes };
    } catch {
      ignoredRefs.add(row.swarmRef);
      return null;
    }
  }

  type Missed = Omit<BackupMiss, 'name'>;
  const none = (reason: string): Missed => ({ kind: 'none', reason });
  const notRead = (reason: string): Missed => ({ kind: 'not-read', reason });

  /** A file the manifest lists, or the manifest itself, needs no more check than its hash here. */
  const hashed: Judge<Uint8Array> = (bytes) => Promise.resolve({ pass: true, value: bytes });

  /**
   * The file from the first backup that has it and passes, or why none did. A file the manifest
   * lists must match its hash there. An unlock file must pass `judge`, the page's own check. With
   * `record` false the file is only read to check another one, so nothing is reported about it.
   */
  async function fromBackup<T>(name: string, gap: BucketGap, judge: Judge<T>, record = true): Promise<{ value: T } | Missed> {
    if (!build) return none('A backup is only used once the paper is recorded on the public record');
    const onChain = build.storageManifestHash;
    let found: BackupRow[];
    try {
      found = await backupRows();
    } catch (error) {
      return notRead(`The copy on Arkiv could not be read: ${messageOf(error)}`);
    }
    const unlockFile = isUnlockFile(name);
    const candidates = found.filter((row) => !unlockFile || row.phase === 'unlock');
    if (candidates.length === 0) return none('No backup on Arkiv holds this file');
    let unreadable: string | null = null;
    const failed: BackupRejection[] = [];
    const settle = () => {
      if (record) for (const rejection of failed) rejected.set(`${rejection.swarmRef}/${name}`, rejection);
    };
    for (const row of candidates) {
      try {
        const usable = await collection(row, onChain);
        if (!usable) continue;
        let bytes: Uint8Array | null;
        let inManifest = true;
        if (name === storageNames.manifest) {
          bytes = usable.manifestBytes;
        } else {
          const entry = usable.manifest.files.find((file) => file.name === name);
          // Rule 3: a file the manifest lists must match it. Unlock files must pass the page's check.
          if (!entry && !unlockFile) continue;
          inManifest = entry !== undefined;
          bytes = await download(row.swarmRef, name);
          if (!bytes) continue;
          if (entry && !sameHex(await sha256(bytes), entry.sha256)) {
            ignoredFiles.add(`${row.swarmRef}/${name}`);
            continue;
          }
        }
        const judged = await judge(bytes);
        if (!judged.pass) {
          // Ignored as a bad bucket file would be, and never a failure of the exam.
          failed.push({ name, swarmRef: row.swarmRef, entityKey: row.entityKey, reason: judged.reason ?? 'It did not pass the check.' });
          continue;
        }
        settle();
        if (!record) return { value: judged.value };
        served.set(name, {
          name,
          swarmRef: row.swarmRef,
          entityKey: row.entityKey,
          phase: row.phase,
          url: `${api}/bzz/${row.swarmRef}/${name}`,
          inManifest,
          bucket: gap,
        });
        missed.delete(name);
        return { value: judged.value };
      } catch (error) {
        unreadable = messageOf(error);
      }
    }
    settle();
    if (failed.length > 0) {
      return notRead(`${plural(failed.length, 'copy', 'copies')} in the backup did not pass the checks in this step, so none was used.`);
    }
    return unreadable ? notRead(`The backup could not be read: ${unreadable}`) : none('No backup that passed its check holds this file');
  }

  /** The bucket's manifest, if it is the one the Build records, to check its other files against. */
  let bucketManifest: Promise<Manifest | null> | null = null;
  const trustedManifest = () =>
    (bucketManifest ??= (async () => {
      if (!build) return null;
      let gap: BucketGap = 'missing';
      const bytes = await fromBucket(storageNames.manifest).catch(() => {
        gap = 'unreadable';
        return null;
      });
      if (bytes && sameHex(toHex(storageManifestHash(bytes)), build.storageManifestHash)) {
        try {
          return parseManifest(bytes);
        } catch {
          return null;
        }
      }
      // The bucket's own manifest is no good, so the backup's is used, if one passes.
      const backed = await fromBackup(storageNames.manifest, bytes ? 'mismatch' : gap, hashed, false);
      return 'value' in backed ? parseManifest(backed.value) : null;
    })());

  /** Whether the bucket's copy fails the hash the record gives it. Unlock files are left to the page. */
  async function failsHash(name: string, bytes: Uint8Array): Promise<boolean> {
    if (!build) return false;
    if (name === storageNames.manifest) return !sameHex(toHex(storageManifestHash(bytes)), build.storageManifestHash);
    if (isUnlockFile(name)) return false;
    const entry = (await trustedManifest())?.files.find((file) => file.name === name);
    return entry !== undefined && !sameHex(await sha256(bytes), entry.sha256);
  }

  return {
    url: bucket.url,
    use,
    get: async (name) => {
      // An unlock file from a backup is only ever used once it passes the page's check, through `checked`.
      if (isUnlockFile(name)) return fromBucket(name);
      let bytes: Uint8Array | null;
      try {
        bytes = await fromBucket(name);
      } catch (error) {
        const backed = await fromBackup(name, 'unreadable', hashed);
        if ('value' in backed) return backed.value;
        missed.set(name, backed);
        throw error;
      }
      if (bytes && !(await failsHash(name, bytes))) return bytes;
      const backed = await fromBackup(name, bytes ? 'mismatch' : 'missing', hashed);
      if ('value' in backed) return backed.value;
      missed.set(name, backed);
      // The bucket's copy stands, so its own check shows what is wrong with it.
      return bytes;
    },
    checked: async <T>(name: string, judge: Judge<T>, options: CheckedOptions = {}) => {
      const record = options.record ?? true;
      let bytes: Uint8Array | null;
      let failure: { error: unknown } | null = null;
      try {
        bytes = await fromBucket(name);
      } catch (error) {
        bytes = null;
        failure = { error };
      }
      // Rule 3: only the bucket's own copy can fail a check, so its verdict stands, pass or fail.
      if (bytes) return (await judge(bytes)).value;
      const backed = await fromBackup(name, failure ? 'unreadable' : 'missing', judge, record);
      if ('value' in backed) return backed.value;
      if (record) missed.set(name, backed);
      if (failure) throw failure.error;
      return null;
    },
  };
}

/** `checked` on the bucket alone: its copy is judged and stands, and with none there is nothing. */
async function bucketChecked<T>(bucket: StorageReader, name: string, judge: Judge<T>): Promise<T | null> {
  const bytes = await bucket.get(name);
  return bytes ? (await judge(bytes)).value : null;
}

const isBacked = (storage: StorageReader): storage is BackedStorage => typeof (storage as Partial<BackedStorage>).checked === 'function';

/** An unlock file, judged as `BackedStorage.checked` says. A plain bucket has no backup to try. */
export const readChecked = <T>(storage: StorageReader, name: string, judge: Judge<T>, options?: CheckedOptions): Promise<T | null> =>
  isBacked(storage) ? storage.checked(name, judge, options) : bucketChecked(storage, name, judge);
