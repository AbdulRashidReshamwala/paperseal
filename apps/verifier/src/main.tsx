import '@paperseal/ui/tokens.css';
import './verifier.css';

import { loadWebConfig } from '@paperseal/protocol';
import { MockLabel } from '@paperseal/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { mockMode } from './mockMode';
import { setRuntimeConfig } from './runtime-config';

/** The faces the page is set in. They load before it draws, so no text swaps face and moves after. */
const FACES = [
  '400 1em "Public Sans"',
  '500 1em "Public Sans"',
  '600 1em "Public Sans"',
  '400 1em "Libre Caslon Text"',
  '700 1em "Libre Caslon Text"',
  '400 1em "Libre Caslon Display"',
  '400 1em "IBM Plex Mono"',
];
/** How long a slow connection holds the page for its fonts. After this it draws with the fallback. */
const FONT_WAIT_MS = 1500;

async function fontsReady(): Promise<void> {
  const waited = new Promise((resolve) => {
    setTimeout(resolve, FONT_WAIT_MS);
  });
  await Promise.race([Promise.allSettled(FACES.map((face) => document.fonts.load(face))), waited]);
}

/*
 * `config.json` beside the page is read first (spec/deploy.md, "App config.json"), so one build
 * works for every board. The rest of the app is imported only after it is set, because its
 * defaults are read when its modules load. A missing or invalid file counts as empty. Mock mode
 * never reads it.
 */
async function start(root: HTMLElement): Promise<void> {
  const [config] = await Promise.all([mockMode ? {} : loadWebConfig(), fontsReady()]);
  setRuntimeConfig(config);
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
