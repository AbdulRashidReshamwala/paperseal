import '@paperseal/ui/tokens.css';

import { ChromiumGate, MockLabel } from '@paperseal/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { App } from './App';
import { mockMode } from './shared/mockMode';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Hash routes, so the app works as plain static files with no server rewrites.
createRoot(root).render(
  <StrictMode>
    {mockMode ? <MockLabel /> : null}
    <ChromiumGate>
      <HashRouter>
        <App />
      </HashRouter>
    </ChromiumGate>
  </StrictMode>,
);
