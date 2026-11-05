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

// With no exam and no settings, every old link lands on the one screen its area's state calls for.
const screens: [ComponentType, string, string, string][] = [
  [BoardArea, '/board', '', 'Create the exam'],
  [BoardArea, '/board', '/blueprint', 'Create the exam'],
  [BoardArea, '/board', '/schedule', 'Create the exam'],
  [BoardArea, '/board', '/publish', 'Create the exam'],
  [BoardArea, '/board', '/onboarding', 'Create the exam'],
  [BoardArea, '/board', '/list', 'Create the exam'],
  [BoardArea, '/board', '/outbox', 'Create the exam'],
  [SetterArea, '/setter', '', 'This link isn’t ready yet'],
  [SetterArea, '/setter', '/upload', 'This link isn’t ready yet'],
  [SetterArea, '/setter', '/receipt', 'This link isn’t ready yet'],
  [CentreArea, '/centre', '', 'This page is not connected to the exam'],
  [CentreArea, '/centre', '/countdown', 'This page is not connected to the exam'],
  [CentreArea, '/centre', '/register', 'This page is not connected to the exam'],
  [CentreArea, '/centre', '/release', 'This page is not connected to the exam'],
  [CentreArea, '/centre', '/unlock', 'This page is not connected to the exam'],
  [CentreArea, '/centre', '/log', 'This page is not connected to the exam'],
  [KeyholderArea, '/keyholder', '', 'This page is not connected to the exam'],
  [KeyholderArea, '/keyholder', '/register', 'This page is not connected to the exam'],
  [KeyholderArea, '/keyholder', '/release', 'This page is not connected to the exam'],
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
