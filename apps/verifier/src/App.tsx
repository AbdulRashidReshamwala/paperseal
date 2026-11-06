import { HistoryPage } from './history-page';
import { isHistoryRoute, useRoute } from './link';
import { VerifierPage } from './page';

/** The exam's state decides what the page shows. `#/exams` lists the exams on the record instead. */
export function App() {
  const route = useRoute();
  return isHistoryRoute(route.routePath) ? <HistoryPage /> : <VerifierPage />;
}
