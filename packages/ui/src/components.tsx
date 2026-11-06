import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

import { isChromium, type BrandedNavigator } from "./browser";
import { Logo, Wordmark } from "./Logo";

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

export function Field(props: {
  label: string;
  hint?: string;
  error?: string | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ps-field">
      <span>{props.label}</span>
      <input
        className="ps-input"
        value={props.value}
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
}) {
  const nav =
    props.nav ?? (globalThis.navigator as BrandedNavigator | undefined);
  if (isChromium(nav)) return <>{props.children}</>;
  return (
    <div className="ps-shell">
      <header className="ps-role">
        <Wordmark />
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
        </Panel>
      </Screen>
    </div>
  );
}
