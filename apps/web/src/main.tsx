import '@paperseal/ui/tokens.css';

import { ChromiumGate, MockLabel } from '@paperseal/ui';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { App } from './App';
import { demoBar, prepareDemo } from './shared/demoKeys';
import { mockMode } from './shared/mockMode';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

await prepareDemo();
const DemoBar = demoBar();

// Hash routes, so the app works as plain static files with no server rewrites.
createRoot(root).render(
  <StrictMode>
    {mockMode ? <MockLabel /> : null}
    {DemoBar ? (
      <Suspense fallback={null}>
        <DemoBar />
      </Suspense>
    ) : null}
    <ChromiumGate>
      <HashRouter>
        <App />
      </HashRouter>
    </ChromiumGate>
  </StrictMode>,
);
