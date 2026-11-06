import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

import { isChromium, type BrandedNavigator } from "./browser";
import { HomeMark, Logo } from "./Logo";

export function AppShell(props: {
  name: string;
  nav: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ps-shell">
      <header className="ps-header">
        <span className="ps-brand">
          <Logo decorative />
          Paper Seal {props.name}
        </span>
        <nav className="ps-nav" aria-label="Main">
          {props.nav}
        </nav>
      </header>
      <main>{props.children}</main>
    </div>
  );
}

export function Screen(props: {
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <section className="ps-screen">
      <h1>{props.title}</h1>
      <p className="ps-lede">{props.lede}</p>
      {props.children}
    </section>
  );
}

export function Panel(props: { title?: string; children: ReactNode }) {
  return (
    <div className="ps-panel">
      {props.title ? <h2>{props.title}</h2> : null}
      {props.children}
    </div>
  );
}

export function EmptyState(props: { title: string; children: ReactNode }) {
  return (
    <Panel title={props.title}>
      <p className="ps-empty">{props.children}</p>
    </Panel>
  );
}

export type Tone = "ok" | "warn" | "bad" | "neutral";

export function Badge(props: { tone: Tone; children: ReactNode }) {
  return (
    <span className="ps-badge" data-tone={props.tone}>
      {props.children}
    </span>
  );
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className="ps-button" {...props} />;
}

/**
 * Copies `text` (a function is read at the press, so a link always has its fragment) and says so.
 * When the browser won't allow it, the text is shown to select by hand.
 */
export function CopyButton(props: {
  text: string | (() => string);
  children: ReactNode;
  copied?: string;
  "aria-label"?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [shown, setShown] = useState("");
  const onClick = () => {
    const text = typeof props.text === "function" ? props.text() : props.text;
    setShown(text);
    // navigator.clipboard is missing outside a secure context.
    const nav = globalThis.navigator as Navigator | undefined;
    let written: Promise<void> | undefined;
    try {
      written = nav?.clipboard?.writeText(text);
    } catch {
      written = undefined;
    }
    if (!written) {
      setState("failed");
      return;
    }
    written.then(
      () => {
        setState("copied");
      },
      () => {
        setState("failed");
      },
    );
  };
  return (
    <span className="ps-copy">
      <Button
        {...(props["aria-label"] ? { "aria-label": props["aria-label"] } : {})}
        onClick={onClick}
      >
        {state === "copied" ? (props.copied ?? "Copied") : props.children}
      </Button>
      {state === "failed" ? (
        <>
          <span role="status">
            It could not be copied. Select the text below and copy it yourself.
          </span>
          <span className="ps-mono" style={{ whiteSpace: "pre-wrap" }}>
            {shown}
          </span>
        </>
      ) : null}
    </span>
  );
}

export function Field(props: {
  label: string;
  hint?: string;
  error?: string | undefined;
  value: string;
  /** The id of a `datalist` to suggest from. */
  list?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ps-field">
      <span>{props.label}</span>
      <input
        className="ps-input"
        value={props.value}
        {...(props.list ? { list: props.list } : {})}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={props.error ? true : undefined}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
      {props.error ? (
        <span className="ps-field-error">{props.error}</span>
      ) : null}
      {props.hint ? <span className="ps-field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function Rows(props: { children: ReactNode }) {
  return <ul className="ps-rows">{props.children}</ul>;
}

/** `muted` greys the row out, for content that has not been verified and should not read as fact. */
export function Row(props: {
  label: ReactNode;
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <li data-muted={props.muted ? "true" : undefined}>
      <span>{props.label}</span>
      <span>{props.children}</span>
    </li>
  );
}

export function Mono(props: { children: ReactNode }) {
  return <span className="ps-mono">{props.children}</span>;
}

type Loaded<T> =
  | { source: () => Promise<T>; state: "ready"; value: T }
  | { source: () => Promise<T>; state: "error"; message: string };

/**
 * Loads from a real source, or shows that the source is not set up. `load` is
 * null when nothing is configured. Pass a stable function, and a new one to
 * reload. Nothing here supplies placeholder data. With `pollMs`, the source is read again that
 * long after each read finishes, so a slow source is never read twice at once.
 */
export function Connected<T>(props: {
  title: string;
  /** Shown when `load` is null, naming what to configure. */
  notConnected: ReactNode;
  load: (() => Promise<T>) | null;
  /** Milliseconds between reads. Unset reads once per `load`. */
  pollMs?: number;
  children: (value: T) => ReactNode;
}) {
  const { load, pollMs } = props;
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);

  useEffect(() => {
    if (!load) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      load()
        .then(
          (value) => {
            if (live) setLoaded({ source: load, state: "ready", value });
          },
          (error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            if (live) setLoaded({ source: load, state: "error", message });
          },
        )
        .finally(() => {
          if (live && pollMs !== undefined && pollMs > 0)
            timer = setTimeout(read, pollMs);
        });
    };
    read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, pollMs]);

  if (!load)
    return (
      <EmptyState title={`${props.title}: not set up yet`}>
        {props.notConnected}
      </EmptyState>
    );
  if (loaded?.source !== load)
    return <EmptyState title={props.title}>One moment.</EmptyState>;
  if (loaded.state === "error") {
    return (
      <EmptyState title={`${props.title}: not available right now`}>
        <p>
          This page keeps trying. If it stays like this, contact your exam
          board.
        </p>
        <details>
          <summary>Details</summary>
          {loaded.message}
        </details>
      </EmptyState>
    );
  }
  return <Panel title={props.title}>{props.children(loaded.value)}</Panel>;
}

/** Blocks everything outside Chromium, which both registration and unlock need. */
export function ChromiumGate(props: {
  children: ReactNode;
  nav?: BrandedNavigator;
  /** The address to copy. Defaults to this page's, with its fragment. */
  href?: string;
}) {
  const nav =
    props.nav ?? (globalThis.navigator as BrandedNavigator | undefined);
  if (isChromium(nav)) return <>{props.children}</>;
  return (
    <div className="ps-shell">
      <header className="ps-role">
        <HomeMark />
      </header>
      <Screen
        title="Open this page in Chrome"
        lede="Paper Seal does not work in this browser."
      >
        <Panel>
          <p>
            Open this page in Chrome or Edge on a computer. Then use your
            security key.
          </p>
          <p>
            <CopyButton
              text={() =>
                props.href ??
                (globalThis.location as Location | undefined)?.href ??
                ""
              }
            >
              Copy link
            </CopyButton>
          </p>
        </Panel>
      </Screen>
    </div>
  );
}
