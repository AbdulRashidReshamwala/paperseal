import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router';

export interface AreaScreen {
  /** Relative to the area. Empty for its index. */
  path: string;
  element: ReactNode;
}

/** An area's routes. State picks what each one shows, so there are no tabs, and each stays a deep link. */
export function Area(props: { screens: readonly AreaScreen[] }) {
  return (
    <Routes>
      {props.screens.map(({ path, element }) =>
        path ? <Route key={path} path={path} element={element} /> : <Route key="index" index element={element} />,
      )}
    </Routes>
  );
}
