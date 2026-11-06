import { resolveExamName, type EnsLookup } from '@paperseal/chain';
import type { Hex } from '@paperseal/protocol';
import { isAddressEqual, type Address } from 'viem';

import { readArkiv, verifiedName, type HistoryReader } from './history';

/*
 * Who ran an exam, for the page's Identity section. A name here is a label: no check depends on it.
 * The exam's name is shown, and its link used, only after `resolveExamName` passes again and leads to
 * this exam and registry.
 */

/** The board's primary name. `confirmed` holds both ways: its address record points back at the board. */
export type BoardName =
  | { state: 'confirmed'; name: string }
  | { state: 'none' }
  | { state: 'unconfirmed'; name: string }
  | { state: 'unread'; message: string };

export async function readBoardName(board: Address, lookup: Pick<EnsLookup, 'primaryName' | 'address'>): Promise<BoardName> {
  try {
    const name = await lookup.primaryName(board);
    if (!name) return { state: 'none' };
    const forward = await lookup.address(name);
    return forward && isAddressEqual(forward, board) ? { state: 'confirmed', name } : { state: 'unconfirmed', name };
  } catch (error) {
    return { state: 'unread', message: error instanceof Error ? error.message : String(error) };
  }
}

export interface ExamNameRead {
  /** Set only when the name passed every check and leads to this exam and registry. */
  name: string | null;
  /** Names the index gave that did not pass. */
  failed: number;
  /** Why the index could not be read, if it could not. */
  unread?: string;
}

/**
 * The exam's name, from what `writers` indexed (spec/arkiv.md, "Exam Index"). An exam ID is a hash of
 * its name, so the index is the only way from an ID back to a name, and with none there is no name to
 * show. That says nothing against the exam.
 */
export async function readExamName(args: {
  reader: Pick<HistoryReader, 'examRows'> | null;
  writers: readonly Address[];
  examId: Hex;
  registry: Address;
  rpcUrl: string;
}): Promise<ExamNameRead> {
  const { reader, writers, examId, registry, rpcUrl } = args;
  if (!reader || writers.length === 0) return { name: null, failed: 0 };
  try {
    const rows = await readArkiv(() => reader.examRows(registry, writers));
    const names = [...new Set(rows.filter((row) => row.examId === examId && row.name !== '').map((row) => row.name))];
    const ignored = { notOnChain: 0, differs: 0, malformed: 0, names: 0 };
    const name = await verifiedName(names, examId, registry, (candidate) => resolveExamName(candidate, { rpcUrl }), ignored);
    return { name, failed: ignored.names };
  } catch (error) {
    return { name: null, failed: 0, unread: error instanceof Error ? error.message : String(error) };
  }
}

/** The GitHub release of the code an exam records. The version is only a label for that commit and image. */
export type Version = { state: 'found'; version: string; url: string } | { state: 'none' } | { state: 'unread'; message: string };

const fence = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

/** The release whose notes give exactly this commit and image digest. */
export function findVersion(listing: unknown, commit: Hex, imageDigest: Hex): Version {
  if (!Array.isArray(listing)) return { state: 'none' };
  for (const release of listing as { tag_name?: unknown; html_url?: unknown; body?: unknown; draft?: unknown }[]) {
    if (release.draft !== false || typeof release.body !== 'string' || typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') continue;
    for (const [, block] of release.body.matchAll(fence)) {
      try {
        const notes = JSON.parse(block ?? '') as { commit?: unknown; imageDigest?: unknown };
        const same = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
        // The link must stay on GitHub, whatever the listing says.
        if (same(notes.commit, commit) && same(notes.imageDigest, imageDigest) && release.html_url.startsWith('https://github.com/')) {
          return { state: 'found', version: release.tag_name, url: release.html_url };
        }
      } catch {
        // A block that is not JSON names no release.
      }
    }
  }
  return { state: 'none' };
}

export async function readVersion(repository: string, commit: Hex, imageDigest: Hex, send: typeof fetch = (...args) => globalThis.fetch(...args)): Promise<Version> {
  try {
    const response = await send(`https://api.github.com/repos/${repository}/releases?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return { state: 'unread', message: `GitHub answered with status ${String(response.status)}.` };
    return findVersion(await response.json(), commit, imageDigest);
  } catch (error) {
    return { state: 'unread', message: error instanceof Error ? error.message : String(error) };
  }
}
