import type { Hex } from '@paperseal/protocol';

import { appEnv } from './runtime-config';

/*
 * Versions of the Paper Seal TEE code, read from GitHub releases. See "TEE
 * Releases" in spec/api.md. This only fills in the board's form: the values
 * written to ExamRegistry are what count, and anyone can rebuild them.
 */

export const defaultReleasesRepo = 'AbdulRashidReshamwala/paperseal';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The repository releases are read from: VITE_RELEASES_REPO, or the default. */
export function releasesRepo(
  env: Record<string, string | undefined> = appEnv(),
): string {
  const given = env.VITE_RELEASES_REPO?.trim();
  if (!given) return defaultReleasesRepo;
  if (!repoPattern.test(given)) throw new Error(`VITE_RELEASES_REPO must look like owner/name, not "${given}".`);
  return given;
}

export interface TeeRelease {
  /** The tag, `v<major>.<minor>.<patch>`. */
  version: string;
  /** `0x` and 40 lowercase hex: the `commitHash` in `createExam`. */
  commit: Hex;
  /** `0x` and 64 lowercase hex: the `imageDigest` in `createExam`. */
  imageDigest: Hex;
  /** The workflow run that built it. */
  run: string;
  publishedAt: number;
}

export type TeeReleasesFailure = 'unreachable' | 'rate_limited';

/** GitHub could not be read. Publishing stays blocked; there is no manual fallback. */
export class TeeReleasesError extends Error {
  readonly kind: TeeReleasesFailure;
  constructor(kind: TeeReleasesFailure, message: string) {
    super(message);
    this.name = 'TeeReleasesError';
    this.kind = kind;
  }
}

const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^0x[0-9a-f]{40}$/;
const digestPattern = /^0x[0-9a-f]{64}$/;
const fence = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * True only for a GitHub Actions run of `repo`: `https://github.com/<owner>/<name>/actions/runs/<id>`,
 * with an optional `/attempts/<n>`. The release notes are text anyone with write access can edit, so
 * the board links nothing else, whatever scheme or host they name.
 */
export function isRunUrlOf(run: string, repo: string): boolean {
  if (!repoPattern.test(repo)) return false;
  let url: URL;
  try {
    url = new URL(run);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  if (url.search !== '' || url.hash !== '') return false;
  const [owner, name] = repo.toLowerCase().split('/');
  return new RegExp(`^/${escapeRegExp(owner ?? '')}/${escapeRegExp(name ?? '')}/actions/runs/[0-9]+(/attempts/[0-9]+)?$`).test(
    url.pathname.toLowerCase(),
  );
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The release metadata from a release's notes, or null if it is absent or does not validate. */
export function parseReleaseBody(body: unknown, tagName: unknown): Omit<TeeRelease, 'publishedAt'> | null {
  if (typeof body !== 'string' || typeof tagName !== 'string' || !versionPattern.test(tagName)) return null;
  const blocks = [...body.matchAll(fence)];
  if (blocks.length !== 1) return null;
  let data: unknown;
  try {
    data = JSON.parse(blocks[0]?.[1] ?? '');
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const { version, commit, imageDigest, run } = data;
  if (typeof version !== 'string' || version !== tagName || !versionPattern.test(version)) return null;
  if (typeof commit !== 'string' || !commitPattern.test(commit)) return null;
  if (typeof imageDigest !== 'string' || !digestPattern.test(imageDigest)) return null;
  if (typeof run !== 'string' || !httpsUrl(run)) return null;
  return { version, commit: commit as Hex, imageDigest: imageDigest as Hex, run };
}

/** Valid, published releases from a GitHub releases listing, newest first. */
export function parseReleases(listing: unknown): TeeRelease[] {
  if (!Array.isArray(listing)) return [];
  const found: TeeRelease[] = [];
  for (const item of listing) {
    if (!isRecord(item) || item.draft !== false || item.prerelease !== false) continue;
    const parsed = parseReleaseBody(item.body, item.tag_name);
    if (!parsed) continue;
    const when = Date.parse(String(item.published_at ?? item.created_at ?? ''));
    found.push({ ...parsed, publishedAt: Number.isNaN(when) ? 0 : when });
  }
  return found.sort((a, b) => b.publishedAt - a.publishedAt);
}

type Fetch = typeof fetch;

async function getJson(fetchFn: Fetch, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Accept: 'application/vnd.github+json' } });
  } catch {
    throw new TeeReleasesError('unreachable', 'GitHub could not be reached.');
  }
  if (response.status === 403 || response.status === 429) {
    throw new TeeReleasesError('rate_limited', 'GitHub is limiting requests from this browser.');
  }
  if (!response.ok) throw new TeeReleasesError('unreachable', `GitHub answered with status ${String(response.status)}.`);
  try {
    return await response.json();
  } catch {
    throw new TeeReleasesError('unreachable', 'GitHub sent a reply that could not be read.');
  }
}

export async function fetchReleases(repo: string, fetchFn: Fetch = (...args) => fetch(...args)): Promise<TeeRelease[]> {
  return parseReleases(await getJson(fetchFn, `https://api.github.com/repos/${repo}/releases?per_page=100`));
}

export type TagCheck = { kind: 'verified' } | { kind: 'mismatch'; tagCommit: string };

/** Compares what the tag points at on GitHub with the commit the release notes claim. */
export async function checkTag(
  repo: string,
  release: TeeRelease,
  fetchFn: Fetch = (...args) => fetch(...args),
): Promise<TagCheck> {
  const data = await getJson(fetchFn, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(release.version)}`);
  const sha = isRecord(data) && typeof data.sha === 'string' ? data.sha.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new TeeReleasesError('unreachable', 'GitHub did not say which commit the tag points at.');
  return sha === release.commit.slice(2) ? { kind: 'verified' } : { kind: 'mismatch', tagCommit: sha };
}
