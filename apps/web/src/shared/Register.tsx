import { EmptyState, Screen } from '@paperseal/ui';

import { TeeStatus } from './TeeStatus';

/** Registration is the same for centres and neutral parties. */
export function Register() {
  return (
    <Screen title="Register" lede="Create a device-bound passkey on your security key.">
      <TeeStatus />
      <EmptyState title="No key registered">
        Registration needs a connection to the TEE, and your holder ID from the board.
      </EmptyState>
    </Screen>
  );
}
