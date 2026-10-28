import type { NotificationSettings } from '@galley/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

const notificationsKey = ['me', 'notifications'] as const;

/** The user's e-mail notification settings. */
export function useNotificationSettings() {
  return useQuery({
    queryKey: notificationsKey,
    queryFn: () => api<NotificationSettings>('GET', '/api/me/notifications'),
  });
}

export function useUpdateNotificationSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: NotificationSettings) =>
      api<NotificationSettings>('PATCH', '/api/me/notifications', { json: settings }),
    onSuccess: (settings) => {
      client.setQueryData(notificationsKey, settings);
    },
  });
}
