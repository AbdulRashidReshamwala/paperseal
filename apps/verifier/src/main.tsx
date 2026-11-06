import '@paperseal/ui/tokens.css';
import './verifier.css';

import { loadWebConfig } from '@paperseal/protocol';
import { MockLabel } from '@paperseal/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { mockMode } from './mockMode';
import { setRuntimeConfig } from './runtime-config';

/*
 * `config.json` beside the page is read first (spec/deploy.md, "App config.json"), so one build
 * works for every board. The rest of the app is imported only after it is set, because its
 * defaults are read when its modules load. A missing or invalid file counts as empty. Mock mode
 * never reads it.
 */
async function start(root: HTMLElement): Promise<void> {
  setRuntimeConfig(mockMode ? {} : await loadWebConfig());
  const [{ App }, { SettingsProvider }] = await Promise.all([import('./App'), import('./settings')]);

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
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
void start(root);
