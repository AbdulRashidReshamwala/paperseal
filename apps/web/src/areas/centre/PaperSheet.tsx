import type { Paper } from '@paperseal/protocol';
import { CopyButton } from '@paperseal/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { A4_HEIGHT_PX, A4_WIDTH_PX, paginate, paperItems, type PaperItem, type PaperPage } from './paperPages';
import './paper.css';

const ZOOMS = [50, 75, 100, 125, 150, 200];
/** Kept free at the foot of every page, so that a rounding difference in print can't push a page over. */
const SLACK_PX = 4;

/** Reads the one long page a measuring pass renders, and splits it into A4 pages. */
function measurePages(sheet: HTMLElement): PaperPage[] | null {
  const page = sheet.querySelector<HTMLElement>('.paper-page');
  const body = sheet.querySelector<HTMLElement>('.paper-page-body');
  if (!page || !body || page.offsetWidth === 0) return null;
  // The pages may be zoomed, and a page is laid out the same at every zoom, so all of this is at full size.
  const zoom = page.getBoundingClientRect().width / page.offsetWidth;
  const height = (element: Element) => element.getBoundingClientRect().height / zoom;
  const heights: number[] = [];
  let heading = 0;
  for (const block of body.querySelectorAll('[data-block]')) {
    if (block.tagName === 'H3') {
      // A heading stays with the question under it.
      heading += height(block);
    } else {
      heights.push(heading + height(block));
      heading = 0;
    }
  }
  const room = A4_HEIGHT_PX - (height(page) - height(body)) - SLACK_PX;
  return paginate(heights, room).map((one) => (one.tallBy ? { ...one, tallBy: one.tallBy + height(page) - height(body) } : one));
}

/** The pages for what is on the paper, measured before anything paints. Null during a measuring pass. */
function usePages(items: PaperItem[], heading: string) {
  const sheet = useRef<HTMLElement>(null);
  const [measured, setMeasured] = useState<{ items: PaperItem[]; heading: string; pages: PaperPage[] } | null>(null);
  const pages = measured?.items === items && measured.heading === heading ? measured.pages : null;
  useLayoutEffect(() => {
    if (pages === null && sheet.current) {
      setMeasured({ items, heading, pages: measurePages(sheet.current) ?? [{ start: 0, end: items.length }] });
    }
  }, [pages, items, heading]);
  // The exam typeface can arrive after the first paint, and it changes every height.
  useEffect(() => {
    let live = true;
    const again = () => {
      if (live) setMeasured(null);
    };
    document.fonts.addEventListener('loadingdone', again);
    void document.fonts.ready.then(again);
    return () => {
      live = false;
      document.fonts.removeEventListener('loadingdone', again);
    };
  }, []);
  return { sheet, pages };
}

/** How far the pages shrink to fit the viewing area's width at 100%. */
function useFit() {
  const scroller = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const read = () => {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (width > 0) setFit(Math.min(1, width / A4_WIDTH_PX));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { scroller, fit };
}

/** One page's questions, grouped under their topics. Each topic's heading shows once, where the topic opens. */
function PageBody({ items }: { items: PaperItem[] }) {
  const groups: PaperItem[][] = [];
  items.forEach((item) => {
    const group = groups.at(-1);
    if (group && group[0]?.question.topic === item.question.topic) group.push(item);
    else groups.push([item]);
  });
  return groups.map((group) => {
    const first = group[0];
    if (!first) return null;
    return (
      <section key={first.question.topic} className="paper-sheet-topic">
        {first.opensTopic ? <h3 data-block>{first.question.topic}</h3> : null}
        <ol start={first.number}>
          {group.map(({ question, number }) => (
            <li key={number} data-block>
              {question.text}
              {question.options ? (
                <ol className="paper-options" type="A" aria-label="Options">
                  {question.options.map((option, at) => (
                    <li key={at}>{option}</li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    );
  });
}

/**
 * The paper as A4 pages, numbered straight through, with its raw data one toggle away.
 * It only ever receives what `unlockPaper` returned, so there is no unchecked way to reach it.
 * `title` is the exam's verified name for the page header. It comes from outside the paper and is not part of it.
 */
export function PaperSheet(props: { paper: Paper; title: string | null; onPrint: () => void }) {
  const { paper, title, onPrint } = props;
  const heading = title ?? 'Examination paper';
  const items = useMemo(() => paperItems(paper), [paper]);
  const { sheet, pages } = usePages(items, heading);
  const { scroller, fit } = useFit();
  const [zoom, setZoom] = useState(100);
  const [view, setView] = useState<'paper' | 'raw'>('paper');
  const zoomAt = ZOOMS.indexOf(zoom);
  const smaller = ZOOMS[zoomAt - 1];
  const larger = ZOOMS[zoomAt + 1];
  const shown = pages ?? [{ start: 0, end: items.length }];
  return (
    <div className="paper-viewer" data-view={view}>
      <div className="paper-toolbar">
        <div className="paper-tools" role="group" aria-label="Show">
          <button type="button" className="paper-tool" aria-pressed={view === 'paper'} onClick={() => { setView('paper'); }}>
            Paper
          </button>
          <button type="button" className="paper-tool" aria-pressed={view === 'raw'} onClick={() => { setView('raw'); }}>
            Raw data
          </button>
        </div>
        <div className="paper-toolbar-end">
          {view === 'paper' ? (
            <>
              <span className="paper-count">
                {String(shown.length)} {shown.length === 1 ? 'page' : 'pages'}
              </span>
              <div className="paper-tools" role="group" aria-label="Zoom">
                <button type="button" className="paper-tool" aria-label="Zoom out" disabled={smaller === undefined} onClick={() => { if (smaller !== undefined) setZoom(smaller); }}>
                  −
                </button>
                <span className="paper-zoom">{String(zoom)}%</span>
                <button type="button" className="paper-tool" aria-label="Zoom in" disabled={larger === undefined} onClick={() => { if (larger !== undefined) setZoom(larger); }}>
                  +
                </button>
              </div>
            </>
          ) : null}
          <button type="button" className="paper-tool" onClick={onPrint}>
            Print
          </button>
        </div>
      </div>
      {/* Stays laid out behind the raw data, so printing always has the pages. */}
      <div ref={scroller} className="paper-scroll" role="region" aria-label="Paper pages" tabIndex={0} style={{ '--paper-scale': (fit * zoom) / 100 } as CSSProperties}>
        <article ref={sheet} className="paper-sheet" aria-label="The examination paper">
          {shown.map((page, index) => {
            const height = pages ? page.tallBy && `${String(page.tallBy)}px` : 'auto';
            const Header = index === 0 ? 'h2' : 'p';
            return (
              <div key={page.start} className="paper-frame" {...(height ? { 'data-tall': true, style: { '--page-height': height } as CSSProperties } : {})}>
                <div className="paper-page">
                  <Header className="paper-page-head">{heading}</Header>
                  <div className="paper-page-body">
                    <PageBody items={items.slice(page.start, page.end)} />
                  </div>
                  <p className="paper-page-foot">
                    Page {String(index + 1)} of {String(shown.length)}
                  </p>
                </div>
              </div>
            );
          })}
        </article>
      </div>
      {view === 'raw' ? (
        <div className="paper-raw">
          <div className="paper-raw-copy">
            <CopyButton text={() => JSON.stringify(paper, null, 2)}>Copy</CopyButton>
          </div>
          <pre tabIndex={0}>{JSON.stringify(paper, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}
