import {
  adminUsersQuery,
  type AdminUsersResponse,
  ApiError,
  createInviteRequest,
  type CreatedInvite,
  createUserRequest,
  type InstanceSettingsResponse,
  type Invite,
  type QuotaUsage,
  type SystemStatus,
  type TemporaryPasswordResponse,
  TEXLIVE_VERSION_KEY,
  updateInstanceSettingsRequest,
  updateUserRequest,
} from '@galley/shared';
import { count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { quotaUsageOf } from '../admin/quotas.js';
import {
  type EffectiveSettings,
  INSTANCE_AI_KEY_CONTEXT,
  instanceSettingsOf,
  type StoredAiDefault,
} from '../admin/settings.js';
import {
  adminUserById,
  assertAnotherAdmin,
  listAdminUsers,
  temporaryPassword,
} from '../admin/users.js';
import { instanceModel } from '../ai/settings.js';
import { hashPassword } from '../auth/password.js';
import { requireAdmin, requireAuth } from '../auth/plugin.js';
import { deleteUserSessions } from '../auth/sessions.js';
import { randomToken, tokenDigest } from '../auth/tokens.js';
import { createUser } from '../auth/users.js';
import type { ApiConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createSecretBox, keyHint, requireSecretBox } from '../crypto/secrets.js';
import {
  compileRuns,
  files,
  projects,
  registrationInvites,
  sessions,
  userQuotas,
  users,
} from '@galley/db';
import { parse } from '../http/validate.js';
import { oidcEnabled } from '../auth/oidc.js';

const idParams = z.object({ id: z.uuid() });

function toInvite(row: typeof registrationInvites.$inferSelect): Invite {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
  };
}

/** The console's view of the settings: the default model without its key. */
function settingsResponse(
  config: ApiConfig,
  settings: EffectiveSettings,
): InstanceSettingsResponse {
  const stored = settings.aiDefault;
  let aiDefault: InstanceSettingsResponse['aiDefault'] = null;
  if (stored !== null) {
    aiDefault = {
      provider: stored.provider,
      model: stored.model,
      baseUrl: stored.baseUrl,
      keyHint: stored.keyHint,
      vision: stored.vision,
      contextTokens: stored.contextTokens,
    };
  } else {
    // The environment's key is never decrypted: there is nothing to open.
    const fromEnvironment = instanceModel(config, settings, null);
    if (fromEnvironment !== null) {
      aiDefault = {
        provider: fromEnvironment.config.provider,
        model: fromEnvironment.config.model,
        baseUrl: fromEnvironment.config.baseUrl ?? null,
        keyHint: fromEnvironment.keyHint,
        vision: fromEnvironment.overrides.vision ?? null,
        contextTokens: fromEnvironment.overrides.contextTokens ?? null,
      };
    }
  }
  return {
    registrationMode: settings.registrationMode,
    quotas: settings.quotas,
    aiEnabled: settings.aiEnabled,
    aiDefault,
    overridden: settings.overridden,
  };
}

