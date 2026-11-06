import type { Hex } from '@paperseal/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';

import { isExamId } from './settings';

export type ExamLink = { kind: 'none' } | { kind: 'exam'; id: Hex } | { kind: 'name'; name: string } | { kind: 'invalid' };

const ROUTE = /^\/(?:exam\/([^/]+)|(0x[^/]*))\/?$/;
const NAME_ROUTE = /^\/name\/([^/]+)\/?$/;
const HISTORY_ROUTE = /^\/exams\/?$/;

/** Whether a route is the exam history, `#/exams`. */
export const isHistoryRoute = (routePath: string): boolean => HISTORY_ROUTE.test(routePath);

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

/** The route a `#/path?query` address holds, or null when the address has no route. */
export function routeOfHash(hash: string): { routePath: string; routeSearch: string } | null {
  if (!hash.startsWith('#/')) return null;
  const rest = hash.slice(1);
  const at = rest.indexOf('?');
  return at === -1 ? { routePath: rest, routeSearch: '' } : { routePath: rest.slice(0, at), routeSearch: rest.slice(at) };
}

const subscribe = (listener: () => void) => {
  globalThis.addEventListener('hashchange', listener);
  globalThis.addEventListener('popstate', listener);
  return () => {
    globalThis.removeEventListener('hashchange', listener);
    globalThis.removeEventListener('popstate', listener);
  };
};
const currentHash = () => (globalThis.location as Location | undefined)?.hash ?? '';

/**
 * The route in the address bar. The address itself is read on every hash change, so moving to
 * another exam, or to a bad link, is shown straight away and never waits on a reload. Without a
 * route in the address (as in a test with a memory router) the router's own location is used.
 */
export function useRoute(): { routePath: string; routeSearch: string } {
  const location = useLocation();
  const hash = useSyncExternalStore(subscribe, currentHash, () => '');
  return routeOfHash(hash) ?? { routePath: location.pathname, routeSearch: location.search };
}

/**
 * The exam the link in the address bar names. The page query counts only while the address has no
 * route of its own, so the header's `#/` goes home from a `?exam=` link.
 */
export function useExamLink(): ExamLink {
  const route = useRoute();
  const here = globalThis.location as Location | undefined;
  return examLink({ search: here && !routeOfHash(here.hash) ? here.search : '', ...route });
}

/**
 * The share form of an address whose hash names an exam: `<page>?exam=<id>`, with the hash dropped,
 * because the part after `#` never reaches a server (spec/agent-verification.md, "Share Links").
 * Null when the hash names no valid exam, so `#/exams`, `#/name/...` and bad links stay as they are.
 */
export function shareUrl(href: string): string | null {
  const url = new URL(href);
  const route = routeOfHash(url.hash);
  if (!route || isHistoryRoute(route.routePath)) return null;
  const link = examLink({ search: url.search, ...route });
  if (link.kind !== 'exam') return null;
  url.searchParams.set('exam', link.id);
  url.hash = '';
  return url.href;
}

/** The address with `?exam=` dropped, because `#/name/...` is the link people see. Null with none to drop. */
export function nameUrl(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has('exam')) return null;
  url.searchParams.delete('exam');
  return url.href;
}

/**
 * Keeps the address bar on the link people should see, without a reload: the share form for an exam
 * opened by ID, and a name with no `?exam=` left over from before the page moved to it.
 */
export function useShareAddress(link: ExamLink): void {
  const key = link.kind === 'exam' ? link.id : link.kind === 'name' ? link.name : null;
  const named = link.kind === 'name';
  useEffect(() => {
    const location = globalThis.location as Location | undefined;
    if (key === null || !location) return;
    const next = named ? nameUrl(location.href) : shareUrl(location.href);
    if (next !== null && next !== location.href) globalThis.history.replaceState(globalThis.history.state, '', next);
  }, [key, named]);
}
