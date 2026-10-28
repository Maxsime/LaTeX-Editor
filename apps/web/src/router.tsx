import { type ErrorCode, errorCode } from '@galley/shared';
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AccountPage } from './routes/account.js';
import { AdminPage } from './routes/admin.js';
import {
  ForgotPasswordPage,
  IndexRedirect,
  LoginPage,
  RegisterPage,
  RequireAuth,
  ResetPasswordPage,
  SetupPage,
} from './routes/auth.js';
import { DashboardPage } from './routes/dashboard.js';
import { JoinPage } from './routes/join.js';
import { PdfWindowPage } from './routes/pdf-window.js';
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
const statusRoute = route('/status', StatusPage);
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
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
