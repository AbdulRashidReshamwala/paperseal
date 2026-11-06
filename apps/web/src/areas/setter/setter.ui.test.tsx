// @vitest-environment jsdom
import { fromHex, padding, parseQuestion, setterOwner, unpadQuestion } from '@paperseal/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearHeldInvites, holdInvite } from '../../shared/invite';
import { saveCredential } from '../../shared/Register';
import { CONFIRMATION_REFRESH_MS, CONFIRMATION_TTL_MS } from './confirm';
import { loadReceipts, saveReceipt } from './receipts';
import SetterArea from './SetterArea';
import { saveTopic } from './state';
import { credentialId, examId, makeSigner, makeWorld, passkeyPublicKey, postedBody, signedReceipt, type World } from './testkit';

function mount(world: World, path = '/setter') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/setter/*" element={<SetterArea env={world.env} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const registered = () => {
  saveCredential(examId, { owner: setterOwner(fromHex(passkeyPublicKey)), role: 'setter', credentialId, passkeyPublicKey });
};

const SEAL = 'Seal this question';
const sealButton = () => screen.queryByRole('button', { name: SEAL }) as HTMLButtonElement | null;
const writingArea = () => screen.findByLabelText('Your question') as Promise<HTMLTextAreaElement>;
const write = async (text: string) => {
  const area = await writingArea();
  fireEvent.change(area, { target: { value: text } });
  return area;
};
/** The writing area, once the automatic checks have opened sealing. */
const ready = async () => {
  await waitFor(() => {
    expect(sealButton()).toBeTruthy();
  });
  return writingArea();
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a first visit', () => {
  // The setter opened its invitation link, which holds an invite for this exam and no name.
  beforeEach(() => {
    holdInvite({ examId, role: 'setter', inviteSecret: `0x${'a5'.repeat(32)}` });
  });
  afterEach(clearHeldInvites);

  it('asks only for one key touch, says the name is never published, then checks by itself', async () => {
    const world = await makeWorld();
    mount(world);
    expect(await screen.findByRole('heading', { name: 'Register your security key' })).toBeTruthy();
    expect(screen.getByText(/Your name is not published/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Register your security key' }));
    await ready();
    expect(world.env.keys().register).toHaveBeenCalledTimes(1);
    expect(world.verifyToken).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Check the TEE')).toBeNull();
  });

  it('does not say the list is still to come once writing is open', async () => {
    const world = await makeWorld();
    mount(world);
    await screen.findByRole('heading', { name: 'Register your security key' });
    expect(screen.queryByText(/publishes the approved list/)).toBeNull();
  });

  it('waits for the board without checking anything, then opens by itself', async () => {
    const world = await makeWorld();
    world.stage.current = 'onboard';
    mount(world);
    fireEvent.click(await screen.findByRole('button', { name: 'Register your security key' }));
    expect(await screen.findByText(/Questions open once your exam board has sent the list/)).toBeTruthy();
    // There is no list to check yet, so a check here could only raise a false alarm.
    expect(world.verifyToken).not.toHaveBeenCalled();

    world.stage.current = 'submit';
    await ready();
    expect(world.verifyToken).toHaveBeenCalled();
  });

  it('explains instead of showing a form when there is no invitation link', async () => {
    clearHeldInvites();
    const world = await makeWorld();
    mount(world);
    expect(await screen.findByRole('heading', { name: 'Open your invitation link' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('asks for a new registration when a different invitation link is opened, and offers no other way to change key', async () => {
    registered();
    clearHeldInvites();
    const world = await makeWorld();
    world.stage.current = 'onboard';
    mount(world);
    expect(await screen.findByText(/Questions open once your exam board has sent the list/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use a different security key' })).toBeNull();
    cleanup();
    holdInvite({ examId, role: 'setter', inviteSecret: `0x${'5a'.repeat(32)}` });
    mount(world);
    expect(await screen.findByRole('button', { name: 'Register your security key' })).toBeTruthy();
  });

  it('shows no name field and no tabs anywhere', async () => {
    const world = await makeWorld();
    mount(world);
    await screen.findByRole('heading', { name: 'Register your security key' });
    expect(screen.queryByLabelText('Name on the approved list')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    // The logo is the one link, back to the start page.
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['#/']);
  });
});

describe('the automatic check', () => {
  beforeEach(registered);

  it('shows the loader while it runs, and sealing stays shut', async () => {
    const world = await makeWorld();
    let finish: (value: unknown) => void = () => undefined;
    world.verifyToken.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    mount(world);
    expect(await screen.findByText('Loading')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(sealButton()).toBeNull();
    finish({ trusted: true, signature: { ok: true }, instanceKey: { ok: true }, claims: [] });
    await ready();
  });

  it('blocks sealing, loudly and with the reason, when attestation fails', async () => {
    const world = await makeWorld({ realAttestation: true });
    mount(world);
    expect(await screen.findByRole('heading', { name: /can’t take your questions yet/ })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Nothing new has been sent');
    expect(screen.getByText(/Claim iss: expected/)).toBeTruthy();
    expect(sealButton()).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(world.teeQuestion).not.toHaveBeenCalled();
  });

  it('blocks sealing on a list mismatch, and does not retry until asked', async () => {
    const world = await makeWorld({ chainListHashOverride: `0x${'cd'.repeat(32)}` });
    mount(world);
    expect(await screen.findByText(/List hash mismatch/)).toBeTruthy();
    const calls = world.verifyToken.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(world.verifyToken.mock.calls.length).toBe(calls);

    world.chainListHash.current = (await world.tee.status()).approvedList?.hash as `0x${string}`;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await ready();
  });
});

describe('sealing', () => {
  beforeEach(registered);

  it('seals with one touch, stamps, clears the words and returns focus to writing', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    const area = await write('What is momentum?');
    fireEvent.click(sealButton() as HTMLButtonElement);

    expect(await screen.findByText('Sealed')).toBeTruthy();
    await waitFor(() => {
      expect(area.value).toBe('');
    });
    expect(document.activeElement).toBe(area);
    expect(world.signed).toHaveLength(1);
    expect(world.teeQuestion).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/^Question 1 · Mechanics$/)).toBeTruthy();
    expect(await screen.findByText('1 question sealed so far')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Mechanics/ }).closest('label')?.textContent).toContain('1 sealed');
    // The words go altogether: not in the page once the stamp has gone, and never in storage.
    await waitFor(
      () => {
        expect(document.body.textContent).not.toContain('What is momentum?');
      },
      { timeout: 2000 },
    );
    expect(JSON.stringify({ ...localStorage })).not.toContain('momentum');
  });

  it.each([
    ['Control', { ctrlKey: true }],
    ['Command', { metaKey: true }],
  ])('seals from the keyboard with %s and Enter, once however often it is pressed', async (_name, modifier) => {
    const world = await makeWorld();
    mount(world);
    await ready();
    const area = await write('What is momentum?');
    fireEvent.keyDown(area, { key: 'Enter', ...modifier });
    fireEvent.keyDown(area, { key: 'Enter', ...modifier });
    await waitFor(() => {
      expect(loadReceipts(examId)).toHaveLength(1);
    });
    expect(world.teeQuestion).toHaveBeenCalledTimes(1);
  });

  it('leaves plain Enter as a new line', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    fireEvent.keyDown(await write('First line'), { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.teeQuestion).not.toHaveBeenCalled();
  });

  it('does nothing from the keyboard on an empty question', async () => {
    const world = await makeWorld();
    mount(world);
    fireEvent.keyDown(await ready(), { key: 'Enter', metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.signed).toEqual([]);
    expect(sealButton()?.disabled).toBe(true);
  });

  it('seals under the chosen topic and keeps that topic for the next question', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    fireEvent.click(screen.getByRole('radio', { name: /Optics/ }));
    await write('What is refraction?');
    fireEvent.click(sealButton() as HTMLButtonElement);
    expect(await screen.findByText(/^Question 1 · Optics$/)).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Optics/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('counts only receipts that verify towards progress', async () => {
    const world = await makeWorld();
    const good = await signedReceipt(world, 1);
    const forged = { ...(await signedReceipt(world, 2)), teeSignature: '0x00' as const };
    saveReceipt(examId, good);
    saveReceipt(examId, forged);
    saveTopic(examId, good.questionHash, 'Mechanics');
    saveTopic(examId, forged.questionHash, 'Mechanics');
    mount(world);
    await ready();
    expect(await screen.findByText('1 question sealed so far')).toBeTruthy();
    expect(await screen.findByText(/This receipt could not be confirmed/)).toBeTruthy();
  });

  it('states the size limit and refuses a question over it', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    expect(screen.getByText(/characters left/)).toBeTruthy();
    const area = await write('x'.repeat(padding.questionBytes));
    expect(screen.getByText(/Too long by about/)).toBeTruthy();
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    expect(sealButton()?.disabled).toBe(true);
    expect(world.signed).toEqual([]);
  });

  it('keeps the words after a key failure, and retries with a further touch', async () => {
    const world = await makeWorld();
    const keys = world.env.keys();
    Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
    (keys.sign as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DOMException('cancelled', 'NotAllowedError'));
    mount(world);
    await ready();
    const area = await write('What is momentum?');
    fireEvent.click(sealButton() as HTMLButtonElement);
    expect(await screen.findByText('No security key answered')).toBeTruthy();
    expect(area.value).toBe('What is momentum?');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(loadReceipts(examId)).toHaveLength(1);
    });
  });
});

describe('multiple choice', () => {
  beforeEach(registered);

  const kind = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;
  const option = (letter: string) => screen.getByLabelText(`Option ${letter}`) as HTMLInputElement;
  const type = (letter: string, value: string) => {
    fireEvent.change(option(letter), { target: { value } });
  };

  it('starts on Written with no option fields, and one click shows two', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    expect(kind('Written').checked).toBe(true);
    expect(screen.queryByLabelText('Option A')).toBeNull();
    fireEvent.click(kind('Multiple choice'));
    expect(option('A').value).toBe('');
    expect(option('B').value).toBe('');
    expect(screen.queryByLabelText('Option C')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove option/ })).toBeNull();
    expect(screen.getByText(/answer key isn’t sent, because the paper becomes public/)).toBeTruthy();
    expect(screen.queryByText(/correct answer/i)).toBeNull();
    expect(screen.getAllByRole('button').filter((button) => button.className.includes('ps-primary'))).toHaveLength(1);
  });

  it('adds up to the most options and removes down to two, with plain messages', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    fireEvent.click(kind('Multiple choice'));
    for (let i = 2; i < 6; i++) fireEvent.click(screen.getByRole('button', { name: 'Add an option' }));
    expect(option('F')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add an option' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove option F' }));
    expect(screen.queryByLabelText('Option F')).toBeNull();
    for (const letter of ['E', 'D', 'C']) fireEvent.click(screen.getByRole('button', { name: `Remove option ${letter}` }));
    expect(screen.queryByRole('button', { name: /^Remove option/ })).toBeNull();
  });

  it('refuses a blank or repeated option inline, and keeps sealing shut until they are fixed', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    await write('Which is a unit of force?');
    fireEvent.click(kind('Multiple choice'));
    type('A', 'Newton');
    expect(sealButton()?.disabled).toBe(true);
    fireEvent.blur(option('B'));
    expect(screen.getByText('Write this option, or remove it.')).toBeTruthy();
    expect(option('B').getAttribute('aria-invalid')).toBe('true');
    type('B', ' Newton ');
    expect(screen.getByText('The same as option A. Each option must be different.')).toBeTruthy();
    expect(sealButton()?.disabled).toBe(true);
    type('B', 'Joule');
    expect(screen.queryByText(/The same as option/)).toBeNull();
    expect(sealButton()?.disabled).toBe(false);
  });

  it('seals a multiple choice question with trimmed options in order, then resets the fields', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    await write('Which is a unit of force?');
    fireEvent.click(kind('Multiple choice'));
    type('A', ' Joule');
    type('B', 'Newton ');
    fireEvent.click(screen.getByRole('button', { name: 'Add an option' }));
    type('C', 'Watt');
    fireEvent.click(sealButton() as HTMLButtonElement);
    await waitFor(() => {
      expect(loadReceipts(examId)).toHaveLength(1);
    });
    expect(parseQuestion(unpadQuestion(world.opened[0] as Uint8Array))).toEqual({
      topic: 'Mechanics',
      text: 'Which is a unit of force?',
      options: ['Joule', 'Newton', 'Watt'],
    });
    await waitFor(() => {
      expect(option('A').value).toBe('');
    });
    expect(screen.queryByLabelText('Option C')).toBeNull();
    expect(kind('Multiple choice').checked).toBe(true);
  });

  it('seals a written question with no options key, even after trying multiple choice', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    fireEvent.click(kind('Multiple choice'));
    type('A', 'left over');
    fireEvent.click(kind('Written'));
    await write('What is momentum?');
    fireEvent.click(sealButton() as HTMLButtonElement);
    await waitFor(() => {
      expect(loadReceipts(examId)).toHaveLength(1);
    });
    expect(new TextDecoder().decode(unpadQuestion(world.opened[0] as Uint8Array))).toBe(
      '{"topic":"Mechanics","text":"What is momentum?"}',
    );
  });
});

