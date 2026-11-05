import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { isChromium, type BrandedNavigator } from './browser';

export function AppShell(props: { name: string; nav: ReactNode; children: ReactNode }) {
  return (
    <div className="ps-shell">
      <header className="ps-header">
        <span className="ps-brand">Paper Seal {props.name}</span>
        <nav className="ps-nav" aria-label="Main">
          {props.nav}
        </nav>
      </header>
      <main>{props.children}</main>
    </div>
  );
}

export function Screen(props: { title: string; lede: string; children: ReactNode }) {
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

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

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
      {props.error ? <span className="ps-field-error">{props.error}</span> : null}
      {props.hint ? <span className="ps-field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function Rows(props: { children: ReactNode }) {
  return <ul className="ps-rows">{props.children}</ul>;
}

export function Row(props: { label: ReactNode; children: ReactNode }) {
  return (
    <li>
      <span>{props.label}</span>
      <span>{props.children}</span>
    </li>
  );
}

export function Mono(props: { children: ReactNode }) {
  return <span className="ps-mono">{props.children}</span>;
}

type Loaded<T> =
  | { source: () => Promise<T>; state: 'ready'; value: T }
  | { source: () => Promise<T>; state: 'error'; message: string };

/**
 * Loads from a real source, or shows that the source is not set up. `load` is
 * null when nothing is configured. Pass a stable function, and a new one to
 * reload. Nothing here supplies placeholder data.
 */
export function Connected<T>(props: {
  title: string;
  /** Shown when `load` is null, naming what to configure. */
  notConnected: ReactNode;
  load: (() => Promise<T>) | null;
  children: (value: T) => ReactNode;
}) {
  const { load } = props;
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);

  useEffect(() => {
    if (!load) return;
    let live = true;
    load().then(
      (value) => {
        if (live) setLoaded({ source: load, state: 'ready', value });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (live) setLoaded({ source: load, state: 'error', message });
      },
    );
    return () => {
      live = false;
    };
  }, [load]);

  if (!load) return <EmptyState title={`${props.title}: not connected`}>{props.notConnected}</EmptyState>;
  if (loaded?.source !== load) return <EmptyState title={props.title}>Loading.</EmptyState>;
  if (loaded.state === 'error') {
    return <EmptyState title={`${props.title}: unavailable`}>{loaded.message}</EmptyState>;
  }
  return <Panel title={props.title}>{props.children(loaded.value)}</Panel>;
}

/** Blocks everything outside Chromium, which both registration and unlock need. */
export function ChromiumGate(props: { children: ReactNode; nav?: BrandedNavigator }) {
  const nav = props.nav ?? (globalThis.navigator as BrandedNavigator | undefined);
  if (isChromium(nav)) return <>{props.children}</>;
  return (
    <div className="ps-shell">
      <Screen title="Chromium required" lede="Paper Seal needs a Chromium browser.">
        <Panel>
          <p>Open this page in Chrome, Edge or another Chromium browser to use your security key.</p>
        </Panel>
      </Screen>
    </div>
  );
}
