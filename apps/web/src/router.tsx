import { type ErrorCode, errorCode } from '@galley/shared';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import {
  ForgotPasswordPage,
  IndexRedirect,
  LoginPage,
  RegisterPage,
  RequireAuth,
  ResetPasswordPage,
  SetupPage,
} from './routes/auth.js';
import { RootLayout } from './routes/root.js';
import { RouteError } from './components/RouteError.js';
import { safeRedirect } from './lib/redirect.js';

// Pages behind a session load on demand: the sign-in page, the first one most visitors
// see, does not wait for the editor, the dashboard or the administration.
const AccountPage = lazyRouteComponent(() => import('./routes/account.js'), 'AccountPage');
const AdminPage = lazyRouteComponent(() => import('./routes/admin.js'), 'AdminPage');
const DashboardPage = lazyRouteComponent(() => import('./routes/dashboard.js'), 'DashboardPage');
const JoinPage = lazyRouteComponent(() => import('./routes/join.js'), 'JoinPage');
const PdfWindowPage = lazyRouteComponent(() => import('./routes/pdf-window.js'), 'PdfWindowPage');
const ProjectPage = lazyRouteComponent(() => import('./routes/project.js'), 'ProjectPage');
const StatusPage = lazyRouteComponent(() => import('./routes/status.js'), 'StatusPage');

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
  // A failed sign-in through the identity provider comes back with ?error=<code>.
  validateSearch: (search: Record<string, unknown>): { redirect?: string; error?: ErrorCode } => {
    const redirect = safeRedirect(search.redirect);
    const error = errorCode.safeParse(search.error);
    return {
      ...(redirect === undefined ? {} : { redirect }),
      ...(error.success ? { error: error.data } : {}),
    };
  },
});
const setupRoute = route('/setup', SetupPage);
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status',
  component: StatusPage,
});
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: RegisterPage,
  // Invitation links look like /register?invite=<token>.
  validateSearch: (search: Record<string, unknown>): { invite?: string } =>
    typeof search.invite === 'string' ? { invite: search.invite } : {},
});
const forgotPasswordRoute = route('/forgot-password', ForgotPasswordPage);
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  component: ResetPasswordPage,
  // Reset links look like /reset-password?token=<token>.
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search.token === 'string' ? { token: search.token } : {},
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
const pdfWindowRoute = route('/projects/$projectId/pdf', () => (
  <RequireAuth>
    <PdfWindowPage />
  </RequireAuth>
));
const accountRoute = route('/account', () => (
  <RequireAuth>
    <AccountPage />
  </RequireAuth>
));
const adminRoute = route('/admin', () => (
  <RequireAuth>
    <AdminPage />
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
    forgotPasswordRoute,
    resetPasswordRoute,
    statusRoute,
    projectsRoute,
    projectRoute,
    pdfWindowRoute,
    joinRoute,
    accountRoute,
    adminRoute,
  ]),
  // A failed render shows a way out instead of a blank page.
  defaultErrorComponent: RouteError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