describe('a question that may or may not have arrived', () => {
  beforeEach(registered);

  it('locks the words, so a retry can never mark different words as sealed', async () => {
    const world = await makeWorld();
    world.teeQuestion.mockRejectedValueOnce(new TypeError('connection reset'));
    mount(world);
    await ready();
    const area = await write('What is momentum?');
    fireEvent.click(sealButton() as HTMLButtonElement);

    const again = await screen.findByRole('button', { name: 'Send this question again' });
    expect(screen.getByText(/will not be stored twice/)).toBeTruthy();
    expect(area.readOnly).toBe(true);
    expect(area.value).toBe('What is momentum?');
    expect(screen.getAllByRole('radio').every((chip) => (chip as HTMLInputElement).matches(':disabled'))).toBe(true);
    expect(loadReceipts(examId)).toEqual([]);

    fireEvent.click(again);
    await waitFor(() => {
      expect(loadReceipts(examId)).toHaveLength(1);
    });
    expect(postedBody(world, 1).ciphertext).toBe(postedBody(world, 0).ciphertext);
    await waitFor(() => {
      expect(area.readOnly).toBe(false);
      expect(area.value).toBe('');
    });
  });

  it('never calls a question sealed when the receipt does not verify', async () => {
    const world = await makeWorld({ receiptSigner: await makeSigner() });
    mount(world);
    await ready();
    const area = await write('What is momentum?');
    fireEvent.click(sealButton() as HTMLButtonElement);
    expect(await screen.findByText(/could not confirm that this question was received/)).toBeTruthy();
    expect(area.value).toBe('What is momentum?');
    expect(screen.queryByText('Sealed')).toBeNull();
    expect(loadReceipts(examId)).toEqual([]);
    expect(screen.getByText('0 questions sealed so far')).toBeTruthy();
  });
});

