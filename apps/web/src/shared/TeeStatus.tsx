import { Connected, Row, Rows } from '@paperseal/ui';

import { fromTee, notConnectedToTee } from './tee';

const loadStatus = fromTee((tee) => tee.status());

/** How often the TEE's stage and release count are read again. */
export const TEE_STATUS_POLL_MS = 5000;

export function TeeStatus() {
  return (
    <Connected title="TEE" notConnected={notConnectedToTee} load={loadStatus} pollMs={TEE_STATUS_POLL_MS}>
      {(status) => (
        <Rows>
          <Row label="Stage">{status.stage}</Row>
          <Row label="Shares released">
            {status.release.released.length} of {status.release.required}
          </Row>
        </Rows>
      )}
    </Connected>
  );
}
