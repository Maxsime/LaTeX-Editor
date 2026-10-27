import { files, userDictionaryWords, yjsStates, zoteroAccounts } from '@galley/db';
import { checkBibtex, detectLanguage } from '@galley/latex-index';
import {
  ApiError,
  connectZoteroRequest,
  dictionaryRequest,
  type DictionaryResponse,
  lookupRequest,
  type LookupResponse,
  MAX_DICTIONARY_WORDS,
  spellingRequest,
  type SpellingResponse,
  type WritingFeatures,
  type ZoteroAccount,
  zoteroImportRequest,
  type ZoteroItemsResponse,
  zoteroSearchQuery,
} from '@galley/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import { entriesFromBibtex, entryFromReference, type KeyOptions } from '../bibliography/import.js';
import { lookupArxiv, lookupDoi, lookupIsbn } from '../bibliography/sources.js';
import { exportZotero, searchZotero, verifyZoteroKey } from '../bibliography/zotero.js';
import type { AppContext } from '../context.js';
import { createSecretBox, keyHint, requireSecretBox } from '../crypto/secrets.js';
import { parse } from '../http/validate.js';
import { readProjectTexts } from '../materialize.js';
import { loadProject, type ProjectRow } from '../projects/access.js';
import { checkText } from '../spelling/languagetool.js';
import { stateToText } from '../yjs/text.js';
import { projectParams } from './projects.js';

/** Per-person limits, counted once the session is known. */
function perPerson(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: '1 minute',
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) => request.auth?.user.id ?? request.ip,
    },
  };
}

/** Context in which a Zotero key is encrypted: bound to its owner. */
const zoteroContext = (userId: string) => `zotero:${userId}`;

