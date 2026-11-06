import { CheckIcon, CrossIcon, KeyIcon } from './icons';
import { PrimaryAction } from './Stage';

export type KeyTouchState = 'idle' | 'waiting' | 'success' | 'failed';

/**
 * - `no-key`: nothing answered. A browser reports this the same way as the person pressing
 *   Cancel, so the copy has to cover both.
 * - `wrong-key`: a key answered, but it cannot be used here.
 * - `unsupported`: this page or browser cannot reach a security key at all.
 */
export type KeyProblem = 'no-key' | 'wrong-key' | 'unsupported' | 'other';

const fieldOf = (error: unknown, field: 'name' | 'code'): unknown =>
  typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[field] : undefined;

/** Reads a failed `navigator.credentials` call. It goes by the error's name, so it needs no key package. */
export function securityKeyProblem(error: unknown, credentials: unknown = globalThis.navigator?.credentials): KeyProblem {
  if (!credentials) return 'unsupported';
  const code = fieldOf(error, 'code');
  if (code === 'prf_unavailable' || code === 'synced_passkey' || code === 'unsupported_key') return 'wrong-key';
  switch (fieldOf(error, 'name')) {
    case 'NotAllowedError':
    case 'NotSupportedError':
    case 'AbortError':
    case 'TimeoutError':
      return 'no-key';
    case 'SecurityError':
      return 'unsupported';
    default:
      return 'other';
  }
}

const FAILURE: Record<KeyProblem, { title: string; body: string }> = {
  'no-key': {
    title: 'No security key answered',
    body: 'Plug in your security key, then try again. If you pressed Cancel, you can simply try again.',
  },
  'wrong-key': {
    title: 'This security key can’t be used here',
    body: 'Use the physical security key you registered for this exam, then try again.',
  },
  unsupported: {
    title: 'This page can’t reach a security key',
    body: 'Open it in Chrome on this computer, from its https address, then try again.',
  },
  other: { title: 'Your security key didn’t work', body: 'Try again. If it keeps failing, contact your exam board.' },
};

/** The demo's security key is Chrome's virtual authenticator, which a page cannot turn on for itself. `pnpm demo` opens Chrome with one attached. */
export const VIRTUAL_KEY_HINT = 'Demo: open this site in the Chrome window started by `pnpm demo`, which has a security key built in, then try again.';

/**
 * The prompt for touching a security key. Run the WebAuthn call from `onUse` and move `state`
 * through it; pass what it threw as `error`.
 */
export function KeyTouch(props: {
  state: KeyTouchState;
  /** Called from the button. Runs the security key request. */
  onUse: () => void;
  /** What the touch is for, finishing "Use your security key…", such as "to release your share". */
  purpose?: string;
  /** Button label before the first try. */
  actionLabel?: string;
  /** What `navigator.credentials` threw. Picks the guidance shown in the failed state. */
  error?: unknown;
  /** A plain explanation of the failure, replacing the standard guidance. */
  failureText?: string;
  /** False in production, which hides the virtual security key hint. */
  demo?: boolean;
}) {
  const { state, purpose, error, demo = true } = props;
  const problem = state === 'failed' ? securityKeyProblem(error) : null;
  const failure = problem ? FAILURE[problem] : null;
  const showHint = demo && (problem === 'no-key' || problem === 'wrong-key');
  const copy =
    state === 'idle'
      ? { title: purpose ? `Use your security key ${purpose}` : 'Use your security key', body: 'Have it plugged in and ready.' }
      : state === 'waiting'
        ? { title: 'Touch your security key', body: 'Your browser may ask you to choose it first. Keep this page open.' }
        : state === 'success'
          ? { title: 'Security key confirmed', body: null }
          : { title: failure?.title ?? '', body: props.failureText ?? failure?.body ?? null };
  return (
    <div className="ps-key" data-state={state}>
      <span className="ps-key-mark" aria-hidden="true">
        {state === 'success' ? <CheckIcon /> : state === 'failed' ? <CrossIcon /> : <KeyIcon />}
      </span>
      <div className="ps-key-text" role={state === 'failed' ? 'alert' : 'status'}>
        <p className="ps-key-title">{copy.title}</p>
        {copy.body ? <p>{copy.body}</p> : null}
        {showHint ? <p className="ps-key-hint">{VIRTUAL_KEY_HINT}</p> : null}
      </div>
      {state === 'idle' || state === 'failed' ? (
        <PrimaryAction onClick={props.onUse}>
          {state === 'failed' ? 'Try again' : (props.actionLabel ?? 'Use security key')}
        </PrimaryAction>
      ) : null}
    </div>
  );
}
