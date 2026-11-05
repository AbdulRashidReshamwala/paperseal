// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { saveCredential } from '../../shared/Register';
import SetterArea from './SetterArea';
import { saveReceipt } from './receipts';
import { credentialId, examId, makeWorld, passkeyPublicKey, type World } from './testkit';

function mount(world: World, path = '/setter') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/setter/*" element={<SetterArea env={world.env} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  saveCredential(examId, { owner: 'Ada', role: 'setter', credentialId, passkeyPublicKey });
});
afterEach(cleanup);

describe('setter screens', () => {
  it('blocks uploading and says why when attestation fails', async () => {
    const world = await makeWorld({ realAttestation: true });
    mount(world);
    fireEvent.click(await screen.findByText('Check the TEE'));
    expect(await screen.findByText(/TEE attestation failed/)).toBeTruthy();
    expect(screen.getByText(/Claim iss: expected/)).toBeTruthy();

    fireEvent.click(screen.getByText('Upload'));
    expect(await screen.findByText('Upload locked')).toBeTruthy();
    expect(screen.queryByText('Add to list')).toBeNull();
  });

  it('blocks uploading on a list hash mismatch', async () => {
    const world = await makeWorld({ chainListHashOverride: `0x${'cd'.repeat(32)}` });
    mount(world);
    fireEvent.click(await screen.findByText('Check the TEE'));
    expect(await screen.findByText(/List hash mismatch/)).toBeTruthy();
    fireEvent.click(screen.getByText('Upload'));
    expect(await screen.findByText('Upload locked')).toBeTruthy();
  });

  it('opens the form after the checks pass and seals a question', async () => {
    const world = await makeWorld();
    mount(world);
    fireEvent.click(await screen.findByText('Check the TEE'));
    expect(await screen.findByText(/Encrypting is open/)).toBeTruthy();
    fireEvent.click(screen.getByText('Upload'));

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'What is momentum?' } });
    fireEvent.click(screen.getByText('Add to list'));
    fireEvent.click(await screen.findByText(/Seal and send 1 question/));
    expect(await screen.findByText('sealed ✓')).toBeTruthy();
    expect(world.teeQuestion).toHaveBeenCalledTimes(1);
  });

  it('closes submitting outside the submit stage', async () => {
    const world = await makeWorld();
    mount(world);
    fireEvent.click(await screen.findByText('Check the TEE'));
    await screen.findByText(/Encrypting is open/);
    world.stage.current = 'lock';
    fireEvent.click(screen.getByText('Upload'));
    expect(await screen.findByText(/only open at the submit stage/)).toBeTruthy();
  });

  it('shows a mismatch when a receipt instance key is not the Build key', async () => {
    const world = await makeWorld();
    saveReceipt(examId, {
      questionHash: `0x${'11'.repeat(32)}`,
      instancePublicKey: world.signer.publicKey,
      teeSignature: '0x00',
      sealedAt: 0,
    });
    world.build.current = { instancePublicKey: `0x04${'bb'.repeat(64)}` };
    mount(world, '/setter/receipt');
    fireEvent.click(await screen.findByText('Compare with the Build'));
    await waitFor(() => {
      expect(screen.getByText(/different TEE instance/)).toBeTruthy();
    });
    // The stored signature is not a real one, so it is not shown as sealed.
    expect(screen.queryByText('sealed ✓')).toBeNull();
  });

  it('shows a match when the keys agree', async () => {
    const world = await makeWorld();
    saveReceipt(examId, {
      questionHash: `0x${'11'.repeat(32)}`,
      instancePublicKey: world.signer.publicKey,
      teeSignature: '0x00',
      sealedAt: 0,
    });
    world.build.current = { instancePublicKey: world.signer.publicKey };
    mount(world, '/setter/receipt');
    fireEvent.click(await screen.findByText('Compare with the Build'));
    expect(await screen.findByText(/went to the TEE that built the paper/)).toBeTruthy();
  });
});
