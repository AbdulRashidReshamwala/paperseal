import type { Paper } from '@paperseal/protocol';
import { roles } from '@paperseal/protocol';
import type { SealState } from '@paperseal/ui';

import { centreRoles, hasReleased, holderGate, type GateStage, type HolderProgress } from '../../release/progress';

export type CentreStage =
  | GateStage
  /** No paper has been sealed yet. */
  | 'awaiting-build'
  /** The downloaded files do not match the public record. */
  | 'files-refused'
  /** Before unlock: the files are fetched and checked by themselves. */
  | 'waiting'
  | 'release'
  /** Unlock has come and this centre has nothing to do until enough key holders release. */
  | 'holders'
  /** The key has reached centres, but the checked files are not here yet. */
  | 'files-pending'
  | 'open'
  | 'open-failed'
  | 'paper-open'
  | 'machine-waiting'
  | 'machine-unreachable'
  | 'machine-failed';

export interface CentreInputs {
  filesReady: boolean;
  filesRefused: boolean;
  /** The paper, set only after every check in `unlockPaper` has passed. */
  paper: Paper | null;
  openFailed: boolean;
  justReleased: boolean;
}

/** The one screen this centre should see. A reload comes back to the same place. */
export function centreStage(progress: HolderProgress, inputs: CentreInputs): CentreStage {
  const gate = holderGate(progress, centreRoles);
  if (gate) return gate;
  if (inputs.paper) return 'paper-open';
  if (inputs.openFailed) return 'open-failed';
  if (!progress.chain.value?.buildPosted) return 'awaiting-build';
  if (inputs.filesRefused) return 'files-refused';
  const status = progress.status.value;
  if (status?.stage === 'failed') return 'machine-failed';
  if (status?.stage === 'released') return inputs.filesReady ? 'open' : 'files-pending';
  if (!progress.reached) return 'waiting';
  if (!status) return progress.status.settled ? 'machine-unreachable' : 'loading';
  if (status.stage !== 'unlock') return 'machine-waiting';
  const holdsShare = progress.chain.value.entry?.role === roles.centreKeyHolder;
  return holdsShare && !inputs.justReleased && !hasReleased(status, progress.credential) ? 'release' : 'holders';
}

/**
 * What the seal may show. It stays away from any screen where its state has not been established,
 * and from failures, because a seal is good news.
 */
export function sealFor(stage: CentreStage): SealState | null {
  switch (stage) {
    case 'waiting':
      return 'sealed';
    case 'release':
    case 'holders':
    case 'files-pending':
    case 'open':
    case 'machine-waiting':
    case 'machine-unreachable':
      return 'opening';
    case 'paper-open':
      return 'open';
    default:
      return null;
  }
}
