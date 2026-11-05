import { useId } from 'react';

import { LOGO_SHEET, LOGO_WAX } from './logoPaths';

/**
 * The mark: an exam paper with its corner folded down and closed by wax. The sheet is
 * `currentColor`, so it follows the text around it. The wax is `--ps-wax`, or `currentColor` with
 * `tone="mono"`. It is drawn to be crisp at multiples of 16px.
 */
export function Logo(props: {
  /** Width and height in pixels. Prefer 16, 32, 48 or 64. */
  size?: number;
  tone?: 'colour' | 'mono';
  /** The accessible name. */
  title?: string;
  /** Hide it from assistive technology, when the words "Paper Seal" sit beside it. */
  decorative?: boolean;
}) {
  const { size = 32, tone = 'colour', title = 'Paper Seal' } = props;
  const titleId = useId();
  const name = props.decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-labelledby': titleId };
  return (
    <svg className="ps-logo" data-tone={tone} viewBox="0 0 32 32" width={size} height={size} {...name}>
      {props.decorative ? null : <title id={titleId}>{title}</title>}
      <path className="ps-logo-sheet" fillRule="evenodd" d={LOGO_SHEET} />
      <path className="ps-logo-wax" d={LOGO_WAX} />
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
