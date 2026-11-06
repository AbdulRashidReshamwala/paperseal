// @vitest-environment jsdom
import { TeeApiError, type ReleaseLogResponse } from '@paperseal/tee-client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tee } from '../../shared/tee';
import { LogView, UnlockLog } from './Log';
import type { LogVerdict } from './logCheck';

vi.mock('../../shared/registry', () => ({
  registry: { getApprovedListEntries: vi.fn(() => Promise.resolve(null)) },
  envExamId: `0x${'11'.repeat(32)}`,
  notConnectedToChain: '',
}));
vi.mock('../../shared/config', () => ({ storageUrl: null, teeStorageBucket: '' }));
vi.mock('../../shared/tee', () => ({ tee: { releaseLog: vi.fn() } }));

afterEach(cleanup);

const key = `0x04${'ab'.repeat(64)}`;
const log = {
  examId: `0x${'11'.repeat(32)}`,
  entries: [{ passkeyPublicKey: key, shareHash: `0x${'22'.repeat(32)}`, round: '123' }],
  entriesHash: '0x00',
  files: [],
  filesHash: '0x00',
  teeSignature: '0x00',
  instancePublicKey: '0x04',
} as ReleaseLogResponse;
const verdict = (pass: boolean): LogVerdict => ({
  pass,
  entriesHash: pass,
  files: pass,
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
    expect(screen.getAllByText('Pass')).toHaveLength(5);
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

  it('shows the check on the list of files', () => {
    render(<LogView log={log} owners={owners} problem={null} verdict={{ ...verdict(true), pass: false, files: false }} />);
    const row = screen.getByText('The list of files is complete').closest('li');
    expect(row?.textContent).toContain('Fail');
  });
});

describe('UnlockLog', () => {
  const releaseLog = vi.mocked(tee as NonNullable<typeof tee>).releaseLog;

  it('says the log is being prepared, not that it failed, between the threshold and the delivery', async () => {
    releaseLog.mockRejectedValue(new TeeApiError(503, 'delivery_pending', 'not ready'));
    render(<UnlockLog />);
    await waitFor(() => {
      expect(screen.getByText(/still being prepared/)).toBeTruthy();
    });
    expect(screen.queryByText(/can't be read/)).toBeNull();
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('still says when the log cannot be read', async () => {
    releaseLog.mockRejectedValue(new TeeApiError(500, 'internal', 'broken'));
    render(<UnlockLog />);
    await waitFor(() => {
      expect(screen.getByText(/can't be read right now/)).toBeTruthy();
    });
    expect(screen.queryByText(/still being prepared/)).toBeNull();
  });
});
