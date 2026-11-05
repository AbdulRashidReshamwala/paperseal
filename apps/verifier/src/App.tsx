import { AppShell } from '@paperseal/ui';
import { NavLink, Route, Routes } from 'react-router';

import { Attestation, Commitments, Overview, Proof, Settings, UnlockStatus } from './screens';

export const routes = [
  { path: '/', label: 'Overview', element: <Overview /> },
  { path: '/attestation', label: 'Attestation', element: <Attestation /> },
  { path: '/commitments', label: 'Commitments', element: <Commitments /> },
  { path: '/unlock', label: 'Unlock', element: <UnlockStatus /> },
  { path: '/proof', label: 'Proof', element: <Proof /> },
  { path: '/settings', label: 'Connection', element: <Settings /> },
];

export function App() {
  const nav = routes.map(({ path, label }) => (
    <NavLink key={path} to={path} end>
      {label}
    </NavLink>
  ));
  return (
    <AppShell name="Verifier" nav={nav}>
      <Routes>
        {routes.map(({ path, element }) => (
          <Route key={path} path={path} element={element} />
        ))}
      </Routes>
    </AppShell>
  );
}
