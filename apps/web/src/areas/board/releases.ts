import { useEffect, useMemo, useState } from 'react';

import { checkTag, fetchReleases, releasesRepo, TeeReleasesError, type TeeRelease } from '../../shared/teeReleases';

type ReleaseList =
  | { state: 'loading' }
  | { state: 'failed'; error: TeeReleasesError }
  | { state: 'ready'; releases: TeeRelease[] };

export type TagStatus =
  | { state: 'checking' }
  | { state: 'verified' }
  | { state: 'mismatch'; tagCommit: string }
  | { state: 'failed'; error: TeeReleasesError };

type Checked = Exclude<TagStatus, { state: 'checking' }>;

const asReleasesError = (error: unknown): TeeReleasesError =>
  error instanceof TeeReleasesError ? error : new TeeReleasesError('unreachable', 'GitHub could not be reached.');

/**
 * Loads the versions and checks the selected one's tag on GitHub. With nothing chosen, the
 * selection is the newest version whose tag doesn't contradict it: a mismatch moves on to the next
 * one down, and is reported. Only a version whose tag was checked and matched comes back as
 * `verified`, so an unanswered check never selects anything.
 */
export function useReleases(chosen: string) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ attempt: number; list: Exclude<ReleaseList, { state: 'loading' }> } | null>(null);
  const [checked, setChecked] = useState<{ attempt: number; results: Record<string, Checked> }>({ attempt: 0, results: {} });
  const repo = useMemo(() => releasesRepo(), []);

  useEffect(() => {
    let current = true;
    fetchReleases(repo).then(
      (releases) => {
        if (current) setLoaded({ attempt, list: { state: 'ready', releases } });
      },
      (error: unknown) => {
        if (current) setLoaded({ attempt, list: { state: 'failed', error: asReleasesError(error) } });
      },
    );
    return () => {
      current = false;
    };
  }, [repo, attempt]);

  const list: ReleaseList = loaded?.attempt === attempt ? loaded.list : { state: 'loading' };
  const results = checked.attempt === attempt ? checked.results : {};
  const releases = list.state === 'ready' ? list.releases : [];
  const selected =
    (chosen
      ? releases.find((release) => release.version === chosen)
      : releases.find((release) => results[release.version]?.state !== 'mismatch')) ?? null;
  const known = selected ? results[selected.version] : undefined;

  useEffect(() => {
    if (!selected || known) return;
    let current = true;
    const record = (status: Checked) => {
      if (!current) return;
      setChecked((previous) => ({
        attempt,
        results: { ...(previous.attempt === attempt ? previous.results : {}), [selected.version]: status },
      }));
    };
    checkTag(repo, selected).then(
      (result) => {
        record(result.kind === 'verified' ? { state: 'verified' } : { state: 'mismatch', tagCommit: result.tagCommit });
      },
      (error: unknown) => {
        record({ state: 'failed', error: asReleasesError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [repo, selected, known, attempt]);

  const status: TagStatus | null = selected ? (known ?? { state: 'checking' }) : null;
  return {
    repo,
    list,
    selected,
    status,
    /** Only a release whose commit matches its tag. */
    verified: selected && status?.state === 'verified' ? selected : null,
    /** Versions whose tag points somewhere else, with where it points. */
    mismatched: releases.flatMap((release) => {
      const result = results[release.version];
      return result?.state === 'mismatch' ? [{ release, tagCommit: result.tagCommit }] : [];
    }),
    retry: () => {
      setAttempt((n) => n + 1);
    },
  };
}

export type Releases = ReturnType<typeof useReleases>;
