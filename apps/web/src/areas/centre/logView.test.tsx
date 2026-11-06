// @vitest-environment jsdom
import type { ReleaseLogResponse } from '@paperseal/tee-client';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LogView } from './Log';
import type { LogVerdict } from './logCheck';

afterEach(cleanup);

const key = `0x04${'ab'.repeat(64)}`;
const log = {
  examId: `0x${'11'.repeat(32)}`,
  entries: [{ passkeyPublicKey: key, shareHash: `0x${'22'.repeat(32)}`, round: '123' }],
  entriesHash: '0x00',
  teeSignature: '0x00',
  instancePublicKey: '0x04',
} as ReleaseLogResponse;
const verdict = (pass: boolean): LogVerdict => ({
  pass,
  entriesHash: pass,
  signature: pass,
  token: { passed: pass, failures: pass ? [] : ['release-token.jwt is not available.'] },
  exam: true,
});
const owners = new Map([[key, 'Centre One']]);

describe('LogView', () => {
  it('shows entries as fact when the verdict passes', () => {
    render(<LogView log={log} owners={owners} problem={null} verdict={verdict(true)} />);
    expect(screen.getByText('Centre One').closest('li')?.getAttribute('data-muted')).toBeNull();
    expect(screen.queryByText(/do not rely on the entries/)).toBeNull();
    expect(screen.getAllByText('Pass')).toHaveLength(4);
    expect(screen.queryByText('Fail')).toBeNull();
  });

  it('mutes entries and says why when the verdict fails', () => {
    render(<LogView log={log} owners={owners} problem={null} verdict={verdict(false)} />);
    expect(screen.getByText('Centre One').closest('li')?.getAttribute('data-muted')).toBe('true');
    expect(screen.getByText(/do not rely on the entries/)).toBeTruthy();
    expect(screen.getAllByText('Fail').length).toBeGreaterThan(0);
  });

  it('shows a passkey, not a name, when the on-chain list could not be trusted', () => {
    render(<LogView log={log} owners={new Map()} problem="The on-chain list's bytes could not be trusted." verdict={verdict(true)} />);
    expect(screen.getByText(key)).toBeTruthy();
    expect(screen.getByText(/could not be trusted/)).toBeTruthy();
  });
});