describe('an expired or lost confirmation', () => {
  beforeEach(registered);

  it('checks again by itself, keeps the draft, and nothing is sent on the old one', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    const area = await write('A long question, written slowly');
    const start = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => start + CONFIRMATION_TTL_MS + 1000);
    fireEvent.click(sealButton() as HTMLButtonElement);

    await waitFor(() => {
      expect(world.verifyToken.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(world.teeQuestion).not.toHaveBeenCalled();
    expect(world.signed).toEqual([]);
    expect(area.value).toBe('A long question, written slowly');
    await ready();
    expect(await writingArea()).toBe(area);
  });

  it('checks again at about four minutes while the writer is still writing, with no pause and no second press', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const world = await makeWorld();
      mount(world);
      await ready();
      const area = await write('Still writing this one');
      const before = world.verifyToken.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMATION_REFRESH_MS + 1000);
      });
      await vi.waitFor(() => {
        expect(world.verifyToken.mock.calls.length).toBeGreaterThan(before);
      });
      // Past the old five minutes, sealing is still open and the words are still there.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRMATION_TTL_MS - CONFIRMATION_REFRESH_MS);
      });
      expect(await writingArea()).toBe(area);
      expect(area.value).toBe('Still writing this one');
      expect(sealButton()).not.toBeNull();
      fireEvent.click(sealButton() as HTMLButtonElement);
      await vi.waitFor(() => {
        expect(loadReceipts(examId)).toHaveLength(1);
      });
      expect(world.teeQuestion).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shuts sealing and keeps the draft when the sealed system shows different keys', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    await write('Already sealed');
    fireEvent.click(sealButton() as HTMLButtonElement);
    await waitFor(() => {
      expect(loadReceipts(examId)).toHaveLength(1);
    });
    await ready();
    const area = await write('Keep these words');
    const other = await makeWorld();
    (world.tee as { attestation: unknown }).attestation = other.tee.attestation;
    fireEvent.click(sealButton() as HTMLButtonElement);

    expect(await screen.findByRole('heading', { name: /can’t take your questions yet/ })).toBeTruthy();
    expect(sealButton()).toBeNull();
    expect(area.value).toBe('Keep these words');
    // Earlier questions really were sealed, so the warning must not say otherwise.
    expect(screen.getByRole('alert').textContent).not.toContain('Nothing has been sealed');
    expect(screen.getByText('1 question sealed so far')).toBeTruthy();
    expect(world.teeQuestion).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.teeQuestion).toHaveBeenCalledTimes(1);
  });
});

