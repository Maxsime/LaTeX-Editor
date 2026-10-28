import {
  type AdminUser,
  type AdminUsersResponse,
  type AiModelPrice,
  aiModelPrice,
  type CreatedInvite,
  type CreateUserRequest,
  type InstanceSettingsResponse,
  type Invite,
  type QuotaUsage,
  type SystemStatus,
  type TemporaryPasswordResponse,
  type UpdateInstanceSettingsRequest,
  type UpdateUserRequest,
} from '@galley/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

const adminKey = ['admin'] as const;

// --- Pure helpers ---------------------------------------------------------------------

/** Bytes in the largest fitting binary unit, e.g. "1,5 Mo" in French. */
export function formatBytes(bytes: number, locale: string): string {
  const units = locale.startsWith('fr')
    ? ['o', 'ko', 'Mo', 'Go', 'To']
    : ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit] ?? ''}`;
}

/** Whole minutes of a duration in seconds, rounded up so that a started minute shows. */
export function minutesOf(seconds: number): number {
  return Math.ceil(seconds / 60);
}

/**
 * Reads a quota typed in a form: empty for none (null), a positive whole
 * number otherwise; `allowUnlimited` also accepts -1 for a person's lifted limit.
 * Returns undefined when the text is not acceptable.
 */
export function parseQuota(text: string, allowUnlimited = false): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (allowUnlimited && value === -1) return -1;
  return value > 0 && value <= 10_000_000 ? value : undefined;
}

/** Text of a quota in a form field. */
export function quotaText(value: number | null): string {
  return value === null ? '' : String(value);
}

/** Share of a limit used, between 0 and 1; null when unlimited. */
export function usedShare(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit === 0) return 1;
  return Math.min(1, used / limit);
}

const CSV_HEADER = 'provider,model,inputPerMTok,outputPerMTok,cachedInputPerMTok,currency';

/** The price table as editable CSV, one model per line. */
export function pricesToCsv(prices: readonly AiModelPrice[]): string {
  return [
    CSV_HEADER,
    ...prices.map((price) =>
      [
        price.provider,
        price.model,
        price.inputPerMTok,
        price.outputPerMTok,
        price.cachedInputPerMTok ?? '',
        price.currency,
      ].join(','),
    ),
  ].join('\n');
}

/**
 * Parses the CSV of {@link pricesToCsv}. Returns the prices, or the number of
 * the first line that is not valid (counting from 1).
 */
export function pricesFromCsv(text: string): { prices: AiModelPrice[] } | { line: number } {
  const prices: AiModelPrice[] = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line === CSV_HEADER) continue;
    const [provider, model, input, output, cached, currency, ...rest] = line
      .split(',')
      .map((cell) => cell.trim());
    const number = (cell: string | undefined) =>
      cell === undefined || cell === '' ? NaN : Number(cell);
    const parsed = aiModelPrice.safeParse({
      provider,
      model,
      inputPerMTok: number(input),
      outputPerMTok: number(output),
      cachedInputPerMTok: cached === undefined || cached === '' ? null : number(cached),
      currency: currency?.toUpperCase(),
    });
    if (!parsed.success || rest.length > 0) return { line: index + 1 };
    prices.push(parsed.data);
  }
  return { prices };
}

// --- Queries ------------------------------------------------------------------------

export function useInstanceSettings() {
  return useQuery({
    queryKey: [...adminKey, 'settings'],
    queryFn: () => api<InstanceSettingsResponse>('GET', '/api/admin/settings'),
  });
}

export function useUpdateInstanceSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateInstanceSettingsRequest) =>
      api<InstanceSettingsResponse>('PATCH', '/api/admin/settings', { json: body }),
    onSuccess: async (settings) => {
      client.setQueryData([...adminKey, 'settings'], settings);
      // Registration mode and the default model show elsewhere too.
      await client.invalidateQueries({ queryKey: ['auth', 'config'] });
      await client.invalidateQueries({ queryKey: ['ai'] });
    },
  });
}

export function useAdminUsers(q: string, offset: number) {
  return useQuery({
    queryKey: [...adminKey, 'users', q, offset],
    queryFn: () =>
      api<AdminUsersResponse>('GET', '/api/admin/users', {
        query: { q, offset: String(offset) },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useAdminUserMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [...adminKey, 'users'] });
  return {
    create: useMutation({
      mutationFn: (body: CreateUserRequest) =>
        api<TemporaryPasswordResponse>('POST', '/api/admin/users', { json: body }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: UpdateUserRequest & { id: string }) =>
        api<{ user: AdminUser }>('PATCH', `/api/admin/users/${id}`, { json: body }),
      onSuccess: refresh,
    }),
    resetPassword: useMutation({
      mutationFn: (id: string) =>
        api<TemporaryPasswordResponse>('POST', `/api/admin/users/${id}/password`, { json: {} }),
      onSuccess: refresh,
    }),
  };
}

export function useSystemStatus() {
  return useQuery({
    queryKey: [...adminKey, 'system'],
    queryFn: () => api<SystemStatus>('GET', '/api/admin/system'),
    refetchInterval: 10_000,
  });
}

export function useInvites() {
  return useQuery({
    queryKey: [...adminKey, 'invites'],
    queryFn: () =>
      api<{ invites: Invite[] }>('GET', '/api/admin/invites').then((body) => body.invites),
  });
}

export function useInviteMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [...adminKey, 'invites'] });
  return {
    create: useMutation({
      mutationFn: (expiresInDays: number) =>
        api<CreatedInvite>('POST', '/api/admin/invites', { json: { expiresInDays } }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api('DELETE', `/api/admin/invites/${id}`),
      onSettled: refresh,
    }),
  };
}

export function useAiPrices() {
  return useQuery({
    queryKey: [...adminKey, 'prices'],
    queryFn: () =>
      api<{ prices: AiModelPrice[] }>('GET', '/api/admin/ai/prices').then((body) => body.prices),
  });
}

export function useSaveAiPrices() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (prices: AiModelPrice[]) =>
      api<{ prices: AiModelPrice[] }>('PUT', '/api/admin/ai/prices', { json: { prices } }),
    onSuccess: ({ prices }) => {
      client.setQueryData([...adminKey, 'prices'], prices);
    },
  });
}

/** The signed-in person's quotas and what they used. */
export function useMyQuotas() {
  return useQuery({
    queryKey: ['me', 'quotas'],
    queryFn: () => api<QuotaUsage>('GET', '/api/me/quotas'),
  });
}
