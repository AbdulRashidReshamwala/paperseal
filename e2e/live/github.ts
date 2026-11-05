import type { Hex } from '@paperseal/protocol';

import { retryTransient } from './util';

/*
 * A TEE release read from GitHub by the same rules as apps/web shared/teeReleases.ts, which this
 * mirrors line for line (that file reads `import.meta.env`, so it can't be imported here): a tag
 * `v<major>.<minor>.<patch>`, a release that is neither a draft nor a prerelease, exactly one fenced
 * json block in the notes, and `commit` and `imageDigest` in the exact lowercase forms. As the app
 * does, the commit the notes claim must be what the tag points at.
 */

export interface TeeRelease {
  version: string;
  commit: Hex;
  imageDigest: Hex;
  run: string;
}

const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^0x[0-9a-f]{40}$/;
const digestPattern = /^0x[0-9a-f]{64}$/;
const fence = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseReleaseBody(body: unknown, tagName: unknown): TeeRelease | null {
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

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` } : { Accept: 'application/vnd.github+json' };
}

async function getJson(url: string): Promise<unknown> {
  return retryTransient(async () => {
    const response = await fetch(url, { headers: githubHeaders() });
    if (response.status === 403 || response.status === 429) {
      throw new Error(`GitHub is limiting requests (status ${String(response.status)}); try again later or set GITHUB_TOKEN`);
    }
    if (!response.ok) throw Object.assign(new Error(`GitHub answered ${String(response.status)} for ${url}`), { status: response.status });
    return (await response.json()) as unknown;
  });
}

/** Reads one release by tag, checks it parses, and checks the tag points at the commit the notes claim. */
export async function fetchRelease(repo: string, tag: string): Promise<TeeRelease> {
  if (!repoPattern.test(repo)) throw new Error(`repo must look like owner/name, not "${repo}"`);
  if (!versionPattern.test(tag)) throw new Error(`release tag must be v<major>.<minor>.<patch>, not "${tag}"`);
  const item = await getJson(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (!isRecord(item)) throw new Error('GitHub did not return a release');
  if (item.draft !== false || item.prerelease !== false) throw new Error(`release ${tag} is a draft or a prerelease`);
  const parsed = parseReleaseBody(item.body, item.tag_name);
  if (!parsed) throw new Error(`release ${tag} does not hold exactly one valid json block with version, commit, imageDigest and run`);
  const data = await getJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(tag)}`);
  const sha = isRecord(data) && typeof data.sha === 'string' ? data.sha.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub did not say which commit the tag points at');
  if (sha !== parsed.commit.slice(2)) {
    throw new Error(`release ${tag} claims commit ${parsed.commit} but the tag points at 0x${sha}`);
  }
  return parsed;
}
