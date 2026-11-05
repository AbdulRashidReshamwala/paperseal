import { useCallback, useEffect, useState } from 'react';

import { storageUrl } from '../../shared/config';
import { useCurrentExamId } from '../../shared/currentExam';
import { describeError } from '../../shared/Register';
import { registry } from '../../shared/registry';
import { storageFetcher, StorageVerificationError } from '../../shared/storage';
import { downloadPaperFiles, type Downloaded } from './download';
import { chainReaders } from './readers';

/** How long to wait before trying a download that could not reach its files. */
export const DOWNLOAD_RETRY_MS = 30000;

export type Files =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ready'; downloaded: Downloaded }
  /** The files could not be reached. Nothing is wrong with them yet, so it tries again by itself. */
  | { state: 'unavailable'; detail: string }
  /** A file does not match the public record. It stays refused until someone asks to check again. */
  | { state: 'refused'; detail: string };

/** Storage said a file is missing or failed to answer, which says nothing about the file's contents. */
export const isUnavailable = (error: unknown): boolean =>
  !(error instanceof StorageVerificationError) || error.message.startsWith('Storage returned');

/**
 * Fetches and checks the files as soon as a paper is sealed. Nobody has to ask. They are public,
 * hash-checked files held in memory only, so a reload fetches and checks them again.
 */
export function useDownload(buildPosted: boolean): { files: Files; retry: () => void } {
  const examId = useCurrentExamId();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; files: Files } | null>(null);
  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!buildPosted || !registry || !examId || !storageUrl) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readers = chainReaders(registry, examId);
    downloadPaperFiles({
      examId,
      fetchFile: storageFetcher(storageUrl, examId),
      readBuild: readers.readBuild,
      readListEntries: readers.readListEntries,
    }).then(
      (downloaded) => {
        if (live) setResult({ attempt, files: { state: 'ready', downloaded } });
      },
      (error: unknown) => {
        if (!live) return;
        if (isUnavailable(error)) {
          setResult({ attempt, files: { state: 'unavailable', detail: describeError(error) } });
          timer = setTimeout(retry, DOWNLOAD_RETRY_MS);
        } else {
          setResult({ attempt, files: { state: 'refused', detail: describeError(error) } });
        }
      },
    );
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [buildPosted, examId, attempt, retry]);

  const running = buildPosted && registry !== null && examId !== null && storageUrl !== null;
  const files: Files = result?.attempt === attempt ? result.files : { state: running ? 'running' : 'idle' };
  return { files, retry };
}
