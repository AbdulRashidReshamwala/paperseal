import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AppShell, ChromiumGate, Logo, Page, RoleHeader, Wordmark } from './index';
import { LOGO_SEAL } from './logoPaths';

const root = join(import.meta.dirname, '..', '..', '..');

describe('Logo', () => {
  it('has a title that names it', () => {
    const html = renderToString(<Logo />);
    expect(html).toContain('role="img"');
    const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<title id="${id ?? ''}">Paper Seal</title>`);
  });

  it('is hidden when decorative', () => {
    const html = renderToString(<Logo decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<title');
    expect(html).not.toContain('role="img"');
  });

  it('marks its tone and takes a size', () => {
    expect(renderToString(<Logo />)).toContain('data-tone="colour"');
    const html = renderToString(<Logo tone="mono" size={16} />);
    expect(html).toContain('data-tone="mono"');
    expect(html).toContain('width="16"');
  });

  it('stays on the two colours through tokens', () => {
    const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');
    expect(renderToString(<Logo />)).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(css).toMatch(/\.ps-logo-wax {\s+fill: var\(--ps-wax\);/);
    expect(css).toMatch(/\.ps-logo\[data-tone='mono'\] \.ps-logo-wax {\s+fill: currentColor;/);
  });

  it('draws the flat mark as one closed evenodd path on the 32 grid', () => {
    expect(LOGO_SEAL.startsWith('M')).toBe(true);
    expect(LOGO_SEAL.endsWith('Z')).toBe(true);
    const numbers = (LOGO_SEAL.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    expect(numbers.length).toBeGreaterThan(20);
    expect(numbers.every((n) => n >= 0 && n <= 32)).toBe(true);
    const html = renderToString(<Logo size={16} />);
    expect(html).toContain('viewBox="0 0 32 32"');
    expect(html).toContain('fill-rule="evenodd"');
    expect(html).toContain(`d="${LOGO_SEAL}"`);
  });

  it('shows the realistic seal as an image from 48px, named by its title', () => {
    const html = renderToString(<Logo size={96} title="Seal" />);
    expect(html).toContain('<img');
    expect(html).toContain('width="96"');
    expect(html).toContain('alt="Seal"');
    expect(html).toContain('class="ps-logo"');
    const hidden = renderToString(<Logo size={48} decorative />);
    expect(hidden).toContain('alt=""');
    expect(hidden).toContain('aria-hidden="true"');
  });

  it('keeps the mono tone flat at any size', () => {
    const html = renderToString(<Logo size={96} tone="mono" />);
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
  });
});

describe('Wordmark', () => {
  it('names itself once, in words', () => {
    const html = renderToString(<Wordmark />);
    expect(html.match(/Paper Seal/g)).toHaveLength(1);
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('where the logo appears', () => {
  it.each([
    ['RoleHeader', <RoleHeader key="role" role="Setter" />],
    ['Page without a header', <Page key="page">Body</Page>],
    ['AppShell', <AppShell key="shell" name="Verifier" nav={null}>Body</AppShell>],
    ['ChromiumGate', <ChromiumGate key="gate" nav={{}}>Body</ChromiumGate>],
  ])('%s carries the mark and has no dot', (_name, element) => {
    const html = renderToString(element);
    expect(html).toContain('ps-logo');
    expect(html).not.toContain('ps-role-dot');
  });

  it('keeps the words Paper Seal in the header', () => {
    expect(renderToString(<RoleHeader role="Setter" />)).toContain('Paper Seal');
  });
});

describe.each(['web', 'verifier'])('apps/%s icons', (app) => {
  const publicDir = join(root, 'apps', app, 'public');
  const html = readFileSync(join(root, 'apps', app, 'index.html'), 'utf8');

  it('repeats the exact paths of the mark', () => {
    const svg = readFileSync(join(publicDir, 'favicon.svg'), 'utf8');
    expect(svg).toContain(`d="${LOGO_SEAL}"`);
  });

  it.each([
    ['favicon-32.png', 32],
    ['apple-touch-icon.png', 180],
  ])('ships %s at %ipx', (file, size) => {
    const png = readFileSync(join(publicDir, file));
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  });

  it('wires them into index.html on the paper colour', () => {
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('href="/favicon-32.png"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain('name="theme-color" content="#f3ecdf"');
    expect(html).toMatch(/<title>Paper Seal[^<]*<\/title>/);
  });
});
