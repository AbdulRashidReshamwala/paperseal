import '@paperseal/ui/tokens.css';

import { roles, type Paper } from '@paperseal/protocol';
import { createRoot } from 'react-dom/client';

import { CentreView } from '../../apps/web/src/areas/centre/CentreArea';
import type { Downloaded } from '../../apps/web/src/areas/centre/download';

/*
 * A fixture, not a run: the real centre screen with the paper step already reached, so the distribution
 * page can be driven locally without a sealed machine. The paper below is made up for this page. The real
 * paper reaches this screen only after a live unlock, which `ui/live.ui-live.ts` drives.
 */

const entry = { role: roles.centre, passkeyPublicKey: new Uint8Array(65).fill(0xaa), derivedPublicKey: new Uint8Array(65).fill(0xbb), owner: 'North Centre' };
const paper: Paper = {
  examId: `0x${'11'.repeat(32)}`,
  questions: [
    { topic: 'Mechanics', text: 'Which of these is a unit of force?', options: ['Joule', 'Newton', 'Watt'] },
    { topic: 'Mechanics', text: 'State Newton’s second law.' },
  ],
};
const progress = {
  missing: [],
  examId: paper.examId,
  credential: { owner: 'North Centre', role: 'centre', credentialId: '0x01', passkeyPublicKey: `0x04${'aa'.repeat(64)}` },
  registering: false,
  chain: { value: { unlockRound: 1, endRound: 2, listPosted: true, entry, buildPosted: true }, error: null, settled: true },
  status: { value: { stage: 'released', questionCount: 2, release: { released: [], required: 8 } }, error: null, settled: true },
  reached: true,
  ended: false,
} as unknown as Parameters<typeof CentreView>[0]['progress'];

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <CentreView
    progress={progress}
    actions={{ refresh: () => undefined, registered: () => undefined }}
    context={null}
    files={{ state: 'ready', downloaded: {} as Downloaded }}
    retryFiles={() => undefined}
    open={{ phase: { name: 'idle' }, paper, start: () => undefined, prepare: () => undefined }}
    justReleased={false}
    onReleased={() => undefined}
    log={<p>The unlock log goes here.</p>}
    handOutStepMs={400}
  />,
);
