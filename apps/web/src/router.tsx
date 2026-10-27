import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AccountPage } from './routes/account.js';
import { IndexRedirect, LoginPage, RegisterPage, RequireAuth, SetupPage } from './routes/auth.js';
import { DashboardPage } from './routes/dashboard.js';
import { JoinPage } from './routes/join.js';
import { ProjectPage } from './routes/project.js';
import { RootLayout } from './routes/root.js';
import { StatusPage } from './routes/status.js';
import { safeRedirect } from './lib/redirect.js';

// Code-based routes keep the build free of generated files.
const rootRoute = createRootRoute({ component: RootLayout });
const route = <Path extends string>(path: Path, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

const indexRoute = route('/', IndexRedirect);
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
  // Pages that need a session send visitors here with ?redirect=<path>.
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeRedirect(search.redirect);
    return redirect === undefined ? {} : { redirect };
  },
});
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
const accountRoute = route('/account', () => (
  <RequireAuth>
    <AccountPage />
  </RequireAuth>
));
const joinRoute = route('/join/$token', () => (
  <RequireAuth>
    <JoinPage />
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
    joinRoute,
    accountRoute,
  ]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
