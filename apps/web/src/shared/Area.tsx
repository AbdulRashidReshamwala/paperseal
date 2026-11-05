import { AppShell } from '@paperseal/ui';
import type { ReactNode } from 'react';
import { NavLink, Route, Routes } from 'react-router';

export interface AreaScreen {
  /** Relative to the area. Empty for its index. */
  path: string;
  label: string;
  element: ReactNode;
}

export function Area(props: { name: string; base: string; screens: readonly AreaScreen[] }) {
  const { base, screens } = props;
  const nav = screens.map(({ path, label }) => (
    <NavLink key={path} to={path ? `${base}/${path}` : base} end>
      {label}
    </NavLink>
  ));
  return (
    <AppShell name={props.name} nav={nav}>
      <Routes>
        {screens.map(({ path, element }) =>
          path ? <Route key={path} path={path} element={element} /> : <Route key="index" index element={element} />,
        )}
      </Routes>
    </AppShell>
  );
}
