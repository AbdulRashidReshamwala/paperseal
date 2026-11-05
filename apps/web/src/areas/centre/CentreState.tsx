import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { Downloaded } from './download';

/*
 * The checked downloads live here, in the centre route area, so they survive moving between
 * screens. They are public, hash-checked files held in memory only: nothing is stored, and a
 * reload downloads and checks them again.
 */

interface CentreState {
  downloaded: Downloaded | null;
  setDownloaded: (next: Downloaded | null) => void;
}

const CentreContext = createContext<CentreState | null>(null);

export function CentreProvider(props: { children: ReactNode }) {
  const [downloaded, setDownloaded] = useState<Downloaded | null>(null);
  const value = useMemo(() => ({ downloaded, setDownloaded }), [downloaded]);
  return <CentreContext.Provider value={value}>{props.children}</CentreContext.Provider>;
}

export function useCentreState(): CentreState {
  const state = useContext(CentreContext);
  if (!state) throw new Error('useCentreState needs CentreProvider');
  return state;
}
