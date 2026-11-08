/**
 * Shell: /me → selected project and role, sidebar badges, hash route → screen.
 * Changing the dev user or project remounts the screen (key) and reloads /me
 * and the badges.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from './api/client';
import { Sidebar } from './components/Sidebar';
import type { Badges } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Empty, ErrorMessage, Loading } from './components/StateViews';
import { navigate, useHashRoute } from './lib/hashRoute';
import type { Route } from './lib/hashRoute';
import { REFRESH_MS, startPolling } from './lib/polling';
import type { AppStorage } from './lib/storage';
import { useAsync } from './lib/useAsync';
import { ActivityScreen } from './screens/ActivityScreen';
import { AdminScreen } from './screens/AdminScreen';
import { HomeScreen } from './screens/HomeScreen';
import { MemoryDetailScreen } from './screens/MemoryDetailScreen';
import { MemoryFormScreen } from './screens/MemoryFormScreen';
import { MemoryScreen } from './screens/MemoryScreen';
import { QuarantineDetailScreen } from './screens/QuarantineDetailScreen';
import { QuarantineScreen } from './screens/QuarantineScreen';
import { ReviewDetailScreen } from './screens/ReviewDetailScreen';
import { ReviewQueueScreen } from './screens/ReviewQueueScreen';
import { StagingScreen } from './screens/StagingScreen';
import type { ScreenProps } from './screens/types';

const NO_BADGES: Badges = { review: null, quarantine: null };
const BADGE_LIMIT = 200;

function Screen({ route, props }: { route: Route; props: ScreenProps }) {
  switch (route.name) {
    case 'home':
      return <HomeScreen {...props} />;
    case 'activity':
      return <ActivityScreen {...props} />;
    case 'staging':
      return <StagingScreen {...props} />;
    case 'review':
      return <ReviewQueueScreen {...props} />;
    case 'reviewDetail':
      return <ReviewDetailScreen {...props} itemId={route.itemId} />;
    case 'memory':
      return <MemoryScreen {...props} />;
    case 'memoryNew':
      return <MemoryFormScreen {...props} />;
    case 'memoryDetail':
      return <MemoryDetailScreen {...props} memoryId={route.memoryId} />;
    case 'memoryEdit':
      return <MemoryFormScreen {...props} memoryId={route.memoryId} />;
    case 'quarantine':
      return <QuarantineScreen {...props} />;
    case 'quarantineDetail':
      return <QuarantineDetailScreen {...props} id={route.id} />;
    case 'admin':
      return <AdminScreen {...props} />;
  }
}

export function App({ api, storage }: { api: ApiClient; storage: AppStorage }) {
  const route = useHashRoute();
  const [devUser, setDevUser] = useState(() => storage.getDevUser());
  const [chosenProject, setChosenProject] = useState<string | null>(() => storage.getProjectId());
  const me = useAsync(() => api.getMe(), [api, devUser]);
  const [badges, setBadges] = useState<Badges>(NO_BADGES);
  const [badgeTick, setBadgeTick] = useState(0);
  const mainRef = useRef<HTMLElement>(null);

  const projects = me.data?.projects ?? [];
  // Storage is untrusted: the stored project is used only if /me lists it.
  const project = projects.find((p) => p.id === chosenProject) ?? projects[0] ?? null;
  const projectId = project?.id ?? null;
  const role = project?.role ?? null;

  const refreshBadges = useCallback(() => setBadgeTick((t) => t + 1), []);

  useEffect(() => {
    if (!projectId || role !== 'project_admin') {
      setBadges(NO_BADGES);
      return;
    }
    let cancelled = false;
    // A background failure keeps the previous badge value and never blocks the shell.
    const load = (): Promise<unknown> =>
      Promise.all([
        api.listReviewQueue(projectId, { filter: 'all', limit: 1 }).then((q) => {
          if (!cancelled) setBadges((b) => ({ ...b, review: q.counters.pending }));
        }),
        api.listQuarantine(projectId, { limit: BADGE_LIMIT }).then((q) => {
          if (!cancelled) {
            setBadges((b) => ({
              ...b,
              quarantine: q.truncated ? `${BADGE_LIMIT}+` : String(q.items.length),
            }));
          }
        }),
      ]);
    load().catch((err: unknown) => console.error('[badges] load failed', err));
    const stop = startPolling(load, REFRESH_MS, document, (err, first) => {
      if (first) console.error('[badges] refresh failed', err);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [api, projectId, role, badgeTick]);

  // Move focus to the screen heading after each route change (screen readers).
  const routeKey = JSON.stringify(route);
  useEffect(() => {
    const t = window.setTimeout(() => {
      mainRef.current?.querySelector<HTMLElement>('h1')?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [routeKey]);

  function changeDevUser(email: string): void {
    storage.setDevUser(email);
    setDevUser(storage.getDevUser());
  }

  function changeProject(id: string): void {
    storage.setProjectId(id);
    setChosenProject(id);
  }

  return (
    <div className="layout">
      <Sidebar route={route} badges={badges} />
      <div className="layout__main">
        <TopBar
          me={me.data ?? null}
          projectId={projectId}
          role={role}
          devUser={devUser}
          onProjectChange={changeProject}
          onDevUserChange={changeDevUser}
        />
        <main ref={mainRef} className="screen">
          {me.status === 'loading' && <Loading />}
          {me.status === 'error' && <ErrorMessage error={me.error} onRetry={me.reload} />}
          {me.status === 'ready' && !projectId && (
            <Empty text="No perteneces a ningún proyecto. Solicita el alta por ticket." />
          )}
          {me.status === 'ready' && projectId && role && (
            <Screen
              key={`${devUser}|${projectId}`}
              route={route}
              props={{ api, projectId, role, refreshBadges, navigate }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
