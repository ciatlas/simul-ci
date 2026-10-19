import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { SimulateView } from './app/SimulateView';
import { UrlSync } from './app/UrlSync';
import { validateSearch } from './state/url';

/** One route. The search params are the scenario and the view state; `validateSearch` keeps what the picker knows. */
const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch,
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
