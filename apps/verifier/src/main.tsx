import '@paperseal/ui/tokens.css';
import './verifier.css';

import { MockLabel } from '@paperseal/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { App } from './App';
import { mockMode } from './mockMode';
import { SettingsProvider } from './settings';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Hash routes keep exam links working on any static host, in any folder.
// No Chromium gate: the verifier uses no passkeys, so any modern browser works.
createRoot(root).render(
  <StrictMode>
    {mockMode ? <MockLabel /> : null}
    <SettingsProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </SettingsProvider>
  </StrictMode>,
);
