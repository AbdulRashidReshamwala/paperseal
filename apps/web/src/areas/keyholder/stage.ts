import { hasReleased, holderGate, holderRoles, type GateStage, type HolderProgress } from '../../release/progress';

export type KeyholderStage =
  | GateStage
  | 'waiting'
  | 'release'
  | 'done'
  /** Enough key holders released first, so the sealed machine takes no more shares. */
  | 'not-needed'
  /** The public clock says unlock, but the sealed machine is not at that stage. */
  | 'machine-waiting'
  | 'machine-unreachable'
  | 'machine-failed';

/** The one screen this key holder should see. A reload comes back to the same place. */
export function keyholderStage(progress: HolderProgress, justReleased: boolean): KeyholderStage {
  const gate = holderGate(progress, holderRoles);
  if (gate) return gate;
  const status = progress.status.value;
  if (justReleased || hasReleased(status, progress.credential)) return 'done';
  if (status?.stage === 'failed') return 'machine-failed';
  if (status?.stage === 'released') return 'not-needed';
  if (!progress.reached) return 'waiting';
  if (!status) return progress.status.settled ? 'machine-unreachable' : 'loading';
  return status.stage === 'unlock' ? 'release' : 'machine-waiting';
}