/** Instance-level administration. Every route requires an administrator. */
export function adminRoutes(app: FastifyInstance, context: AppContext, version: string): void {
  const { database, config, redis } = context;
  const { db } = database;
  const settings = instanceSettingsOf(context);
  const secrets = createSecretBox(config.GALLEY_MASTER_KEY);

  app.get('/api/admin/invites', async (request): Promise<{ invites: Invite[] }> => {
    requireAdmin(request);
    const rows = await db
      .select()
      .from(registrationInvites)
      .orderBy(desc(registrationInvites.createdAt))
      .limit(200);
    return { invites: rows.map(toInvite) };
  });

  app.post('/api/admin/invites', async (request, reply) => {
    const auth = requireAdmin(request);
    const body = parse(createInviteRequest, request.body ?? {});
    const token = randomToken();
    const [row] = await db
      .insert(registrationInvites)
      .values({
        tokenHash: tokenDigest(token),
        createdBy: auth.user.id,
        expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000),
      })
      .returning();
    if (!row) throw new ApiError('INTERNAL_ERROR');
    const created: CreatedInvite = { invite: toInvite(row), token };
    return reply.status(201).send(created);
  });

  app.delete('/api/admin/invites/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const deleted = await db
      .delete(registrationInvites)
      .where(eq(registrationInvites.id, id))
      .returning({ id: registrationInvites.id });
    if (deleted.length === 0) throw new ApiError('NOT_FOUND');
    return reply.status(204).send();
  });

  // --- Instance settings ------------------------------------------------------------

  app.get('/api/admin/settings', async (request): Promise<InstanceSettingsResponse> => {
    requireAdmin(request);
    return settingsResponse(config, await settings.get());
  });

  app.patch('/api/admin/settings', async (request): Promise<InstanceSettingsResponse> => {
    const auth = requireAdmin(request);
    const body = parse(updateInstanceSettingsRequest, request.body);
    const by = auth.user.id;
    if (body.registrationMode !== undefined) {
      await settings.set('registrationMode', body.registrationMode, by);
    }
    if (body.quotas !== undefined) await settings.set('quotas', body.quotas, by);
    if (body.aiEnabled !== undefined) await settings.set('aiEnabled', body.aiEnabled, by);
    if (body.aiDefault === null) {
      await settings.reset('aiDefault');
    } else if (body.aiDefault !== undefined) {
      const next = body.aiDefault;
      const current = (await settings.get()).aiDefault;
      // A key belongs to one provider: changing provider without a new key drops it.
      const kept =
        next.apiKey === undefined && current?.provider === next.provider ? current : null;
      const stored: StoredAiDefault = {
        provider: next.provider,
        model: next.model,
        baseUrl: next.baseUrl,
        keyCiphertext:
          next.apiKey === undefined
            ? (kept?.keyCiphertext ?? null)
            : requireSecretBox(secrets)
                .seal(next.apiKey, INSTANCE_AI_KEY_CONTEXT)
                .toString('base64'),
        keyHint: next.apiKey === undefined ? (kept?.keyHint ?? null) : keyHint(next.apiKey),
        vision: next.vision,
        contextTokens: next.contextTokens,
      };
      await settings.set('aiDefault', stored, by);
    }
    request.log.info({ keys: Object.keys(body) }, 'instance settings changed');
    return settingsResponse(config, await settings.get());
  });

  // --- Users ------------------------------------------------------------------------

  app.get('/api/admin/users', async (request): Promise<AdminUsersResponse> => {
    requireAdmin(request);
    return listAdminUsers(db, parse(adminUsersQuery, request.query));
  });

  app.post('/api/admin/users', async (request, reply) => {
    requireAdmin(request);
    const body = parse(createUserRequest, request.body);
    const password = temporaryPassword();
    const created = await createUser(db, { ...body, password }, body.isAdmin);
    request.log.info({ targetUserId: created.id }, 'account created by an administrator');
    const response: TemporaryPasswordResponse = {
      user: await adminUserById(db, created.id),
      temporaryPassword: password,
    };
    return reply.status(201).send(response);
  });

  app.patch('/api/admin/users/:id', async (request) => {
    requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const body = parse(updateUserRequest, request.body);
    const disabledNow = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!row) throw new ApiError('NOT_FOUND');
      const losesAdmin =
        row.isAdmin &&
        row.disabledAt === null &&
        (body.isAdmin === false || body.disabled === true);
      if (losesAdmin) await assertAnotherAdmin(tx, id);
      const changes: Partial<typeof users.$inferInsert> = {};
      if (body.isAdmin !== undefined) changes.isAdmin = body.isAdmin;
      if (body.disabled !== undefined) {
        changes.disabledAt = body.disabled ? (row.disabledAt ?? new Date()) : null;
      }
      if (Object.keys(changes).length > 0) {
        await tx.update(users).set(changes).where(eq(users.id, id));
      }
      if (body.quotas !== undefined) {
        const { storageMb, compileMinutes } = body.quotas;
        if (storageMb === null && compileMinutes === null) {
          await tx.delete(userQuotas).where(eq(userQuotas.userId, id));
        } else {
          await tx
            .insert(userQuotas)
            .values({ userId: id, storageMb, compileMinutes })
            .onConflictDoUpdate({
              target: userQuotas.userId,
              set: { storageMb, compileMinutes, updatedAt: sql`now()` },
            });
        }
      }
      return body.disabled === true && row.disabledAt === null;
    });
    // Disabled accounts are refused at session lookup; closing them frees the rows.
    if (disabledNow) await deleteUserSessions(database, id);
    request.log.info({ targetUserId: id, fields: Object.keys(body) }, 'account changed');
    return { user: await adminUserById(db, id) };
  });

  app.post('/api/admin/users/:id/password', async (request): Promise<TemporaryPasswordResponse> => {
    requireAdmin(request);
    const { id } = parse(idParams, request.params);
    const password = temporaryPassword();
    const updated = await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (updated.length === 0) throw new ApiError('NOT_FOUND');
    await deleteUserSessions(database, id);
    request.log.info({ targetUserId: id }, 'password reset by an administrator');
    return { user: await adminUserById(db, id), temporaryPassword: password };
  });

  // --- Services ---------------------------------------------------------------------

  app.get('/api/admin/system', async (request): Promise<SystemStatus> => {
    requireAdmin(request);
    const now = Date.now();
    const counts = await context.compileQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
    );
    const outcomes = await db
      .select({ status: compileRuns.status, value: count() })
      .from(compileRuns)
      .where(gte(compileRuns.createdAt, new Date(now - 86_400_000)))
      .groupBy(compileRuns.status);
    const [userCount] = await db.select({ value: count() }).from(users);
    const [active] = await db
      .select({ value: sql<number>`count(distinct ${sessions.userId})::int` })
      .from(sessions)
      .where(gte(sessions.lastSeenAt, new Date(now - 30 * 86_400_000)));
    const [projectCount] = await db
      .select({ value: count() })
      .from(projects)
      .where(isNull(projects.deletedAt));
    const [stored] = await db.select({ bytes: sql<string | null>`sum(${files.size})` }).from(files);
    return {
      version,
      compileQueue: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      },
      compilesLastDay: Object.fromEntries(outcomes.map((row) => [row.status, row.value])),
      texliveVersion: await redis.get(TEXLIVE_VERSION_KEY),
      users: { total: userCount?.value ?? 0, active30Days: active?.value ?? 0 },
      projects: projectCount?.value ?? 0,
      storageBytes: Number(stored?.bytes ?? 0),
      oidc: oidcEnabled(config) ? { issuer: config.OIDC_ISSUER ?? '' } : null,
    };
  });

  // --- The signed-in person's own quotas --------------------------------------------

  app.get('/api/me/quotas', async (request): Promise<QuotaUsage> => {
    const auth = requireAuth(request);
    const { quotas } = await settings.get();
    return quotaUsageOf(db, redis, quotas, auth.user.id);
  });
}
