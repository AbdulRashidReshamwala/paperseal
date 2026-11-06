import { LoadingSeal, Page } from '@paperseal/ui';
import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router';

import { RouteFade } from './shared/RouteFade';
import type { GatedRole } from './shared/RolePage';
import './shared/home.css';

// Lazy, so each role downloads only its own code. Do not import an area statically.
const areas: { role: GatedRole; path: string; label: string; plain: string; Area: LazyExoticComponent<ComponentType> }[] = [
  {
    role: 'board',
    path: '/board',
    label: 'Exam board',
    plain: 'Set up the exam and see it through.',
    Area: lazy(() => import('./areas/board/BoardArea')),
  },
  {
    role: 'setter',
    path: '/setter',
    label: 'Question setter',
    plain: 'Write the questions.',
    Area: lazy(() => import('./areas/setter/SetterArea')),
  },
  {
    role: 'centre',
    path: '/centre',
    label: 'Exam centre',
    plain: 'Open the sealed paper on exam day.',
    Area: lazy(() => import('./areas/centre/CentreArea')),
  },
  {
    role: 'keyholder',
    path: '/keyholder',
    label: 'Key holder',
    plain: 'Release your part of the key.',
    Area: lazy(() => import('./areas/keyholder/KeyholderArea')),
  },
];

// Lazy too, because it brings the chain client with it. It decides before an area's code is asked for.
const RoleGate = lazy(() => import('./shared/RoleGate'));
const Join = lazy(() => import('./shared/Join'));
const Enrol = lazy(() => import('./shared/Enrol'));
const ExamPage = lazy(() => import('./shared/ExamPage'));

function Home() {
  return (
    <Page>
      <h1 className="ps-stage-title home-title">What is your part in this exam?</h1>
      <p className="ps-stage-lede">Paper Seal keeps an exam paper sealed until it is due. No one person can open it.</p>
      <ul className="home-tiles">
        {areas.map(({ path, label, plain }) => (
          <li key={path} className="home-tile">
            <Link to={path}>{label}</Link>
            <p>{plain}</p>
          </li>
        ))}
      </ul>
      <p className="home-setup">
        Key holders and centres: <Link to="/enrol">set up your security key</Link> once, before exam day.
      </p>
    </Page>
  );
}

/**
 * A registration link names its exam, so it works in a browser that has never seen that exam. It is
 * only the pointer, and all exam data is still read from ExamRegistry. Lazy, like the areas, because
 * currentExam brings the chain client with it.
 */
function ExamFromLink() {
  const exam = new URLSearchParams(useLocation().search).get('exam');
  useEffect(() => {
    if (!exam || !/^0x[0-9a-f]{64}$/.test(exam)) return;
    void import('./shared/currentExam').then(({ setCurrentExamId }) => {
      setCurrentExamId(exam as `0x${string}`);
    });
  }, [exam]);
  return null;
}

/**
 * One route. A router navigation is a React transition, and a transition leaves the old page up with no
 * sign of waiting while a chunk loads. Only a new Suspense boundary shows its fallback, so each route has
 * its own, and needs its own key to count as new. The key stays the same across an area's inner routes,
 * so the board keeps its provider.
 */
function Screen(props: { children: ReactNode }) {
  return (
    <Suspense fallback={<LoadingSeal />}>
      <RouteFade>{props.children}</RouteFade>
    </Suspense>
  );
}

export function App() {
  return (
    <Suspense fallback={<LoadingSeal />}>
      <ExamFromLink />
      <Routes>
        <Route path="/" element={<Screen key="home"><Home /></Screen>} />
        <Route path="/join" element={<Screen key="join"><Join /></Screen>} />
        <Route path="/enrol" element={<Screen key="enrol"><Enrol /></Screen>} />
        <Route path="/exam" element={<Screen key="exam"><ExamPage /></Screen>} />
        {areas.map(({ role, path, Area }) => (
          <Route key={path} path={`${path}/*`} element={<Screen key={path}><RoleGate role={role}><Area /></RoleGate></Screen>} />
        ))}
      </Routes>
    </Suspense>
  );
}
