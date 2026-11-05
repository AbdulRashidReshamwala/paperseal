import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const src = import.meta.dirname;

/**
 * Paper and K_priv handling. A share is HPKE-encrypted to its holder with no time seal, so holders
 * need no timelock either: K_pub and everything that opens the paper stay with the centre.
 */
const bannedNames =
  /\b(aesGcmDecrypt|aesGcmEncrypt|xorCombine|openPaperFile|openKeyPriv|parsePaper|saltedPaperHash|timelockDecrypt|unlockPaper)\b/;

function resolveLocal(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  return ['.ts', '.tsx', '/index.ts'].map((ext) => base + ext).find((file) => existsSync(file)) ?? null;
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every local file reachable by imports. `lazy` also follows dynamic imports. */
function graph(entry: string, lazy: boolean): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const code = stripComments(readFileSync(file, 'utf8'));
    seen.set(file, code);
    const pattern = lazy ? /(?:from\s+|import\(\s*)'(\.[^']+)'/g : /from\s+'(\.[^']+)'/g;
    for (const [, specifier] of code.matchAll(pattern)) {
      const next = resolveLocal(file, specifier as string);
      if (next) visit(next);
    }
  };
  visit(entry);
  return seen;
}

const files = (map: Map<string, string>) => [...map.keys()].map((file) => relative(src, file));
const keyholder = graph(join(src, 'areas/keyholder/KeyholderArea.tsx'), true);

describe('keyholder import boundary', () => {
  it('reaches the shared release flow', () => {
    expect(files(keyholder)).toContain('release/flow.ts');
  });

  it('reaches no centre code', () => {
    expect(files(keyholder).filter((file) => file.includes('centre'))).toEqual([]);
  });

  it('reaches no paper or K_priv handling', () => {
    const offenders = [...keyholder].filter(([, code]) => bannedNames.test(code));
    expect(offenders.map(([file]) => relative(src, file))).toEqual([]);
  });

  it('would catch a violation: the centre area does reach this code', () => {
    const centre = graph(join(src, 'areas/centre/CentreArea.tsx'), true);
    expect(files(centre)).toContain('areas/centre/unlock.ts');
    const withUnlock = graph(join(src, 'areas/centre/unlock.ts'), true);
    expect(files(centre)).toContain('release/flow.ts');
    expect([...withUnlock.values()].some((code) => bannedNames.test(code))).toBe(true);
  });
});

describe('code splitting', () => {
  it('keeps every area out of the entry bundle', () => {
    const entry = files(graph(join(src, 'main.tsx'), false));
    expect(entry).toContain('App.tsx');
    expect(entry.filter((file) => file.startsWith('areas/') || file.startsWith('release/'))).toEqual([]);
  });

  it('reaches each area lazily', () => {
    const all = files(graph(join(src, 'main.tsx'), true));
    for (const area of ['board/BoardArea', 'setter/SetterArea', 'centre/CentreArea', 'keyholder/KeyholderArea']) {
      expect(all).toContain(`areas/${area}.tsx`);
    }
  });
});
