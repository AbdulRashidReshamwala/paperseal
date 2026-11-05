import { Panel, Screen } from '@paperseal/ui';
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Link, Route, Routes } from 'react-router';

// Lazy, so each role downloads only its own code. Do not import an area statically.
const areas: { path: string; label: string; Area: LazyExoticComponent<ComponentType> }[] = [
  { path: '/board', label: 'Board', Area: lazy(() => import('./areas/board/BoardArea')) },
  { path: '/setter', label: 'Setter', Area: lazy(() => import('./areas/setter/SetterArea')) },
  { path: '/centre', label: 'Centre', Area: lazy(() => import('./areas/centre/CentreArea')) },
  { path: '/keyholder', label: 'Key holder', Area: lazy(() => import('./areas/keyholder/KeyholderArea')) },
];

function Home() {
  return (
    <div className="ps-shell">
      <Screen title="Paper Seal" lede="Choose your role.">
        {areas.map(({ path, label }) => (
          <Panel key={path}>
            <Link to={path}>{label}</Link>
          </Panel>
        ))}
      </Screen>
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<div className="ps-shell">Loading.</div>}>
      <Routes>
        <Route path="/" element={<Home />} />
        {areas.map(({ path, Area }) => (
          <Route key={path} path={`${path}/*`} element={<Area />} />
        ))}
      </Routes>
    </Suspense>
  );
}
