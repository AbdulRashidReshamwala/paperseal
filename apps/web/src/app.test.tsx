import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import BoardArea from './areas/board/BoardArea';
import CentreArea from './areas/centre/CentreArea';
import KeyholderArea from './areas/keyholder/KeyholderArea';
import SetterArea from './areas/setter/SetterArea';

function render(Area: ComponentType, base: string, path: string) {
  return renderToString(
    <MemoryRouter initialEntries={[`${base}${path}`]}>
      <Routes>
        <Route path={`${base}/*`} element={<Area />} />
      </Routes>
    </MemoryRouter>,
  );
}

const screens: [ComponentType, string, string, string][] = [
  [BoardArea, '/board', '', 'ExamRegistry: not connected'],
  [BoardArea, '/board', '/blueprint', 'maxSetterPercent'],
  [BoardArea, '/board', '/schedule', 'Resulting drand rounds'],
  [BoardArea, '/board', '/publish', 'Not ready to publish'],
  [BoardArea, '/board', '/onboarding', 'Read back by the TEE: not connected'],
  [BoardArea, '/board', '/list', 'On-chain list: not connected'],
  [BoardArea, '/board', '/outbox', 'Outbox: not connected'],
  [SetterArea, '/setter', '', 'Sign-in unavailable'],
  [SetterArea, '/setter', '/upload', 'Upload locked'],
  [SetterArea, '/setter', '/receipt', 'No receipts yet'],
  [CentreArea, '/centre', '', 'Nothing downloaded'],
  [CentreArea, '/centre', '/countdown', 'Unlock round: not connected'],
  [CentreArea, '/centre', '/register', 'Register'],
  [CentreArea, '/centre', '/release', 'Release your share'],
  [CentreArea, '/centre', '/unlock', 'Paper locked'],
  [CentreArea, '/centre', '/log', 'Release log: not connected'],
  [KeyholderArea, '/keyholder', '', 'TEE: not connected'],
  [KeyholderArea, '/keyholder', '/register', 'Register'],
  [KeyholderArea, '/keyholder', '/release', 'Release your share'],
];

describe('route areas', () => {
  it.each(screens)('screen %# renders', (Area, base, path, text) => {
    expect(render(Area, base, path)).toContain(text);
  });

  it('home links to each role and has no verifier route', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    for (const href of ['/board', '/setter', '/centre', '/keyholder']) expect(html).toContain(href);
    expect(html).not.toContain('/verif');
  });
});
