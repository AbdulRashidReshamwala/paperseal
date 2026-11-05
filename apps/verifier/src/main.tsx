import '@paperseal/ui/tokens.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { App } from './App';
import { SettingsProvider } from './settings';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Hash routes keep deep links working on any static host, in any folder.
// No Chromium gate: the verifier uses no passkeys, so any modern browser works.
createRoot(root).render(
  <StrictMode>
    <SettingsProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </SettingsProvider>
  </StrictMode>,
);
