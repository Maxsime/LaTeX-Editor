import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { HomePage } from './routes/home.js';
import { RootLayout } from './routes/root.js';

// Code-based routes keep J0 free of generated files; file-based routing can
// replace this once the route tree grows.
const rootRoute = createRootRoute({ component: RootLayout });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });

export const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
