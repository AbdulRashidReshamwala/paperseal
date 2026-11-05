import type { Hex } from '@paperseal/protocol';
import { useLocation } from 'react-router';

import { isExamId } from './settings';

export type ExamLink = { kind: 'none' } | { kind: 'exam'; id: Hex } | { kind: 'invalid' };

const ROUTE = /^\/(?:exam\/([^/]+)|(0x[^/]*))\/?$/;

/**
 * The exam a URL names: `#/exam/0x...`, `#/0x...`, `#/?exam=0x...` or `?exam=0x...`, in that order.
 * A link that names something invalid stays invalid. Falling back to the default exam would show
 * the status of an exam the viewer did not ask about.
 */
export function examLink(url: { search: string; routePath: string; routeSearch: string }): ExamLink {
  const route = ROUTE.exec(url.routePath);
  const raw =
    route?.[1] ?? route?.[2] ?? new URLSearchParams(url.routeSearch).get('exam') ?? new URLSearchParams(url.search).get('exam');
  if (raw === null) return { kind: 'none' };
  const id = raw.trim().toLowerCase();
  return isExamId(id) ? { kind: 'exam', id: id as Hex } : { kind: 'invalid' };
}

export function useExamLink(): ExamLink {
  const location = useLocation();
  return examLink({
    search: (globalThis.location as Location | undefined)?.search ?? '',
    routePath: location.pathname,
    routeSearch: location.search,
  });
}
