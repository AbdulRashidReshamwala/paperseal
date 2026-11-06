// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentCheck } from './agent-check';

afterEach(cleanup);

const examId = `0x${'ab'.repeat(32)}`;

describe('AgentCheck', () => {
  it('is disabled, and says why, without a release tag', () => {
    render(
      <AgentCheck
        examId={examId}
        registry={`0x${'12'.repeat(20)}`}
        storageUrl="https://storage.example"
        version=""
        href={`https://verify.example/#/exam/${examId}`}
      />,
    );
    expect(screen.getByRole('button', { name: 'Check with your own AI' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/without a release version/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /github\.com\// })).toBeTruthy();
  });
});
