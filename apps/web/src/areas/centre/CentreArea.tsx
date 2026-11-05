import { ReleaseRoute } from '../../release/ReleaseRoute';
import { Area, type AreaScreen } from '../../shared/Area';
import { Register } from '../../shared/Register';
import { TeeStatus } from '../../shared/TeeStatus';
import { CentreProvider } from './CentreState';
import { Countdown } from './Countdown';
import { Download } from './DownloadScreen';
import { UnlockLog } from './Log';
import { Unlock } from './UnlockScreen';

function RegisterWithStatus() {
  return (
    <>
      <Register />
      <TeeStatus />
    </>
  );
}

export const screens: AreaScreen[] = [
  { path: '', label: 'Download', element: <Download /> },
  { path: 'countdown', label: 'Countdown', element: <Countdown /> },
  { path: 'register', label: 'Register', element: <RegisterWithStatus /> },
  { path: 'release', label: 'Release', element: <ReleaseRoute /> },
  { path: 'unlock', label: 'Unlock', element: <Unlock /> },
  { path: 'log', label: 'Log', element: <UnlockLog /> },
];

export default function CentreArea() {
  return (
    <CentreProvider>
      <Area name="Centre" base="/centre" screens={screens} />
    </CentreProvider>
  );
}
