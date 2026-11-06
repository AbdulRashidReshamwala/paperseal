import { useId } from 'react';

import sealUrl from './assets/seal.svg';

export type SealState = 'sealed' | 'opening' | 'open' | 'broken';

const WORDS: Record<SealState, string> = { sealed: 'Sealed', opening: 'Opening', open: 'Open', broken: 'Broken' };

/** The break runs top to bottom. Both halves are clipped along this same line, so they fit together. */
const CRACK = '60,0 66,17 55,33 64,50 54,68 65,86 57,103 62,120';

/** The v3 wax seal, sized so the wax fills the 120 box. Its art has a wide transparent margin. */
function Face() {
  return <image href={sealUrl} x="-8" y="-15" width="136" height="136" />;
}

/**
 * The one memorable mark in the system, a seal of approval. It stays whole through a normal exam, opening
 * included, and comes apart only as `broken`, when something went wrong. Use it once per screen at most.
 * Motion stops under prefers-reduced-motion: the state still shows, and the accessible name always says
 * it in words.
 */
export function Seal(props: {
  state: SealState;
  /** Width and height in pixels. */
  size?: number;
  /** The accessible name. Defaults to the state in words. */
  label?: string;
  /** Print the state in words beneath the seal, or these words in its place. */
  caption?: boolean | string;
  /** Press the seal down as it mounts, for the moment something is sealed. */
  stamp?: boolean;
}) {
  const { state, size = 112 } = props;
  // useId can contain characters that are unsafe inside url(#...).
  const id = `ps-seal-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const word = typeof props.caption === 'string' ? props.caption : WORDS[state];
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
