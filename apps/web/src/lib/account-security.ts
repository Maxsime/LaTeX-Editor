import type {
  AccountSession,
  AccountSessionsResponse,
  ChangePasswordRequest,
} from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { sessionKey } from './session.js';

const sessionsKey = ['account', 'sessions'] as const;

export function useAccountSessions() {
  return useQuery({
    queryKey: sessionsKey,
    queryFn: () =>
      api<AccountSessionsResponse>('GET', '/api/me/sessions').then((body) => body.sessions),
  });
}

export function useAccountSecurityMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: sessionsKey });
  return {
    changePassword: useMutation({
      mutationFn: (input: ChangePasswordRequest) =>
        api('POST', '/api/me/password', { json: input }),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: (session: AccountSession) => api('DELETE', `/api/me/sessions/${session.id}`),
      onSuccess: (_result, session) =>
        // Revoking the current session signs this browser out.
        session.current ? client.invalidateQueries({ queryKey: sessionKey }) : refresh(),
    }),
    revokeOthers: useMutation({
      mutationFn: () => api('DELETE', '/api/me/sessions'),
      onSettled: refresh,
    }),
  };
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  [/^git\//, 'Git'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone|\biPad|\biPod/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/**
 * Browser and system named by a User-Agent header, enough to recognise one's
 * own devices in the session list; `null` parts when not recognised.
 */
export function describeUserAgent(userAgent: string | null): {
  browser: string | null;
  os: string | null;
} {
  if (userAgent === null) return { browser: null, os: null };
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  return { browser, os };
}
