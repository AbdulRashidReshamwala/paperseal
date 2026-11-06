import '@paperseal/ui/tokens.css';

import { loadWebConfig } from '@paperseal/protocol';
import { ChromiumGate, MockLabel } from '@paperseal/ui';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { demoBar, prepareDemo } from './shared/demoKeys';
import { setRuntimeConfig } from './shared/runtime-config';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// config.json is read before App is imported, because the app's modules read their settings when they load.
async function start(element: HTMLElement): Promise<void> {
  await prepareDemo();
  setRuntimeConfig(await loadWebConfig());
  const { App } = await import('./App');
  const DemoBar = demoBar();

  // Hash routes, so the app works as plain static files with no server rewrites.
  createRoot(element).render(
    <StrictMode>
      {import.meta.env.MODE === 'mock' ? <MockLabel /> : null}
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
