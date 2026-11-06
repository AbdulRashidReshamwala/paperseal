import type { ReactNode } from 'react';

/**
 * The screen for someone who has registered and now only waits: a big check in the middle of the
 * page, a plain statement that registration is done, one line on what happens next, and a small
 * line for anything they should keep in mind. A status region, so a screen reader announces it.
 */
export function Registered(props: {
  /** Defaults to "You’re registered". */
  title?: string;
  /** What is now true, such as "Your security key is set for this exam." */
  message: ReactNode;
  /** One sentence on what happens next. */
  next: ReactNode;
  /** Smaller and quieter, such as how to come back later. */
  note?: ReactNode;
}) {
  return (
    <section className="ps-registered" role="status">
      <svg className="ps-registered-check" viewBox="0 0 96 96" fill="none" aria-hidden="true" focusable="false">
        <circle cx="48" cy="48" r="44" stroke="currentColor" strokeWidth="4" />
        <path d="M28 49.5 42 63.5 69 34" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h1 className="ps-registered-title">{props.title ?? 'You’re registered'}</h1>
      <p className="ps-registered-message">{props.message}</p>
      <p className="ps-registered-next">{props.next}</p>
      {props.note ? <p className="ps-registered-note">{props.note}</p> : null}
    </section>
  );
}
