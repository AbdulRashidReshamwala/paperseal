import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { criteriaHash, encodeApprovedList, approvedListHash, encodeCriteria, fromHex, toHex, type Hex } from '@paperseal/protocol';
import { App, routes } from './App';
import { chainChecks } from './checks';
import {
  clearSettings,
  connect,
  defaultSettings,
  loadSettings,
  saveSettings,
  SettingsProvider,
  validateSettings,
  type Settings,
} from './settings';

const src = import.meta.dirname;
const custom: Settings = {
  rpcUrl: 'https://my-rpc.example/v1',
  teeUrl: 'https://tee.example',
  registryAddress: `0x${'ab'.repeat(20)}`,
  examId: `0x${'11'.repeat(32)}`,
};

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const render = (path: string, initial = defaultSettings) =>
  renderToString(
    <SettingsProvider initial={initial}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </SettingsProvider>,
  );

describe('routes', () => {
  it.each([
    ['/', 'Chain checks: not connected'],
    ['/attestation', 'Fresh attestation: optional'],
    ['/commitments', 'ExamRegistry: not connected'],
    ['/unlock', 'Release log: optional'],
    ['/proof', 'No proof yet'],
    ['/settings', 'Sepolia RPC URL'],
  ])('%s shows %s with no sign-in', (path, text) => {
    const html = render(path);
    expect(html).toContain(text);
    expect(html).not.toMatch(/sign in/i);
  });

  it('Overview with no TEE URL shows no failure and only neutral TEE wording', () => {
    const html = render('/', { ...defaultSettings, teeUrl: '' });
    expect(html).toContain('Live TEE status: optional');
    expect(html).toContain('Needs a TEE URL');
    expect(html).toContain('Set the RPC URL, ExamRegistry address and exam ID');
    expect(html).not.toMatch(/TEE: not connected|unavailable|\bFail\b|data-tone="bad"/);
  });

  it('Unlock and Attestation say they need a TEE URL without implying a fault', () => {
    for (const path of ['/unlock', '/attestation']) {
      const html = render(path, { ...defaultSettings, teeUrl: '' });
      expect(html).toContain('Needs a TEE URL');
      expect(html).not.toMatch(/unavailable|\bFail\b|data-tone="bad"/);
    }
  });

  it('Connection labels the TEE URL optional', () => {
    const html = render('/settings');
    expect(html).toContain('TEE URL (optional)');
    expect(html).toContain('fresh attestation and live release progress');
  });

  it('lists every route in the navigation', () => {
    const html = render('/');
    for (const { label } of routes) expect(html).toContain(label);
  });
});

describe('runtime settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saved values override build-time defaults and survive a reload', () => {
    const storage = memoryStorage();
    expect(loadSettings(storage)).toEqual(defaultSettings);
    saveSettings(custom, storage);
    expect(loadSettings(storage)).toEqual(custom);
    clearSettings(storage);
    expect(loadSettings(storage)).toEqual(defaultSettings);
  });

  it('ignores corrupt or unsafe stored values', () => {
    const storage = memoryStorage();
    storage.setItem('paperseal.verifier.settings', 'not json');
    expect(loadSettings(storage)).toEqual(defaultSettings);
    saveSettings({ ...custom, rpcUrl: 'javascript:alert(1)' }, storage);
    expect(loadSettings(storage)).toEqual(defaultSettings);
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadSettings(broken)).toEqual(defaultSettings);
    expect(() => {
      saveSettings(custom, broken);
      clearSettings(broken);
    }).not.toThrow();
  });

  it('validates each field and allows empty', () => {
    expect(validateSettings(custom)).toEqual({});
    expect(validateSettings({ rpcUrl: '', teeUrl: '', registryAddress: '', examId: '' })).toEqual({});
    expect(
      Object.keys(
        validateSettings({ rpcUrl: 'ftp://x', teeUrl: 'nope', registryAddress: '0x1', examId: '0x2' }),
      ).sort(),
    ).toEqual(['examId', 'registryAddress', 'rpcUrl', 'teeUrl']);
  });

  it('calls the endpoints the viewer chose', async () => {
    const fetch = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
      void url;
      return Promise.resolve(new Response(JSON.stringify({ result: `0x${'00'.repeat(20)}`, id: 1, jsonrpc: '2.0' })));
    });
    vi.stubGlobal('fetch', fetch);
    const { tee, registry } = connect(custom);
    await tee?.status();
    await registry?.board().catch(() => undefined);
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls).toContain('https://tee.example/v1/status');
    expect(urls).toContain('https://my-rpc.example/v1');
  });

  it('connects to nothing until settings exist', () => {
    expect(connect({ rpcUrl: '', teeUrl: '', registryAddress: '', examId: '' })).toEqual({
      tee: null,
      registry: null,
      examId: null,
    });
  });
});

describe('independent hosting', () => {
  const sources = readdirSync(src)
    .filter((file) => !file.endsWith('.test.tsx'))
    .map((file) => readFileSync(join(src, file), 'utf8'))
    .join('\n');

  it('does not depend on passkeys or apps/web', () => {
    const manifest = JSON.parse(readFileSync(join(src, '../package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const names = Object.keys(manifest.dependencies);
    expect(names).not.toContain('@paperseal/keys');
    expect(names).not.toContain('@paperseal/web');
    expect(names).not.toContain('@paperseal/crypto');
    expect(sources).not.toMatch(/@paperseal\/keys|apps\/web|navigator\.credentials/);
  });

  it('builds with relative asset paths', () => {
    expect(readFileSync(join(src, '../vite.config.ts'), 'utf8')).toContain("base: './'");
  });
});

describe('commitments logic', () => {
  const id = `0x${'11'.repeat(32)}` as Hex;
  const encoded = encodeCriteria({
    maxSetterPercent: 30,
    minBankMultiple: 3,
    topics: [{ name: 'Maths', questions: 5 }],
  });
  const listBytes = encodeApprovedList([]);
  const data = (criteriaOk: boolean, listOk: boolean, build: boolean) =>
    ({
      exam: { settings: { criteriaHash: criteriaOk ? toHex(criteriaHash(encoded)) : `0x${'00'.repeat(32)}` } },
      list: { listHash: listOk ? toHex(approvedListHash(fromHex(id), listBytes)) : `0x${'00'.repeat(32)}` },
      build: build ? {} : null,
      criteria: toHex(encoded),
      entries: toHex(listBytes),
    }) as unknown as Parameters<typeof chainChecks>[1];

  it('passes when hashes match and a Build exists', () => {
    expect(chainChecks(id, data(true, true, true))).toEqual({
      published: true,
      criteria: 'pass',
      list: 'pass',
      build: true,
    });
  });

  it('fails on a mismatch and reports no Build', () => {
    expect(chainChecks(id, data(false, false, false))).toEqual({
      published: true,
      criteria: 'fail',
      list: 'fail',
      build: false,
    });
  });

  it('is absent, not failing, when nothing is posted', () => {
    const empty = { exam: null, list: null, build: null, criteria: null, entries: null };
    expect(chainChecks(id, empty)).toEqual({ published: false, criteria: 'absent', list: 'absent', build: false });
  });
});
