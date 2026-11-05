import { registry } from '../shared/registry';
import { tee } from '../shared/tee';
import { ReleaseScreen } from './ReleaseScreen';

/** The release screen for /centre and /keyholder. No context exists until every item is ready. */
export function ReleaseRoute() {
  const prerequisites = [
    { label: 'TEE connected', met: tee !== null },
    { label: 'ExamRegistry connected', met: registry !== null },
    { label: 'Security key registered', met: false },
    { label: 'Encrypted share located', met: false },
    { label: 'TEE attestation fully checked', met: false },
  ];
  return <ReleaseScreen prerequisites={prerequisites} context={null} />;
}
