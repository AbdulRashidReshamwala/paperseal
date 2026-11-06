// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { examLink, shareUrl, useShareAddress } from './link';

const id = `0x${'ab'.repeat(32)}`;
const page = 'https://verify.example/exams/';

describe('share links', () => {
  it.each([
    ['#/exam/', `${page}#/exam/${id}`],
    ['#/', `${page}#/${id}`],
    ['#/?exam=', `${page}#/?exam=${id}`],
    ['capital letters', `${page}#/exam/${id.toUpperCase().replace('0X', '0x')}`],
  ])('turns %s into ?exam=', (_, href) => {
    expect(shareUrl(href)).toBe(`${page}?exam=${id}`);
  });

  it('replaces an older ?exam= and keeps the rest of the query', () => {
    expect(shareUrl(`${page}?exam=0x${'11'.repeat(32)}&x=1#/exam/${id}`)).toBe(`${page}?exam=${id}&x=1`);
  });

  it.each([
    ['no hash', `${page}?exam=${id}`],
    ['the history page', `${page}?exam=${id}#/exams`],
    ['a name route', `${page}#/name/jee-main-2026.board.eth`],
    ['an invalid exam', `${page}#/exam/0xnothex`],
    ['no exam', `${page}#/`],
  ])('leaves %s alone', (_, href) => {
    expect(shareUrl(href)).toBeNull();
  });

  it('names the same exam as the hash it replaces', () => {
    const share = new URL(shareUrl(`${page}#/exam/${id}`) ?? '');
    expect(examLink({ search: share.search, routePath: '/', routeSearch: '' })).toEqual({ kind: 'exam', id });
  });
});

describe('useShareAddress', () => {
  afterEach(() => {
    globalThis.history.replaceState(null, '', '/');
  });

  it('rewrites the address bar without a reload, keeping the history state', () => {
    globalThis.history.replaceState({ idx: 0 }, '', `/#/exam/${id}`);
    renderHook(() => useShareAddress({ kind: 'exam', id: id as `0x${string}` }));
    expect(globalThis.location.hash).toBe('');
    expect(globalThis.location.search).toBe(`?exam=${id}`);
    expect(globalThis.history.state).toEqual({ idx: 0 });
  });

  it('does nothing without an exam', () => {
    globalThis.history.replaceState(null, '', '/#/name/jee-main-2026.board.eth');
    renderHook(() => useShareAddress({ kind: 'name', name: 'jee-main-2026.board.eth' }));
    expect(globalThis.location.hash).toBe('#/name/jee-main-2026.board.eth');
  });
});
