import { Badge, Connected, Row, Rows, Screen } from '@paperseal/ui';

import { ReleaseRoute } from '../../release/ReleaseRoute';
import { Area, type AreaScreen } from '../../shared/Area';
import { useHolderCredential } from '../../shared/holder';
import { Register } from '../../shared/Register';
import { fromTee, notConnectedToTee } from '../../shared/tee';
import { TEE_STATUS_POLL_MS, TeeStatus } from '../../shared/TeeStatus';

const loadStatus = fromTee((tee) => tee.status());

/** Whether the TEE has accepted this browser's key holder, by the passkey public key in `release.released`. */
function YourRelease() {
  const identity = useHolderCredential('keyholder');
  return (
    <Connected title="Your share" notConnected={notConnectedToTee} load={loadStatus} pollMs={TEE_STATUS_POLL_MS}>
      {(status) => {
        const released = identity
          ? status.release.released.some((key) => key.toLowerCase() === identity.passkeyPublicKey.toLowerCase())
          : false;
        return (
          <Rows>
            <Row label="Security key">
              {identity ? identity.owner : <Badge tone="warn">Not registered in this browser</Badge>}
            </Row>
            <Row label="Release">
              {released ? <Badge tone="ok">Accepted by the TEE</Badge> : <Badge tone="neutral">Not released yet</Badge>}
            </Row>
          </Rows>
        );
      }}
    </Connected>
  );
}

function RegisterWithStatus() {
  return (
    <>
      <Register role="keyholder" />
      <TeeStatus />
    </>
  );
}

function Status() {
  return (
    <Screen title="Status" lede="You hold one share and release it at the unlock round.">
      <TeeStatus />
      <YourRelease />
    </Screen>
  );
}

export const screens: AreaScreen[] = [
  { path: '', label: 'Status', element: <Status /> },
  { path: 'register', label: 'Register', element: <RegisterWithStatus /> },
  { path: 'release', label: 'Release', element: <ReleaseRoute role="keyholder" /> },
];

export default function KeyholderArea() {
  return <Area name="Key Holder" base="/keyholder" screens={screens} />;
}
