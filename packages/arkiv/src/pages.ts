import { MAX_LIMIT } from '@arkiv-network/sdk/query';
import type { Hex } from 'viem';

// Internal to the package: not re-exported from index.ts.

/** One page of a query: its rows, and how many matches it left out for not fitting the schema. */
interface Page<R> {
  entities: readonly R[];
  skipped: number;
}

/**
 * Reads every page of a query sorted by `$key`. The node counts skipped entities toward the offset,
 * so the next page starts past both, and a page that covered less than a full page was the last.
 * A row created mid-walk can shift a later page, so rows are deduplicated by key.
 */
export async function allPages<R extends { $key: Hex }>(
  fetchPage: (offset: number) => Promise<Page<R>>,
): Promise<R[]> {
  const rows = new Map<Hex, R>();
  for (let offset = 0; ; ) {
    const { entities, skipped } = await fetchPage(offset);
    for (const row of entities) rows.set(row.$key, row);
    const covered = entities.length + skipped;
    if (covered < MAX_LIMIT) return [...rows.values()];
    offset += covered;
  }
}
