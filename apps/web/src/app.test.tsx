import { aesGcmEncrypt } from '@paperseal/crypto';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import BoardArea from './areas/board/BoardArea';
import { decryptPaper } from './areas/centre/unlock';
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
  [BoardArea, '/board', '/onboarding', 'No registrations'],
  [BoardArea, '/board', '/list', 'On-chain list: not connected'],
  [BoardArea, '/board', '/outbox', 'Outbox: not connected'],
  [SetterArea, '/setter', '', 'Sign-in unavailable'],
  [SetterArea, '/setter', '/upload', 'Upload locked'],
  [SetterArea, '/setter', '/receipt', 'No receipts yet'],
  [CentreArea, '/centre', '', 'Nothing downloaded'],
  [CentreArea, '/centre', '/countdown', 'Unlock round: not connected'],
  [CentreArea, '/centre', '/register', 'No key registered'],
  [CentreArea, '/centre', '/release', 'Release your share'],
  [CentreArea, '/centre', '/unlock', 'Paper locked'],
  [CentreArea, '/centre', '/log', 'Release log: not connected'],
  [KeyholderArea, '/keyholder', '', 'TEE: not connected'],
  [KeyholderArea, '/keyholder', '/register', 'No key registered'],
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

describe('decryptPaper', () => {
  it('opens a paper with the two key halves', async () => {
    const kPub = new Uint8Array(32).fill(1);
    const kPriv = new Uint8Array(32).fill(2);
    const paper = new TextEncoder().encode('{"questions":[]}');
    const sealed = await aesGcmEncrypt(new Uint8Array(32).fill(3), paper);
    expect(await decryptPaper(kPub, kPriv, sealed)).toEqual(paper);
  });

  it('fails with the wrong half', async () => {
    const sealed = await aesGcmEncrypt(new Uint8Array(32).fill(3), new Uint8Array(4));
    await expect(decryptPaper(new Uint8Array(32), new Uint8Array(32).fill(9), sealed)).rejects.toThrow();
  });
});
