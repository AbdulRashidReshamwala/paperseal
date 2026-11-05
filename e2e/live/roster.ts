export type Kind = 'setter' | 'neutral' | 'centre-holder' | 'centre';
export interface RosterEntry {
  name: string;
  kind: Kind;
  /** Approved-list role: 1 setter, 2 neutral party, 3 centre key holder, 4 centre without a share. */
  role: 1 | 2 | 3 | 4;
}

const count = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

export const roster: RosterEntry[] = [
  ...count(2).map((n) => ({ name: `setter-${String(n)}`, kind: 'setter' as const, role: 1 as const })),
  ...count(3).map((n) => ({ name: `neutral-${String(n)}`, kind: 'neutral' as const, role: 2 as const })),
  ...count(7).map((n) => ({ name: `centre-${String(n)}`, kind: 'centre-holder' as const, role: 3 as const })),
  { name: 'centre-8', kind: 'centre' as const, role: 4 as const },
];

/** Seven centre key holders first, so 7 of 10 shares can be shown to release nothing, then a neutral party as the 8th. */
export const releaseOrder = ['centre-1', 'centre-2', 'centre-3', 'centre-4', 'centre-5', 'centre-6', 'centre-7', 'neutral-1'] as const;
