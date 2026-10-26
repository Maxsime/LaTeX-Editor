import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { IndexRedirect, LoginPage, RegisterPage, RequireAuth, SetupPage } from './routes/auth.js';
import { DashboardPage } from './routes/dashboard.js';
import { ProjectPage } from './routes/project.js';
import { RootLayout } from './routes/root.js';
import { StatusPage } from './routes/status.js';

// Code-based routes keep the build free of generated files.
const rootRoute = createRootRoute({ component: RootLayout });
const route = <Path extends string>(path: Path, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

const indexRoute = route('/', IndexRedirect);
const loginRoute = route('/login', LoginPage);
const setupRoute = route('/setup', SetupPage);
const statusRoute = route('/status', StatusPage);
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: RegisterPage,
  // Invitation links look like /register?invite=<token>.
  validateSearch: (search: Record<string, unknown>): { invite?: string } =>
    typeof search.invite === 'string' ? { invite: search.invite } : {},
});
const projectsRoute = route('/projects', () => (
  <RequireAuth>
    <DashboardPage />
  </RequireAuth>
));
const projectRoute = route('/projects/$projectId', () => (
  <RequireAuth>
    <ProjectPage />
  </RequireAuth>
));

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    loginRoute,
    setupRoute,
    registerRoute,
    statusRoute,
    projectsRoute,
    projectRoute,
  ]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
