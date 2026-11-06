import '@paperseal/ui/tokens.css';

import { loadWebConfig } from '@paperseal/protocol';
import { ChromiumGate, MockLabel } from '@paperseal/ui';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { demoBar } from './shared/demoKeys';
import { mockMode } from './shared/mockMode';
import { setRuntimeConfig } from './shared/runtime-config';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// config.json is read before App is imported, because the app's modules read their settings when they load.
async function start(element: HTMLElement): Promise<void> {
  setRuntimeConfig(await loadWebConfig());
  const { App } = await import('./App');
  const DemoBar = demoBar();

  // Hash routes, so the app works as plain static files with no server rewrites.
  createRoot(element).render(
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
}

void start(root);
