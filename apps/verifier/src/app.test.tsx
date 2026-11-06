import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { criteriaHash, encodeApprovedList, approvedListHash, encodeCriteria, fromHex, toHex, type Hex } from '@paperseal/protocol';
import { App } from './App';
import { chainChecks } from './checks';
import { examLink, routeOfHash } from './link';
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
  storageUrl: 'https://files.example/bucket',
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

describe('the page', () => {
  it.each([['/'], ['/attestation'], ['/commitments'], ['/unlock'], ['/proof'], ['/settings']])(
    'an old link to %s still reaches the one page, with no sign-in',
    (path) => {
      const html = render(path);
      expect(html).toContain('Steps for this exam');
      expect(html).toContain('Check it yourself');
      expect(html).not.toMatch(/sign in/i);
    },
  );

  it('with no TEE URL shows no failure and only neutral TEE wording', () => {
    const html = render('/', { ...defaultSettings, teeUrl: '' });
    expect(html).toContain('Live from the machine, optional');
    expect(html).toContain('Add the live machine address');
    expect(html).not.toMatch(/\bFail\b|data-status="fail"|data-tone="bad"|role="alert"/);
  });

  it('labels the TEE URL optional', () => {
    const html = render('/');
    expect(html).toContain('Live machine address (optional)');
    expect(html).toContain('It adds live progress');
    expect(html).toContain('Where the public files are kept');
  });
});

describe('exam links', () => {
  const id = `0x${'ab'.repeat(32)}`;
  const url = (over: Partial<Parameters<typeof examLink>[0]>) => examLink({ search: '', routePath: '/', routeSearch: '', ...over });

  it.each([
    ['a hash route', { routePath: `/exam/${id}` }],
    ['a bare hash route', { routePath: `/${id}` }],
    ['a query inside the hash', { routeSearch: `?exam=${id}` }],
    ['the page query', { search: `?exam=${id}` }],
    ['capital letters', { search: `?exam=${id.toUpperCase().replace('0X', '0x')}` }],
  ])('reads %s', (_, over) => {
    expect(url(over)).toEqual({ kind: 'exam', id });
  });

  it('prefers the hash, which a picked exam sets, over the page query', () => {
    expect(url({ search: `?exam=0x${'11'.repeat(32)}`, routePath: `/exam/${id}` })).toEqual({ kind: 'exam', id });
  });

  it('reads an exam name from #/name/, exactly as written, for the name check to judge', () => {
    expect(url({ routePath: '/name/jee-main-2026.board.eth' })).toEqual({ kind: 'name', name: 'jee-main-2026.board.eth' });
    expect(url({ routePath: '/name/JEE-Main-2026.board.eth/' })).toEqual({ kind: 'name', name: 'JEE-Main-2026.board.eth' });
    expect(url({ routePath: `/name/${encodeURIComponent('🎓-2026.board.eth')}` })).toEqual({ kind: 'name', name: '🎓-2026.board.eth' });
    expect(url({ routePath: '/name/%E0%A4%A' })).toEqual({ kind: 'name', name: '%E0%A4%A' });
    expect(url({ routePath: '/name/jee-main-2026.board.eth', search: `?exam=${id}` })).toEqual({ kind: 'name', name: 'jee-main-2026.board.eth' });
    expect(url({ routePath: '/name/' })).toEqual({ kind: 'none' });
  });

  it('reads the route from the address, so a changed hash is seen without a reload', () => {
    expect(routeOfHash('#/exam/0xnothex')).toEqual({ routePath: '/exam/0xnothex', routeSearch: '' });
    expect(routeOfHash(`#/?exam=${id}`)).toEqual({ routePath: '/', routeSearch: `?exam=${id}` });
    expect(routeOfHash('')).toBeNull();
    expect(url({ ...(routeOfHash('#/exam/0xnothex') ?? {}) })).toEqual({ kind: 'invalid' });
  });

  it('has no exam without a link, and an invalid one stays invalid', () => {
    expect(url({})).toEqual({ kind: 'none' });
    expect(url({ routePath: '/attestation' })).toEqual({ kind: 'none' });
    expect(url({ search: '?exam=' })).toEqual({ kind: 'invalid' });
    expect(url({ routePath: '/exam/0x1234' })).toEqual({ kind: 'invalid' });
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
    expect(validateSettings({ rpcUrl: '', teeUrl: '', storageUrl: '', registryAddress: '', examId: '' })).toEqual({});
    expect(
      Object.keys(
        validateSettings({
          rpcUrl: 'ftp://x',
          teeUrl: 'nope',
          storageUrl: 'file:///x',
          registryAddress: '0x1',
          examId: '0x2',
        }),
      ).sort(),
    ).toEqual(['examId', 'registryAddress', 'rpcUrl', 'storageUrl', 'teeUrl']);
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

  it('never follows an offchain lookup from a registry read to a gateway', async () => {
    // OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData),
    // sent by the registry address itself, so a reader with CCIP-Read on would ask the gateway.
    const gateway = 'https://gateway.example/{sender}/{data}.json';
    const word = (value: number | string) => (typeof value === 'number' ? value.toString(16) : value).padStart(64, '0');
    const padded = (hex: string) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
    const urlHex = toHex(new TextEncoder().encode(gateway)).slice(2);
    const urls = word(1) + word(0x20) + word(gateway.length) + padded(urlHex);
    const callData = word(0);
    const revert =
      '0x556f1830' +
      word(custom.registryAddress.slice(2)) +
      word(0xa0) +
      word(0xa0 + urls.length / 2) +
      padded('deadbeef') +
      word(0xa0 + urls.length / 2 + callData.length / 2) +
      urls +
      callData +
      word(0);
    const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== custom.rpcUrl) return Promise.resolve(new Response(JSON.stringify({ data: '0x' })));
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: revert } })),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const { registry } = connect(custom);
    await expect(registry?.board()).rejects.toThrow();
    const urlsCalled = fetch.mock.calls.map(([url]) => String(url));
    expect(urlsCalled).toContain(custom.rpcUrl);
    expect(urlsCalled.filter((url) => url.startsWith('https://gateway.example/'))).toEqual([]);
  });

  it('connects to nothing until settings exist', () => {
    const nothing = connect({ rpcUrl: '', teeUrl: '', storageUrl: '', registryAddress: '', examId: '' });
    expect([nothing.tee, nothing.registry, nothing.examId, nothing.storage]).toEqual([null, null, null, null]);
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
