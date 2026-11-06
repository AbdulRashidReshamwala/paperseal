import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Check,
  Countdown,
  formatRemaining,
  Hash,
  KeyTouch,
  Page,
  PrimaryAction,
  RoleHeader,
  Seal,
  securityKeyProblem,
  shortenHash,
  Stage,
  Stamp,
  Stepper,
  VIRTUAL_KEY_HINT,
  type CheckStatus,
  type KeyTouchState,
  type SealState,
  type Step,
} from './index';

const noop = () => {
  return;
};
const credentials = {};
const named = (name: string) => Object.assign(new Error(name), { name });
const coded = (code: string) => Object.assign(new Error(code), { name: 'KeyError', code });

describe('RoleHeader', () => {
  it('leaves the exam out until there is one', () => {
    expect(renderToString(<RoleHeader role="Setter" />)).not.toContain('ps-role-exam');
  });
});

describe('Stage', () => {
  it('shows one title, the action and what happens next', () => {
    const html = renderToString(
      <Page header={<RoleHeader role="Setter" />}>
        <Stage title="Add a question" action={<PrimaryAction>Seal</PrimaryAction>} next="It goes into the bank." />
      </Page>,
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.match(/ps-primary"/g)).toHaveLength(1);
    expect(html).toContain('What happens next');
    expect(html).toContain('It goes into the bank.');
    expect(html).toContain('<main>');
  });

  it('works with nothing to do but wait', () => {
    const html = renderToString(<Stage title="Nothing to do yet" next="We will ask you when it is time." />);
    expect(html).not.toContain('ps-stage-action');
    expect(html).toContain('We will ask you when it is time.');
  });

  it('shows the seal in the state it is given', () => {
    expect(renderToString(<Stage title="T" next="N" seal="opening" />)).toContain('data-state="opening"');
    expect(renderToString(<Stage title="T" next="N" />)).not.toContain('ps-seal');
  });
});

describe('PrimaryAction', () => {
  it('announces busy and stays focusable', () => {
    const html = renderToString(
      <PrimaryAction status="busy" busyLabel="Sealing">
        Seal
      </PrimaryAction>,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('Sealing');
  });

  it('shows done in words', () => {
    const html = renderToString(
      <PrimaryAction status="done" doneLabel="Sealed">
        Seal
      </PrimaryAction>,
    );
    expect(html).toContain('data-status="done"');
    expect(html).toContain('Sealed');
  });
});

describe('securityKeyProblem', () => {
  it('reads a failed request with no key as no key', () => {
    for (const name of ['NotAllowedError', 'NotSupportedError', 'AbortError', 'TimeoutError']) {
      expect(securityKeyProblem(named(name), credentials)).toBe('no-key');
    }
  });

  it('knows when a page cannot reach a key at all', () => {
    expect(securityKeyProblem(named('NotAllowedError'), undefined)).toBe('unsupported');
    expect(securityKeyProblem(named('SecurityError'), credentials)).toBe('unsupported');
  });

  it('knows a key that cannot be used', () => {
    for (const code of ['prf_unavailable', 'synced_passkey', 'unsupported_key']) {
      expect(securityKeyProblem(coded(code), credentials)).toBe('wrong-key');
    }
  });

  it('does not guess at anything else', () => {
    expect(securityKeyProblem(new Error('boom'), credentials)).toBe('other');
    expect(securityKeyProblem('boom', credentials)).toBe('other');
  });
});

describe('KeyTouch', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { credentials });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const render = (state: KeyTouchState, extra: { error?: unknown; demo?: boolean; purpose?: string } = {}) =>
    renderToString(<KeyTouch state={state} onUse={noop} {...extra} />);

  it('says security key in every state, never passkey', () => {
    const states: KeyTouchState[] = ['idle', 'waiting', 'success', 'failed'];
    for (const state of states) {
      const html = render(state).toLowerCase();
      expect(html).toContain('security key');
      expect(html).not.toContain('passkey');
      expect(html).not.toContain('authenticator');
    }
  });

  it('has a button to start and to retry, and none while it waits or after success', () => {
    expect(render('idle')).toContain('Use security key');
    expect(render('failed')).toContain('Try again');
    expect(render('waiting')).not.toContain('<button');
    expect(render('success')).not.toContain('<button');
  });

  it('adds the purpose to the prompt', () => {
    expect(render('idle', { purpose: 'to open the paper' })).toContain('Use your security key to open the paper');
  });

  it('shows the pnpm demo hint only when no key answered', () => {
    expect(VIRTUAL_KEY_HINT).toContain('pnpm demo');
    expect(VIRTUAL_KEY_HINT).not.toContain('DevTools');
    const hint = 'pnpm demo';
    expect(render('failed', { error: named('NotAllowedError') })).toContain(hint);
    expect(render('idle')).not.toContain(hint);
    expect(render('failed', { error: new Error('boom') })).not.toContain(hint);
  });

  it('hides the hint outside the demo', () => {
    expect(render('failed', { error: named('NotAllowedError'), demo: false })).not.toContain('pnpm demo');
  });

  it('raises failure as an alert', () => {
    expect(render('failed', { error: named('NotAllowedError') })).toContain('role="alert"');
  });
});

describe('Stepper', () => {
  const steps: Step[] = [
    { id: 'a', label: 'Assembled', state: 'done', when: '4 Nov, 09:12', evidence: <span>the proof</span> },
    { id: 'b', label: 'Time seal', state: 'current', when: 'Round 33,700,743' },
    { id: 'c', label: 'Unlocked', state: 'waiting' },
    { id: 'd', label: 'Receipts', state: 'not-applicable' },
    { id: 'e', label: 'Proof', state: 'failed', note: 'It did not match.' },
  ];
  const html = renderToString(<Stepper steps={steps} />);

  it('is an ordered list with one current step', () => {
    expect(html).toContain('<ol');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it('prints every state in words, so colour never carries it alone', () => {
    for (const word of ['Done', 'In progress', 'Waiting', 'Not applicable', 'Failed']) expect(html).toContain(word);
  });

  it('prints the time or round, and any note', () => {
    expect(html).toContain('4 Nov, 09:12');
    expect(html).toContain('Round 33,700,743');
    expect(html).toContain('It did not match.');
  });

  it('folds evidence away, only on steps that have it', () => {
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('the proof');
  });
});

describe('Seal', () => {
  it.each<[SealState, string]>([
    ['sealed', 'Sealed'],
    ['opening', 'Opening'],
    ['open', 'Open'],
    ['broken', 'Broken'],
  ])('names the %s state in words', (state, word) => {
    const html = renderToString(<Seal state={state} />);
    expect(html).toContain(`data-state="${state}"`);
    expect(html).toContain(`aria-label="${word}"`);
    expect(html).toContain('role="img"');
  });

  it('takes a label and an optional caption', () => {
    const html = renderToString(<Seal state="sealed" label="Paper is sealed" caption />);
    expect(html).toContain('aria-label="Paper is sealed"');
    expect(html).toContain('<figcaption>Sealed</figcaption>');
  });

  it('keeps clip ids safe and distinct across seals', () => {
    const html = renderToString(
      <>
        <Seal state="sealed" />
        <Seal state="open" />
      </>,
    );
    const ids = [...html.matchAll(/<clipPath id="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it('stamps only when asked', () => {
    expect(renderToString(<Seal state="sealed" />)).not.toContain('data-stamp');
    expect(renderToString(<Seal state="sealed" stamp />)).toContain('data-stamp="true"');
    expect(renderToString(<Stamp>Sealed</Stamp>)).toContain('Sealed');
  });
});

describe('Check', () => {
  it.each<[CheckStatus, string]>([
    ['pass', 'Pass'],
    ['fail', 'Fail'],
    ['pending', 'Pending'],
    ['not-checked', 'Not checked'],
  ])('shows %s with a word and an icon', (status, word) => {
    const html = renderToString(<Check status={status} />);
    expect(html).toContain(word);
    expect(html).toContain('<svg');
    expect(html).toContain(`data-status="${status}"`);
  });

  it('prints a reason beside the word', () => {
    expect(renderToString(<Check status="fail">Signature did not match</Check>)).toContain('Signature did not match');
  });
});

describe('shortenHash', () => {
  it('keeps both ends', () => {
    expect(shortenHash('0x38223aaacebb6b38a4ae87d63a4d77692d76')).toBe('0x38223a…692d76');
  });

  it('leaves a short value alone', () => {
    expect(shortenHash('0x1234')).toBe('0x1234');
    expect(shortenHash('a'.repeat(15))).toBe('a'.repeat(15));
  });
});

describe('Hash', () => {
  it('shows the short form and keeps the full value on hover and for screen readers', () => {
    const value = `0x${'ab'.repeat(32)}`;
    const html = renderToString(<Hash value={value} label="paper fingerprint" />);
    expect(html).toContain(shortenHash(value));
    expect(html).toContain(`title="${value}"`);
    expect(html).toContain(`aria-label="Copy paper fingerprint: ${value}"`);
    expect(html).not.toContain('ps-hash-full');
  });
});

describe('formatRemaining', () => {
  it('pads minutes and seconds', () => {
    expect(formatRemaining(0)).toBe('0:00:00');
    expect(formatRemaining(3723)).toBe('1:02:03');
  });

  it('adds days', () => {
    expect(formatRemaining(2 * 86400 + 3723)).toBe('2d 1:02:03');
  });

  it('never goes negative', () => {
    expect(formatRemaining(-5)).toBe('0:00:00');
  });
});

describe('Countdown', () => {
  const at = Date.UTC(2026, 10, 6, 9, 59);
  const render = (nowMs: number) =>
    renderToString(
      <Countdown at={at} round={33700743} label="Paper unlocks" reached="Open now" now={() => nowMs} locale="en-GB" timeZone="UTC" />,
    );

  it('shows the time left and the clock time, not the round', () => {
    const html = render(at - 3723_000);
    expect(html).toContain('1:02:03');
    expect(html).toContain('09:59');
    expect(html).not.toContain('33,700,743');
    expect(html).toContain('role="timer"');
  });

  it('says so once the moment has passed', () => {
    const html = render(at + 1000);
    expect(html).toContain('Open now');
    expect(html).toContain('data-reached="true"');
  });

  it('keeps technical names off this surface', () => {
    expect(render(at - 1000).toLowerCase()).not.toContain('drand');
  });
});
