import { LoadingSeal, Page, Row, Rows, RoleHeader, Seal, Stage } from '@paperseal/ui';
import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router';

import { RouteFade } from './shared/RouteFade';

// Lazy, so each role downloads only its own code. Do not import an area statically.
const areas: { path: string; label: string; plain: string; Area: LazyExoticComponent<ComponentType> }[] = [
  {
    path: '/board',
    label: 'Exam board',
    plain: 'You set up the exam and see it through to exam day.',
    Area: lazy(() => import('./areas/board/BoardArea')),
  },
  {
    path: '/setter',
    label: 'Question setter',
    plain: 'You write questions for the exam.',
    Area: lazy(() => import('./areas/setter/SetterArea')),
  },
  {
    path: '/centre',
    label: 'Exam centre',
    plain: 'You receive the sealed paper and open it on exam day.',
    Area: lazy(() => import('./areas/centre/CentreArea')),
  },
  {
    path: '/keyholder',
    label: 'Key holder',
    plain: 'You hold part of the key and release it on exam day.',
    Area: lazy(() => import('./areas/keyholder/KeyholderArea')),
  },
];

const Join = lazy(() => import('./shared/Join'));
const Enrol = lazy(() => import('./shared/Enrol'));
const ExamPage = lazy(() => import('./shared/ExamPage'));

function Home() {
  return (
    <Page header={<RoleHeader role="Welcome" />}>
      <Seal state="sealed" size={80} label="The Paper Seal" />
      <Stage
        title="What is your part in this exam?"
        lede="Paper Seal keeps an exam paper sealed until it is due. No one person can open it."
        action={
          <Rows>
            {areas.map(({ path, label, plain }) => (
              <Row key={path} label={<Link to={path}>{label}</Link>}>
                {plain}
              </Row>
            ))}
            <Row label={<Link to="/enrol">Set up your security key</Link>}>You do this once, if you are a key holder or an exam centre.</Row>
          </Rows>
        }
        next="Your page shows you the one thing to do next."
      />
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
        {areas.map(({ path, Area }) => (
          <Route key={path} path={`${path}/*`} element={<Screen key={path}><Area /></Screen>} />
        ))}
      </Routes>
    </Suspense>
  );
}
