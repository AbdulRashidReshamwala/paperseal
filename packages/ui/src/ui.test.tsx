import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Badge, ChromiumGate, Connected, isChromium } from './index';

const chrome = { userAgentData: { brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }] } };
const firefox = {};

describe('isChromium', () => {
  it('needs the Chromium brand', () => {
    expect(isChromium(chrome)).toBe(true);
    expect(isChromium({ userAgentData: { brands: [{ brand: 'Other' }] } })).toBe(false);
    expect(isChromium(firefox)).toBe(false);
    expect(isChromium(undefined)).toBe(false);
  });
});

describe('ChromiumGate', () => {
  it('renders children on Chromium', () => {
    const html = renderToString(<ChromiumGate nav={chrome}>inside</ChromiumGate>);
    expect(html).toContain('inside');
  });

  it('blocks other browsers', () => {
    const html = renderToString(<ChromiumGate nav={firefox}>inside</ChromiumGate>);
    expect(html).not.toContain('inside');
    expect(html).toContain('Chromium required');
  });
});

describe('Connected', () => {
  it('shows the not-connected state without a source', () => {
    const html = renderToString(
      <Connected title="TEE" notConnected="Set VITE_TEE_URL." load={null}>
        {() => 'value'}
      </Connected>,
    );
    expect(html).toContain('TEE: not connected');
    expect(html).toContain('Set VITE_TEE_URL.');
  });
});

describe('Badge', () => {
  it('carries its tone', () => {
    expect(renderToString(<Badge tone="ok">ok</Badge>)).toContain('data-tone="ok"');
  });
});
