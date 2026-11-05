import { useEffect, useRef, useState } from 'react';

import { CheckIcon, CopyIcon } from './icons';

/** `0x1234ab…cd90`, or the value itself when shortening would save nothing. */
export function shortenHash(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

type Copy = 'idle' | 'copied' | 'failed';

/**
 * Evidence only: a shortened value that copies in full on click or tap. Hovering shows the full
 * value, and a click or tap also prints it beneath, because a touch screen has no hover.
 */
export function Hash(props: { value: string; /** What this value is, for screen readers. */ label?: string }) {
  const { value, label = 'value' } = props;
  const [copy, setCopy] = useState<Copy>('idle');
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const onClick = () => {
    setRevealed(true);
    const settle = (result: Copy) => {
      setCopy(result);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopy('idle');
      }, 2000);
    };
    // navigator.clipboard is missing outside a secure context.
    const written = (globalThis.navigator as Navigator | undefined)?.clipboard?.writeText(value);
    if (!written) {
      settle('failed');
      return;
    }
    written.then(
      () => {
        settle('copied');
      },
      () => {
        settle('failed');
      },
    );
  };

  return (
    <span className="ps-hash">
      <button type="button" className="ps-hash-button" title={value} aria-label={`Copy ${label}: ${value}`} onClick={onClick}>
        <span className="ps-mono">{shortenHash(value)}</span>
        {copy === 'copied' ? <CheckIcon /> : <CopyIcon />}
      </button>
      <span className="ps-hash-status" role="status">
        {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed. Select it below.' : ''}
      </span>
      {revealed ? <span className="ps-hash-full ps-mono">{value}</span> : null}
    </span>
  );
}