/** Bibliography import, Zotero, spell checking and the personal dictionary (SPEC §3.6, §3.7). */
export function writingRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context.database;
  const { config } = context;
  const secrets = createSecretBox(config.GALLEY_MASTER_KEY);

  /** Keys of every `.bib` entry of the project, so imports never reuse one. */
  async function takenKeys(projectId: string): Promise<Set<string>> {
    const taken = new Set<string>();
    for (const file of await readProjectTexts(context, projectId)) {
      if (!file.path.toLowerCase().endsWith('.bib')) continue;
      for (const entry of checkBibtex(file.text).entries) taken.add(entry.key.toLowerCase());
    }
    return taken;
  }

  async function keyOptions(project: ProjectRow, keepKeys = false): Promise<KeyOptions> {
    return { pattern: project.citeKeyPattern, taken: await takenKeys(project.id), keepKeys };
  }

  app.get('/api/writing/features', (request): WritingFeatures => {
    requireAuth(request);
    return { spelling: config.LANGUAGETOOL_URL !== undefined, zotero: secrets !== null };
  });

  // Reviewers may import too: the entry reaches the file through their editor, as a suggestion.
  app.post(
    '/api/projects/:id/bibliography/lookup',
    { config: perPerson(30) },
    async (request): Promise<LookupResponse> => {
      const auth = requireAuth(request);
      const { id } = parse(projectParams, request.params);
      const body = parse(lookupRequest, request.body);
      const { project } = await loadProject(db, id, auth.user.id, 'reviewer');
      const options = await keyOptions(project, body.keepKeys);
      switch (body.source) {
        case 'doi':
          return {
            entries: [entryFromReference(await lookupDoi(config, fetch, body.query), options)],
          };
        case 'arxiv':
          return {
            entries: [entryFromReference(await lookupArxiv(config, fetch, body.query), options)],
          };
        case 'isbn':
          return {
            entries: [entryFromReference(await lookupIsbn(config, fetch, body.query), options)],
          };
        case 'bibtex':
          return { entries: entriesFromBibtex(body.query, options) };
      }
    },
  );

  // --- Zotero ---------------------------------------------------------------------

  async function zoteroAccountOf(userId: string) {
    const [row] = await db.select().from(zoteroAccounts).where(eq(zoteroAccounts.userId, userId));
    return row;
  }

  /** The current user's Zotero credentials, decrypted for one call. */
  async function zoteroCredentials(userId: string): Promise<{ userId: string; apiKey: string }> {
    const box = requireSecretBox(secrets);
    const row = await zoteroAccountOf(userId);
    if (!row) throw new ApiError('NOT_FOUND', 'no Zotero account');
    return {
      userId: row.zoteroUserId,
      apiKey: box.open(row.apiKeyCiphertext, zoteroContext(userId)),
    };
  }

  app.get('/api/zotero', async (request): Promise<ZoteroAccount> => {
    const auth = requireAuth(request);
    const row = await zoteroAccountOf(auth.user.id);
    return row
      ? { connected: true, username: row.username, keyHint: row.keyHint }
      : { connected: false, username: null, keyHint: null };
  });

  app.put('/api/zotero', { config: perPerson(10) }, async (request): Promise<ZoteroAccount> => {
    const auth = requireAuth(request);
    const { apiKey } = parse(connectZoteroRequest, request.body);
    const box = requireSecretBox(secrets);
    const owner = await verifyZoteroKey(config.ZOTERO_URL, fetch, apiKey);
    const values = {
      zoteroUserId: owner.userId,
      username: owner.username,
      apiKeyCiphertext: box.seal(apiKey, zoteroContext(auth.user.id)),
      keyHint: keyHint(apiKey),
    };
    await db
      .insert(zoteroAccounts)
      .values({ userId: auth.user.id, ...values })
      .onConflictDoUpdate({
        target: zoteroAccounts.userId,
        set: { ...values, createdAt: new Date() },
      });
    return { connected: true, username: owner.username, keyHint: values.keyHint };
  });

  app.delete('/api/zotero', async (request, reply) => {
    const auth = requireAuth(request);
    await db.delete(zoteroAccounts).where(eq(zoteroAccounts.userId, auth.user.id));
    return reply.code(204).send();
  });

  app.get(
    '/api/zotero/items',
    { config: perPerson(30) },
    async (request): Promise<ZoteroItemsResponse> => {
      const auth = requireAuth(request);
      const { q } = parse(zoteroSearchQuery, request.query);
      const credentials = await zoteroCredentials(auth.user.id);
      return { items: await searchZotero(config.ZOTERO_URL, fetch, credentials, q) };
    },
  );

  app.post(
    '/api/projects/:id/zotero/import',
    { config: perPerson(30) },
    async (request): Promise<LookupResponse> => {
      const auth = requireAuth(request);
      const { id } = parse(projectParams, request.params);
      const { itemKeys } = parse(zoteroImportRequest, request.body);
      const { project } = await loadProject(db, id, auth.user.id, 'reviewer');
      const credentials = await zoteroCredentials(auth.user.id);
      const text = await exportZotero(config.ZOTERO_URL, fetch, credentials, itemKeys);
      return { entries: entriesFromBibtex(text, await keyOptions(project)) };
    },
  );

  // --- Spelling and grammar ---------------------------------------------------------

  async function dictionaryOf(userId: string): Promise<string[]> {
    const rows = await db
      .select({ word: userDictionaryWords.word })
      .from(userDictionaryWords)
      .where(eq(userDictionaryWords.userId, userId))
      .orderBy(asc(userDictionaryWords.word));
    return rows.map((row) => row.word);
  }

  /** Language of the project's main file, from babel or polyglossia. */
  async function documentLanguage(project: ProjectRow): Promise<string | null> {
    if (project.mainFileId === null) return null;
    const [row] = await db
      .select({ state: yjsStates.state })
      .from(yjsStates)
      .innerJoin(files, eq(files.id, yjsStates.fileId))
      .where(and(eq(yjsStates.fileId, project.mainFileId), eq(files.projectId, project.id)));
    return row ? detectLanguage(stateToText(row.state)) : null;
  }

  app.post(
    '/api/projects/:id/spelling',
    { config: perPerson(60) },
    async (request): Promise<SpellingResponse> => {
      const auth = requireAuth(request);
      const { id } = parse(projectParams, request.params);
      const body = parse(spellingRequest, request.body);
      const { project } = await loadProject(db, id, auth.user.id, 'reader');
      const base = config.LANGUAGETOOL_URL;
      if (base === undefined) throw new ApiError('SERVICE_UNAVAILABLE', 'no LanguageTool');
      let language = project.spellLanguage;
      if (language === 'auto' && body.language !== undefined) language = body.language;
      if (language === 'auto') language = (await documentLanguage(project)) ?? 'auto';
      return checkText(base, body.annotation, {
        language,
        dictionary: new Set(await dictionaryOf(auth.user.id)),
      });
    },
  );

  app.get('/api/me/dictionary', async (request): Promise<DictionaryResponse> => {
    const auth = requireAuth(request);
    return { words: await dictionaryOf(auth.user.id) };
  });

  app.post('/api/me/dictionary', async (request): Promise<DictionaryResponse> => {
    const auth = requireAuth(request);
    const { word } = parse(dictionaryRequest, request.body);
    const [total] = await db
      .select({ value: count() })
      .from(userDictionaryWords)
      .where(eq(userDictionaryWords.userId, auth.user.id));
    if ((total?.value ?? 0) >= MAX_DICTIONARY_WORDS) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'dictionary full');
    }
    await db
      .insert(userDictionaryWords)
      .values({ userId: auth.user.id, word })
      .onConflictDoNothing();
    return { words: await dictionaryOf(auth.user.id) };
  });

  app.delete('/api/me/dictionary', async (request): Promise<DictionaryResponse> => {
    const auth = requireAuth(request);
    const { word } = parse(dictionaryRequest, request.query);
    await db
      .delete(userDictionaryWords)
      .where(and(eq(userDictionaryWords.userId, auth.user.id), eq(userDictionaryWords.word, word)));
    return { words: await dictionaryOf(auth.user.id) };
  });
}
