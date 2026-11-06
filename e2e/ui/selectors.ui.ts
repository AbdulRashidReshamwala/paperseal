import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { button, centre, composer, field, fold, radio, text, verifierText } from './selectors';

/*
 * A dry check of every word the suites, and the live run, wait for. Each exact string and pattern in
 * selectors.ts must be found in the source of the apps or the UI package, so a rewrite of the copy fails
 * here in a second instead of an hour into a live run. It reads source files only: it does not render
 * anything, so it says a word exists, not that a screen shows it at the right moment.
 */

const roots = ['apps/web/src', 'apps/verifier/src', 'packages/ui/src'].map((dir) => resolve(import.meta.dirname, '../..', dir));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|ts)$/.test(name) && !/\.test\.|\.ui\.|testkit/.test(name) ? [readFileSync(path, 'utf8')] : [];
  });
}
const source = roots.flatMap(sources).join('\n');
// Typographic quotes and apostrophes are written either way in the source and in a pattern.
const plain = (value: string) => value.replace(/[’‘]/g, "'");
const haystack = plain(source);

function entries(group: Record<string, unknown>, prefix: string): [string, string | RegExp][] {
  return Object.entries(group).flatMap(([key, value]) =>
    typeof value === 'string' || value instanceof RegExp ? [[`${prefix}.${key}`, value] as [string, string | RegExp]] : [],
  );
}

// Names that are not words in the source: a CSS class, or a screen that is not rendered by these apps.
const skip = new Set(['composer.optionError', 'text.wrongAccount', 'text.linkProblemHeading']);

describe('selectors against the source', () => {
  const all = [
    ...entries(text, 'text'),
    ...entries(field, 'field'),
    ...entries(button, 'button'),
    ...entries(radio, 'radio'),
    ...entries(fold, 'fold'),
    ...entries(centre, 'centre'),
    ...entries(composer, 'composer'),
    ...entries(verifierText, 'verifierText'),
  ].filter(([key]) => !skip.has(key));

  it.each(all)('%s is in the source', (_key, value) => {
    if (typeof value === 'string') {
      expect(haystack.includes(plain(value)), `"${value}" is not in the apps' source`).toBe(true);
    } else {
      // Anchors describe a whole accessible name, which the source holds as a piece of text or a literal.
      const loose = new RegExp(value.source.replace(/\^|\$/g, ''), value.flags);
      expect(loose.test(haystack), `${String(value)} matches nothing in the apps' source`).toBe(true);
    }
  });
});
