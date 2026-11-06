import type { Hex } from '@paperseal/protocol';
import { useLocation } from 'react-router';

import { isExamId } from './settings';

export type ExamLink = { kind: 'none' } | { kind: 'exam'; id: Hex } | { kind: 'name'; name: string } | { kind: 'invalid' };

const ROUTE = /^\/(?:exam\/([^/]+)|(0x[^/]*))\/?$/;
const NAME_ROUTE = /^\/name\/([^/]+)\/?$/;

/** A path segment as typed. One that can't be decoded is kept as it is, and the name check refuses it. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The exam a URL names: `#/name/<ENS name>`, `#/exam/0x...`, `#/0x...`, `#/?exam=0x...` or
 * `?exam=0x...`, in that order. A link that names something invalid stays invalid. Falling back to
 * the default exam would show the status of an exam the viewer did not ask about. A name is kept
 * exactly as written: the name check, not this, decides whether it is valid.
 */
export function examLink(url: { search: string; routePath: string; routeSearch: string }): ExamLink {
  const named = NAME_ROUTE.exec(url.routePath);
  if (named?.[1] !== undefined) return { kind: 'name', name: decoded(named[1]) };
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
