import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { SimulateView } from './app/SimulateView';
import { UrlSync } from './app/UrlSync';
import { readSearch, writeSearch } from './state/url';

/** One route. The search params are the scenario and the view state; `validateSearch` keeps what the picker knows. */
const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (raw: Record<string, unknown>) => writeSearch(readSearch(raw)),
  component: () => (
    <>
      <UrlSync />
      <SimulateView />
    </>
  ),
});

export const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
