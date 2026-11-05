import { Screen } from '@paperseal/ui';

import { ReleaseRoute } from '../../release/ReleaseRoute';
import { Area, type AreaScreen } from '../../shared/Area';
import { Register } from '../../shared/Register';
import { TeeStatus } from '../../shared/TeeStatus';

function Status() {
  return (
    <Screen title="Status" lede="You hold one share and release it at the unlock round.">
      <TeeStatus />
    </Screen>
  );
}

export const screens: AreaScreen[] = [
  { path: '', label: 'Status', element: <Status /> },
  { path: 'register', label: 'Register', element: <Register /> },
  { path: 'release', label: 'Release', element: <ReleaseRoute /> },
];

export default function KeyholderArea() {
  return <Area name="Key Holder" base="/keyholder" screens={screens} />;
}
