import { Compass } from 'lucide-react';
import { lazy } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { EmptyState } from './components/ui/primitives';

const OverviewPage = lazy(() => import('./pages/OverviewPage'));
const RadarPage = lazy(() => import('./pages/RadarPage'));
const IdeaPage = lazy(() => import('./pages/IdeaPage'));
const PlaceholderPage = lazy(() => import('./pages/PlaceholderPage'));

function NotFound() {
  return (
    <div className="page">
      <div className="panel">
        <EmptyState
          icon={<Compass size={22} />}
          title="Страница не найдена"
          action={
            <Link to="/" className="btn btn--ghost">
              На обзор
            </Link>
          }
        >
          Такого раздела нет в Venture Lab.
        </EmptyState>
      </div>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="radar" element={<RadarPage />} />
        <Route path="ideas/:slug" element={<IdeaPage />} />
        <Route path="validation" element={<PlaceholderPage which="validation" />} />
        <Route path="build" element={<PlaceholderPage which="build" />} />
        <Route path="portfolio" element={<PlaceholderPage which="portfolio" />} />
        <Route path="journal" element={<PlaceholderPage which="journal" />} />
        <Route path="settings" element={<PlaceholderPage which="settings" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
