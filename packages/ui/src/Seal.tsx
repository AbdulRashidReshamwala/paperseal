import { useId } from 'react';

export type SealState = 'sealed' | 'opening' | 'open';

const WORDS: Record<SealState, string> = { sealed: 'Sealed', opening: 'Opening', open: 'Open' };

/** A hand-poured outline: deliberately uneven, so it reads as wax and not as a badge. */
const WAX =
  'M106.7 54.2Q106.4 60 106.5 65.7Q106.6 71.5 103.6 76.4Q100.6 81.3 97 85.5Q93.4 89.6 89.4 93.2Q85.4 96.8 80.9 100.1Q76.4 103.4 70.7 101.9Q64.9 100.4 59.8 101.6Q54.8 102.9 49.6 102Q44.4 101.1 38.8 100Q33.1 98.9 28 95.9Q22.9 92.9 19.8 87.8Q16.7 82.7 18 76.4Q19.3 70 17.8 65Q16.2 60 17.6 54.9Q19 49.9 19.9 44.6Q20.8 39.4 23.3 34.6Q25.9 29.8 30 26.2Q34.2 22.6 39.3 20.8Q44.5 19 49.2 14.9Q54 10.8 59.8 12.1Q65.7 13.3 71 15Q76.4 16.8 80.4 20.7Q84.4 24.7 87.4 28.9Q90.4 33 93.5 36.9Q96.6 40.8 101.7 44.6Q106.9 48.4 106.7 54.2Z';

/** The break runs top to bottom. Both halves are clipped along this same line, so they fit together. */
const CRACK = '60,0 66,17 55,33 64,50 54,68 65,86 57,103 62,120';

function Face() {
  return (
    <>
      <path className="ps-seal-under" d={WAX} transform="translate(1.5 2.5)" />
      <path className="ps-seal-wax" d={WAX} />
      <circle className="ps-seal-well" cx="60" cy="58" r="32" />
      <circle className="ps-seal-beads" cx="60" cy="58" r="28" />
      <path className="ps-seal-shine" d="M31 41a34 34 0 0 1 22-15" />
      <text className="ps-seal-mark ps-seal-mark-lift" x="60" y="68.5" textAnchor="middle">
        PS
      </text>
      <text className="ps-seal-mark" x="60" y="67.5" textAnchor="middle">
        PS
      </text>
    </>
  );
}

/**
 * The one memorable mark in the system. It closes, breaks and opens as `state` changes.
 * Use it once per screen at most. Motion stops under prefers-reduced-motion: the state still
 * shows, and the accessible name always says it in words.
 */
export function Seal(props: {
  state: SealState;
  /** Width and height in pixels. */
  size?: number;
  /** The accessible name. Defaults to the state in words. */
  label?: string;
  /** Print the state in words beneath the seal. */
  caption?: boolean;
  /** Press the seal down as it mounts, for the moment something is sealed. */
  stamp?: boolean;
}) {
  const { state, size = 112 } = props;
  // useId can contain characters that are unsafe inside url(#...).
  const id = `ps-seal-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const word = WORDS[state];
  return (
    <figure className="ps-seal" data-state={state} data-stamp={props.stamp ? 'true' : undefined}>
      <svg role="img" aria-label={props.label ?? word} viewBox="0 0 120 120" width={size} height={size}>
        <defs>
          <clipPath id={`${id}-l`}>
            <polygon points={`-40,-40 60,-40 ${CRACK} 60,160 -40,160`} />
          </clipPath>
          <clipPath id={`${id}-r`}>
            <polygon points={`160,-40 60,-40 ${CRACK} 60,160 160,160`} />
          </clipPath>
        </defs>
        <g className="ps-seal-half" data-side="left">
          <g clipPath={`url(#${id}-l)`}>
            <Face />
          </g>
        </g>
        <g className="ps-seal-half" data-side="right">
          <g clipPath={`url(#${id}-r)`}>
            <Face />
          </g>
        </g>
        <polyline className="ps-seal-crack" points={CRACK} pathLength={1} />
      </svg>
      {props.caption ? <figcaption>{word}</figcaption> : null}
    </figure>
  );
}

/** A rubber stamp, for the single moment a step is finished. Always words, never an icon alone. */
export function Stamp(props: { children: string; tone?: 'seal' | 'ink'; press?: boolean }) {
  return (
    <span className="ps-stamp" data-tone={props.tone ?? 'seal'} data-press={props.press ? 'true' : undefined}>
      {props.children}
    </span>
  );
}