describe('after Lock', () => {
  beforeEach(registered);

  it('says the questions are sealed, with the count, and waits for the Build', async () => {
    const world = await makeWorld();
    world.stage.current = 'lock';
    saveReceipt(examId, await signedReceipt(world, 1));
    saveReceipt(examId, await signedReceipt(world, 2));
    mount(world);
    expect(await screen.findByRole('heading', { name: 'Your questions are sealed' })).toBeTruthy();
    expect(await screen.findByText('2 questions sealed from this browser.')).toBeTruthy();
    expect((await screen.findByText('Pending')).closest('.ps-check')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Compare/ })).toBeNull();
    expect(screen.queryByText('Pass')).toBeNull();
  });

  it('checks by itself once the Build exists, showing one Check', async () => {
    const world = await makeWorld();
    world.stage.current = 'build';
    saveReceipt(examId, await signedReceipt(world, 1));
    mount(world);
    await screen.findByText('Pending');
    world.build.current = { instancePublicKey: world.signer.publicKey };
    expect(await screen.findByText('Pass')).toBeTruthy();
    expect(document.querySelectorAll('.ps-check')).toHaveLength(1);
  });

  it('fails loudly when the receipts name a different machine from the Build', async () => {
    const world = await makeWorld();
    world.stage.current = 'unlock';
    saveReceipt(examId, await signedReceipt(world, 1));
    world.build.current = { instancePublicKey: `0x04${'bb'.repeat(64)}` };
    mount(world);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('do not match the paper that was built');
    expect(alert.textContent).toContain('Tell your exam board now');
    expect(screen.queryByRole('heading', { name: 'Your questions are sealed' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'Sealed' })).toBeNull();
  });

  it('never passes a receipt whose signature is bad, even with the right key', async () => {
    const world = await makeWorld();
    world.stage.current = 'unlock';
    saveReceipt(examId, { ...(await signedReceipt(world, 1)), teeSignature: '0x00' });
    world.build.current = { instancePublicKey: world.signer.publicKey };
    mount(world);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Pass')).toBeNull();
  });

  it('claims nothing when nothing was sealed from this browser', async () => {
    const world = await makeWorld();
    world.stage.current = 'lock';
    mount(world);
    expect(await screen.findByRole('heading', { name: 'Questions have closed' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your questions are sealed' })).toBeNull();
    expect(document.querySelector('.ps-check')).toBeNull();
  });

  it('tells the setter when the bank closed on an unsent question', async () => {
    const world = await makeWorld();
    mount(world);
    await ready();
    await write('Not finished yet');
    world.stage.current = 'lock';
    expect(await screen.findByText(/wasn’t sealed, because questions closed first/)).toBeTruthy();
    expect(screen.getByText('Not finished yet')).toBeTruthy();
  });

  it('still checks receipts once the sealed system has gone away', async () => {
    const world = await makeWorld();
    saveReceipt(examId, await signedReceipt(world, 1));
    world.build.current = { instancePublicKey: world.signer.publicKey };
    (world.tee as { status: unknown }).status = () => Promise.reject(new TypeError('gone'));
    mount(world);
    expect(await screen.findByText('Pass')).toBeTruthy();
  });

  it('says the exam failed instead of showing a check it cannot run', async () => {
    const world = await makeWorld();
    world.stage.current = 'failed';
    saveReceipt(examId, await signedReceipt(world, 1));
    mount(world);
    expect(await screen.findByRole('heading', { name: 'This exam can’t go ahead' })).toBeTruthy();
    expect(await screen.findByText('Not checked')).toBeTruthy();
  });
});

describe('the one page', () => {
  it.each(['/setter', '/setter/upload', '/setter/receipt'])('shows the same screen at %s', async (path) => {
    registered();
    const world = await makeWorld();
    mount(world, path);
    await ready();
  });

  it('keeps writing when a stage read fails for a moment', async () => {
    registered();
    const world = await makeWorld();
    mount(world);
    await ready();
    const area = await write('Keep going');
    const status = world.tee.status;
    (world.tee as { status: unknown }).status = () => Promise.reject(new TypeError('blip'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    (world.tee as { status: unknown }).status = status;
    expect(area.isConnected).toBe(true);
    expect(area.value).toBe('Keep going');
  });

  it('says plainly when the link is not set up', async () => {
    const world = await makeWorld();
    render(
      <MemoryRouter initialEntries={['/setter']}>
        <Routes>
          <Route path="/setter/*" element={<SetterArea env={{ ...world.env, tee: null }} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'This link isn’t ready yet' })).toBeTruthy();
  });
});
