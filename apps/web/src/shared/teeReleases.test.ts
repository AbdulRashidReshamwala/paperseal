import { describe, expect, it, vi } from 'vitest';

import { checkTag, fetchReleases, parseReleaseBody, parseReleases, releasesRepo, TeeReleasesError } from './teeReleases';

const commit = `0x${'a'.repeat(40)}`;
const digest = `0x${'b'.repeat(64)}`;
const run = 'https://github.com/example/paperseal/actions/runs/1';

const notes = (patch: Record<string, unknown> = {}, tag = 'v1.0.0') =>
  `Release notes\n\n\`\`\`json\n${JSON.stringify({ version: tag, commit, imageDigest: digest, run, ...patch }, null, 2)}\n\`\`\`\n`;

const release = (tag: string, patch: Record<string, unknown> = {}, body = notes({}, tag)) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: '2027-01-01T00:00:00Z',
  body,
  ...patch,
});

const reply = (data: unknown, status = 200) => (..._args: unknown[]) => Promise.resolve(new Response(JSON.stringify(data), { status }));

describe('parseReleaseBody', () => {
  it('reads the fenced json block', () => {
    expect(parseReleaseBody(notes(), 'v1.0.0')).toEqual({ version: 'v1.0.0', commit, imageDigest: digest, run });
  });

  it.each([
    ['uppercase commit', { commit: `0x${'A'.repeat(40)}` }],
    ['commit without 0x', { commit: 'a'.repeat(40) }],
    ['short commit', { commit: `0x${'a'.repeat(39)}` }],
    ['sha256: digest', { imageDigest: `sha256:${'b'.repeat(64)}` }],
    ['uppercase digest', { imageDigest: `0x${'B'.repeat(64)}` }],
    ['short digest', { imageDigest: `0x${'b'.repeat(63)}` }],
    ['version that is not the tag', { version: 'v1.0.1' }],
    ['missing run', { run: undefined }],
    ['run that is not https', { run: 'javascript:alert(1)' }],
    ['non-string commit', { commit: 5 }],
  ])('rejects %s', (_label, patch) => {
    expect(parseReleaseBody(notes(patch), 'v1.0.0')).toBeNull();
  });

  it.each(['1.0.0', 'v1.0', 'v1.0.0-rc1', 'v01.0.0', 'latest'])('rejects the tag %s', (tag) => {
    expect(parseReleaseBody(notes({ version: tag }, tag), tag)).toBeNull();
  });

  it('rejects bodies that are not exactly one valid json block', () => {
    expect(parseReleaseBody('no block here', 'v1.0.0')).toBeNull();
    expect(parseReleaseBody('```json\n{not json}\n```', 'v1.0.0')).toBeNull();
    expect(parseReleaseBody('```json\n[]\n```', 'v1.0.0')).toBeNull();
    expect(parseReleaseBody(notes() + notes(), 'v1.0.0')).toBeNull();
    expect(parseReleaseBody(null, 'v1.0.0')).toBeNull();
  });
});

describe('parseReleases', () => {
  it('ignores drafts, prereleases and anything that does not parse, newest first', () => {
    const list = parseReleases([
      release('v1.0.0', { published_at: '2027-01-01T00:00:00Z' }),
      release('v1.1.0', { published_at: '2027-02-01T00:00:00Z' }),
      release('v1.2.0', { draft: true }),
      release('v1.3.0', { prerelease: true }),
      release('v1.4.0', {}, 'nothing'),
      release('v1.5.0', {}, notes({ commit: 'nope' }, 'v1.5.0')),
      release('v1.6.0', {}, notes({}, 'v1.0.0')),
      'junk',
    ]);
    expect(list.map((r) => r.version)).toEqual(['v1.1.0', 'v1.0.0']);
  });

  it('returns nothing for a reply that is not a list', () => {
    expect(parseReleases({ message: 'Not Found' })).toEqual([]);
  });
});

describe('fetchReleases', () => {
  it('reads the releases of the given repository from the GitHub API', async () => {
    const stub = vi.fn(reply([release('v1.0.0')]));
    const list = await fetchReleases('me/fork', stub as unknown as typeof fetch);
    expect(list).toHaveLength(1);
    expect(String(stub.mock.calls[0]?.[0])).toMatch(/^https:\/\/api\.github\.com\/repos\/me\/fork\/releases/);
  });

  it('reports an unreachable or rate limited GitHub', async () => {
    const down = () => Promise.reject(new TypeError('network'));
    await expect(fetchReleases('a/b', down as unknown as typeof fetch)).rejects.toMatchObject({ kind: 'unreachable' });
    await expect(fetchReleases('a/b', reply({}, 500) as unknown as typeof fetch)).rejects.toMatchObject({ kind: 'unreachable' });
    await expect(fetchReleases('a/b', reply({}, 403) as unknown as typeof fetch)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(fetchReleases('a/b', reply({}, 429) as unknown as typeof fetch)).rejects.toBeInstanceOf(TeeReleasesError);
  });
});

describe('checkTag', () => {
  const parsed = parseReleases([release('v1.0.0')])[0];
  if (!parsed) throw new Error('fixture');

  it('verifies when the tag points at the release commit', async () => {
    const stub = vi.fn(reply({ sha: 'a'.repeat(40) }));
    await expect(checkTag('a/b', parsed, stub as unknown as typeof fetch)).resolves.toEqual({ kind: 'verified' });
    expect(String(stub.mock.calls[0]?.[0])).toBe('https://api.github.com/repos/a/b/commits/v1.0.0');
  });

  it('reports a mismatch with the commit the tag points at', async () => {
    await expect(checkTag('a/b', parsed, reply({ sha: 'c'.repeat(40) }) as unknown as typeof fetch)).resolves.toEqual({
      kind: 'mismatch',
      tagCommit: 'c'.repeat(40),
    });
  });

  it('fails, rather than passing, when the tag cannot be read', async () => {
    await expect(checkTag('a/b', parsed, reply({ message: 'Not Found' }, 404) as unknown as typeof fetch)).rejects.toBeInstanceOf(TeeReleasesError);
    await expect(checkTag('a/b', parsed, reply({}) as unknown as typeof fetch)).rejects.toBeInstanceOf(TeeReleasesError);
  });
});

describe('releasesRepo', () => {
  it('defaults and can be overridden', () => {
    expect(releasesRepo({})).toBe('AbdulRashidReshamwala/paperseal');
    expect(releasesRepo({ VITE_RELEASES_REPO: 'me/fork' })).toBe('me/fork');
    expect(() => releasesRepo({ VITE_RELEASES_REPO: 'bad repo' })).toThrow();
  });
});
