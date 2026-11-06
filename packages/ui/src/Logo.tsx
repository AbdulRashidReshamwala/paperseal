import { useId } from 'react';

import sealUrl from './assets/seal.svg';
import { LOGO_SEAL } from './logoPaths';

/** From this size up, the realistic wax seal is shown. Below it the art turns to mush, so the flat mark. */
const REALISTIC_FROM = 24;

/**
 * The mark: a wax seal stamped "PS". Under 24px, and always with `tone="mono"`, it is the flat
 * single-path mark, filled with `--ps-wax` or `currentColor`. From 24px up it is the realistic seal.
 */
export function Logo(props: {
  /** Width and height in pixels. Prefer 16, 32, 48, 96. */
  size?: number;
  tone?: 'colour' | 'mono';
  /** The accessible name. */
  title?: string;
  /** Hide it from assistive technology, when the words "Paper Seal" sit beside it. */
  decorative?: boolean;
}) {
  const { size = 32, tone = 'colour', title = 'Paper Seal' } = props;
  const titleId = useId();
  if (size >= REALISTIC_FROM && tone !== 'mono') {
    return props.decorative ? (
      <img className="ps-logo" data-tone={tone} src={sealUrl} width={size} height={size} alt="" aria-hidden="true" />
    ) : (
      <img className="ps-logo" data-tone={tone} src={sealUrl} width={size} height={size} alt={title} />
    );
  }
  const name = props.decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-labelledby': titleId };
  return (
    <svg className="ps-logo" data-tone={tone} viewBox="0 0 32 32" width={size} height={size} {...name}>
      {props.decorative ? null : <title id={titleId}>{title}</title>}
      <path className="ps-logo-wax" fillRule="evenodd" d={LOGO_SEAL} />
    </svg>
  );
}

/** The mark with "Paper Seal" in the display serif. The words are its accessible name. */
export function Wordmark(props: {
  /** Height of the mark in pixels. The words scale with it. */
  size?: number;
  tone?: 'colour' | 'mono';
}) {
  const { size = 32, tone = 'colour' } = props;
  return (
    <span className="ps-wordmark" style={{ fontSize: Math.round(size * 0.6) }}>
      <Logo size={size} tone={tone} decorative />
      <span className="ps-wordmark-words">Paper Seal</span>
    </span>
  );
}

/** The wordmark in a page's header, linking home. Both apps route by hash, so this needs no router. */
export function HomeMark() {
  return (
    <a className="ps-home" href="#/">
      <Wordmark />
    </a>
  );
}
