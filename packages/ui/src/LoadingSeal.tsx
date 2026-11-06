import { useEffect, useState, type CSSProperties } from 'react';

import sealUrl from './assets/seal.svg';

/**
 * The seal apps/web/index.html painted before any script ran, if React is about to replace it: its image
 * address, and how long its animation has run, so the two line up and the seal does not start again.
 */
function firstPaintSeal() {
  const seal = globalThis.document?.querySelector<HTMLImageElement>('.ps-boot-seal');
  const ring = globalThis.document?.querySelector('.ps-boot-ring');
  if (!seal || !ring) return null;
  const ran = ring.getAnimations()[0]?.currentTime;
  return { src: seal.currentSrc, ran: typeof ran === 'number' ? ran : 0 };
}

/** How long a page waits for its first reads before it shows what it has. */
export const LOADING_DEADLINE_MS = 8_000;

/**
 * Whether a page can show: its first reads are `done`, or `ms` have passed so a stuck read never holds
 * it. Once true it stays true, so a later poll never brings the loader back.
 */
export function useLoaded(done: boolean, ms = LOADING_DEADLINE_MS): boolean {
  const [loaded, setLoaded] = useState(done);
  if (done && !loaded) setLoaded(true);
  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => {
      setLoaded(true);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [loaded, ms]);
  return loaded;
}

/**
 * Shown while a page's code or first data loads: the seal pressed onto the paper, then a thin line drawn around it and
 * lifted off, for as long as the wait lasts. The line is not progress: it says nothing about how far along
 * the load is. Nothing appears for the first 150ms, so a fast load shows no seal at all.
 */
export function LoadingSeal() {
  const [boot] = useState(firstPaintSeal);
  const carriedOn = boot ? ({ '--ps-loading-ran': `${String(boot.ran)}ms` } as CSSProperties) : undefined;
  return (
    <div className="ps-loading" role="status" style={carriedOn}>
      <span className="ps-sr">Loading</span>
      <img className="ps-loading-seal" src={boot?.src ?? sealUrl} width={120} height={120} alt="" />
      <svg className="ps-loading-ring" viewBox="0 0 120 120" width={120} height={120} aria-hidden="true">
        <circle cx={60} cy={60} r={50} pathLength={1} />
      </svg>
    </div>
  );
}
