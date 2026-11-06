import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/**
 * Fades a page in when it first shows and when the path changes, with no delay and without remounting
 * anything: the animation runs on one element that stays put, so form state and focus are left alone.
 * A replace does not fade. It corrects the address of the page already showing, as when the first keystroke
 * on /board/new becomes /board/draft/<id>. A change to the query alone does not fade either.
 */
export function RouteFade(props: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const element = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  const fade = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const first = shown.current === null;
    const same = shown.current === pathname;
    shown.current = pathname;
    if (same || (navigationType === 'REPLACE' && !first)) return;
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true) return;
    fade.current?.cancel();
    fade.current = element.current?.animate({ opacity: [0, 1] }, { duration: 220, easing: 'ease-out' }) ?? null;
  }, [pathname, navigationType]);

  return <div ref={element}>{props.children}</div>;
}
