import { KeyError } from './errors';

/** Flag bits in the authenticator data flags byte, from the WebAuthn spec. */
const BACKUP_ELIGIBLE = 0x08;
const BACKED_UP = 0x10;
const FLAGS_OFFSET = 32;

export interface BackupFlags {
  backupEligible: boolean;
  backedUp: boolean;
}

export function readBackupFlags(authenticatorData: Uint8Array): BackupFlags {
  const flags = authenticatorData[FLAGS_OFFSET];
  if (authenticatorData.length < FLAGS_OFFSET + 5 || flags === undefined) {
    throw new KeyError('malformed_authenticator_data', 'authenticator data is too short');
  }
  return {
    backupEligible: (flags & BACKUP_ELIGIBLE) !== 0,
    backedUp: (flags & BACKED_UP) !== 0,
  };
}

/** Rejects synced passkeys. A device-bound credential has both backup flags clear. */
export function assertDeviceBound(authenticatorData: Uint8Array): void {
  const { backupEligible, backedUp } = readBackupFlags(authenticatorData);
  if (backupEligible || backedUp) {
    throw new KeyError(
      'synced_passkey',
      'This passkey can sync to a cloud account. Use a hardware security key.',
    );
  }
}
