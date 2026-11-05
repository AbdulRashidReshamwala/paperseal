// @vitest-environment jsdom
import { setterCommitment } from '@paperseal/protocol';
import type { Hex } from '@paperseal/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ownerProblem, Register } from './Register';

const examId: Hex = `0x${'11'.repeat(32)}`;
const commitment = setterCommitment(new Uint8Array(32).fill(0x11), 'Asha Rao', new Uint8Array(32).fill(1));
const tee = { registerChallenge: vi.fn(), register: vi.fn() };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('owner validation', () => {
  it('requires a commitment for setters and leaves names for everyone else', () => {
    expect(ownerProblem('setter', commitment)).toBeNull();
    expect(ownerProblem('setter', `  ${commitment}  `)).toBeNull();
    for (const bad of ['Asha Rao', '0x1234', commitment.toUpperCase(), commitment.slice(2)]) {
      expect(ownerProblem('setter', bad)).toMatch(/not a commitment/);
    }
    expect(ownerProblem('holder', 'Centre One')).toBeNull();
  });
});

describe('Register', () => {
  const mount = (role: 'setter' | 'holder') =>
    render(<Register role={role} examId={examId} tee={tee} keys={{ register: vi.fn() }} />);

  it('asks a setter for the commitment from the invite and blocks a name', () => {
    localStorage.clear();
    mount('setter');
    const field = screen.getByLabelText(/Commitment from your invite/);
    const button = screen.getByText('Create passkey and register') as HTMLButtonElement;
    fireEvent.change(field, { target: { value: 'Asha Rao' } });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/This is not a commitment/)).toBeTruthy();
    fireEvent.change(field, { target: { value: commitment } });
    expect(button.disabled).toBe(false);
    expect(screen.queryByText(/This is not a commitment/)).toBeNull();
  });

  it('keeps names for key holders and centres', () => {
    localStorage.clear();
    mount('holder');
    fireEvent.change(screen.getByLabelText('Name on the approved list'), { target: { value: 'Centre One' } });
    expect((screen.getByText('Create passkey and register') as HTMLButtonElement).disabled).toBe(false);
  });
});
