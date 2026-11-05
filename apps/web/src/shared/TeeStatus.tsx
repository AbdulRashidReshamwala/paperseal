import { Connected, Row, Rows } from '@paperseal/ui';

import { fromTee, notConnectedToTee } from './tee';

const loadStatus = fromTee((tee) => tee.status());

export function TeeStatus() {
  return (
    <Connected title="TEE" notConnected={notConnectedToTee} load={loadStatus}>
      {(status) => (
        <Rows>
          <Row label="Stage">{status.stage}</Row>
          <Row label="Shares released">
            {status.release.holders.length} of {status.release.required}
          </Row>
        </Rows>
      )}
    </Connected>
  );
}
