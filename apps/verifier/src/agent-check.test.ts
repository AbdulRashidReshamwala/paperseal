import { describe, expect, it } from 'vitest';

import { agentCheckPrompt } from './agent-check';

const examId = `0x${'ab'.repeat(32)}`;
const fields = {
  examId,
  registry: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
  storageUrl: 'https://storage.googleapis.com/paperseal-demo',
  version: 'v1.2.3',
};

// The page shows "Check with your own AI" only when this is ok, so these decide whether it appears at all.
describe('agentCheckPrompt', () => {
  it('is ready on a page opened over https', () => {
    const result = agentCheckPrompt({ ...fields, href: `https://verify.example/#/exam/${examId}` });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain(`Verifier page: https://verify.example/?exam=${examId}`);
  });

  it('is not ready over plain http, so the page leaves the check out', () => {
    expect(agentCheckPrompt({ ...fields, href: `http://verify.example/?exam=${examId}` })).toEqual({
      ok: false,
      reason: 'This page must be opened over https.',
    });
  });

  it('is ready on a local copy of the page, which never leaves this machine', () => {
    expect(agentCheckPrompt({ ...fields, href: `http://localhost:5172/?exam=${examId}` }).ok).toBe(true);
  });

  it('is not ready without an exam', () => {
    expect(agentCheckPrompt({ ...fields, examId: null, href: 'https://verify.example/' })).toEqual({ ok: false, reason: 'Open an exam first.' });
  });
});
