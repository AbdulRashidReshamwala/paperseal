import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const css = readFileSync(join(here, 'tokens.css'), 'utf8');
const fonts = readFileSync(join(here, 'fonts.css'), 'utf8');

function hexTokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--ps-[a-z-]+):\s*(#[0-9a-f]{6});/g)].map((match) => [match[1], match[2]]));
}

function blockAfter(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

const light = hexTokens(blockAfter(':root'));
const dark = hexTokens(blockAfter(":root[data-theme='dark']"));

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string | undefined, b: string | undefined): number {
  if (!a || !b) throw new Error('missing token');
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ['--ps-ink', '--ps-ink-soft', '--ps-seal-ink', '--ps-pass', '--ps-pending', '--ps-fail'];

describe.each([
  ['paper', light],
  ['carbon paper', dark],
])('%s contrast', (_name, tokens) => {
  it.each(TEXT)('%s is AA on paper and on deep paper', (token) => {
    expect(contrast(tokens[token], tokens['--ps-paper'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens[token], tokens['--ps-paper-deep'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens[token], tokens['--ps-field'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps text on wax AA, resting and hovered', () => {
    expect(contrast(tokens['--ps-on-wax'], tokens['--ps-wax'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['--ps-on-wax'], tokens['--ps-wax-deep'])).toBeGreaterThanOrEqual(4.5);
  });

  it('gives controls a 3:1 edge against paper', () => {
    expect(contrast(tokens['--ps-rule-strong'], tokens['--ps-paper'])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens['--ps-wax'], tokens['--ps-paper'])).toBeGreaterThanOrEqual(3);
  });
});

describe('tokens.css', () => {
  it('stays on paper whatever the operating system prefers', () => {
    expect(css).not.toContain('prefers-color-scheme');
    expect(blockAfter(':root')).toMatch(/color-scheme: light;/);
  });

  it('keeps carbon paper behind an explicit data-theme only', () => {
    expect(blockAfter(":root[data-theme='dark']")).toMatch(/color-scheme: dark;/);
    expect(css.match(/\[data-theme/g)).toHaveLength(1);
    expect(light['--ps-paper']).toBe('#f3ecdf');
    expect(dark['--ps-paper']).toBe('#12141b');
  });

  it('keeps the older token names', () => {
    for (const name of ['bg', 'surface', 'text', 'muted', 'border', 'accent', 'accent-text', 'ok', 'warn', 'bad', 'radius', 'font', 'mono', 'text-small', 'text-code']) {
      expect(css).toContain(`--ps-${name}:`);
    }
  });

  it('keeps wax off the step in progress, since students read red as an error', () => {
    const current = [...css.matchAll(/\.ps-step\[data-state='current'\][^{]*\{[^}]*\}/g)].map((match) => match[0]).join('');
    expect(current).not.toBe('');
    expect(current).not.toMatch(/--ps-(wax|seal-ink|fail)/);
  });

  it('prints step times as plain numbers, not code', () => {
    expect(blockAfter('.ps-step-when')).not.toContain('--ps-code');
    expect(blockAfter('.ps-step-when')).toContain('tabular-nums');
  });

  // A badge's 1px corner is a printed edge, not a rounded one, so only soft corners must use the token.
  it('rounds soft corners only with the radius token', () => {
    expect(css).not.toMatch(/border-radius:\s*([2-9]|\d{2,})px/);
  });

  it('turns motion off under reduced motion', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('animation: none');
    expect(block).toContain('transition: none');
  });

  it('upper-cases only the stamp, so everything else reads as written', () => {
    expect(css.match(/text-transform/g)).toHaveLength(1);
    expect(blockAfter('.ps-stamp')).toContain('text-transform');
  });
});

describe('fonts', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const families = [...fonts.matchAll(/@import '(@fontsource\/[a-z-]+)\//g)].map((match) => match[1] ?? '');

  it('pins every font package to an exact version', () => {
    expect(families.length).toBeGreaterThan(0);
    for (const family of new Set(families)) expect(pkg.dependencies[family]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('loads nothing from another host', () => {
    expect(`${css}${fonts}`).not.toMatch(/https?:\/\//);
    const require = createRequire(join(here, 'tokens.css'));
    for (const file of [...fonts.matchAll(/@import '(@fontsource\/[^']+)'/g)].map((match) => match[1] ?? '')) {
      const path = require.resolve(file);
      expect(readFileSync(path, 'utf8')).not.toMatch(/url\(\s*['"]?https?:/);
      expect(dirname(path)).toContain('@fontsource');
    }
  });
});
