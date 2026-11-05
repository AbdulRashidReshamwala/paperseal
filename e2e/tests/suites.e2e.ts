import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { repoRoot } from '../src/chain';
import { launchChrome } from '../src/recorder';
import { recordSuite } from '../src/terminal';

/* Work with no UI: the real test commands, streamed live into a terminal page that is recorded. */

let browser: Browser;
beforeAll(async () => {
  browser = await launchChrome();
});
afterAll(async () => {
  await browser?.close();
});

const noFailures = (output: string, pattern: RegExp, what: string) => {
  const match = pattern.exec(output);
  if (!match) throw new Error(`no ${what} summary in the output`);
  return match[0];
};

describe('test suites', () => {
  it('contracts-tests', async () => {
    await recordSuite(browser, {
      name: 'contracts-tests',
      title: 'forge test in contracts/',
      display: 'cd contracts && forge test',
      cwd: resolve(repoRoot, 'contracts'),
      command: 'forge',
      args: ['test'],
      outputChecks: [
        {
          label: 'forge reports tests passed and none failed',
          run: (o) => {
            const line = noFailures(o, /\d+ tests passed, 0 failed, \d+ skipped/, 'forge');
            return line;
          },
        },
      ],
    });
  });

  it('tee-tests', async () => {
    await recordSuite(browser, {
      name: 'tee-tests',
      title: 'go test -count=1 ./... in tee/',
      display: 'cd tee && go test -count=1 ./...',
      cwd: resolve(repoRoot, 'tee'),
      command: 'go',
      args: ['test', '-count=1', './...'],
      outputChecks: [
        {
          label: 'go test printed no FAIL line',
          run: (o) => {
            if (/^(--- )?FAIL/m.test(o)) throw new Error('a FAIL line is in the output');
            const ok = (o.match(/^ok\s/gm) ?? []).length;
            if (ok === 0) throw new Error('no package reported ok');
            return `${String(ok)} packages ok`;
          },
        },
      ],
    });
  });

  it('packages-tests', async () => {
    await recordSuite(browser, {
      name: 'packages-tests',
      title: 'pnpm tests of every package, with the tee/ cross-language vectors',
      display: 'pnpm --filter "./packages/*" --workspace-concurrency=1 test --reporter=verbose',
      cwd: repoRoot,
      command: 'pnpm',
      args: ['--filter', './packages/*', '--workspace-concurrency=1', 'test', '--reporter=verbose'],
      outputChecks: [
        {
          label: 'tee/testdata/vectors.json exists and the cross-language vector tests ran and passed',
          run: (o) => {
            if (!existsSync(resolve(repoRoot, 'tee/testdata/vectors.json'))) throw new Error('vectors.json is missing');
            if (!/✓[^\n]*tee\/ cross-language vectors[^\n]*approved list encoding and hash/.test(o)) throw new Error('the approved-list vector test did not show as passed');
            if (!/✓[^\n]*tee\/ cross-language vectors[^\n]*matches tee\/ for /.test(o)) throw new Error('no per-message vector test showed as passed');
            if (/↓[^\n]*cross-language vectors/.test(o)) throw new Error('a vector test was skipped');
            return 'vector tests passed, none skipped';
          },
        },
      ],
    });
  });

  it('web-tests', async () => {
    await recordSuite(browser, {
      name: 'web-tests',
      title: 'pnpm test for apps/web and apps/verifier',
      display: 'pnpm --filter @paperseal/web --filter @paperseal/verifier --workspace-concurrency=1 test',
      cwd: repoRoot,
      command: 'pnpm',
      args: ['--filter', '@paperseal/web', '--filter', '@paperseal/verifier', '--workspace-concurrency=1', 'test'],
      outputChecks: [
        {
          label: 'vitest reports tests passed and none failed',
          run: (o) => {
            if (/Tests\s+.*\d+ failed/.test(o)) throw new Error('vitest reports failures');
            return noFailures(o, /Tests\s+\d+ passed[^\n]*/, 'vitest');
          },
        },
      ],
    });
  });
});
