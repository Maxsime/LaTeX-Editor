import {
  ApiError,
  type ImportProjectResponse,
  type ImportWarning,
  projectName,
} from '@galley/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import { assertOwnerRoom } from '../admin/quotas.js';
import { instanceSettingsOf } from '../admin/settings.js';
import type { AppContext } from '../context.js';
import { ArchiveError, DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from '../archive/limits.js';
import { extractArchive } from '../archive/read.js';
import { writeArchive } from '../archive/write.js';
import { classifySpooled, type IncomingFile } from '../files/ingest.js';
import { createScratchDir, SizeLimitError, spool } from '../files/spool.js';
import { ensureMainFile, writeFiles } from '../files/tree.js';
import { parse } from '../http/validate.js';
import { materializeProject } from '../materialize.js';
import { loadProject } from '../projects/access.js';
import { insertProject, toSummary } from '../projects/service.js';
import { readBlob, storeBlobs } from '../storage/blobs.js';
import { ValidationError } from '../http/validate.js';
import { projectParams } from './projects.js';

/** Name given to an imported project: the archive's, without extension, bounded. */
function nameFromArchive(fileName: string): string {
  const base = fileName
    .replace(/\.zip$/i, '')
    .trim()
    .slice(0, 150)
    .trim();
  return base === '' ? 'Imported project' : base;
}

export function archiveRoutes(
  app: FastifyInstance,
  context: AppContext,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  const { database, s3, config } = context;
  const { db } = database;

  /**
   * Creates a project from a zip archive (Overleaf, Prism or any folder).
   * The archive is fully validated before the project exists; a refusal is a
   * VALIDATION_FAILED error whose field `archive` carries the reason.
   */
  app.post('/api/projects/import', async (request, reply) => {
    const auth = requireAuth(request);
    if (!request.isMultipart()) throw new ApiError('BAD_REQUEST', 'multipart expected');
    const scratch = await createScratchDir(config.API_TMP_DIR);
    try {
      let name: string | undefined;
      let archive: { path: string; fileName: string } | undefined;
      for await (const part of request.parts({
        limits: { fileSize: limits.maxTotalBytes, files: 1, fieldSize: 1024 },
      })) {
        if (part.type === 'field') {
          if (part.fieldname === 'name' && typeof part.value === 'string' && part.value !== '') {
            name = parse(projectName, part.value);
          }
          continue;
        }
        const target = scratch.file('zip');
        try {
          await spool(part.file, target, limits.maxTotalBytes);
        } catch (error) {
          if (error instanceof SizeLimitError) throw new ApiError('PAYLOAD_TOO_LARGE');
          throw error;
        }
        if (part.file.truncated) throw new ApiError('PAYLOAD_TOO_LARGE');
        archive = { path: target, fileName: part.filename };
      }
      if (!archive) throw new ApiError('BAD_REQUEST', 'no archive');

      let extracted;
      try {
        extracted = await extractArchive(archive.path, scratch, limits);
      } catch (error) {
        if (error instanceof ArchiveError) {
          request.log.info({ reason: error.reason }, 'archive refused');
          throw new ValidationError([{ path: 'archive', messageKey: `archive.${error.reason}` }]);
        }
        throw error;
      }
      const warnings: ImportWarning[] = [...extracted.warnings];
      const incoming: IncomingFile[] = [];
      for (const file of extracted.files) {
        incoming.push(await classifySpooled(file.segments, file, warnings));
      }
      const { quotas } = await instanceSettingsOf(context).get();
      await assertOwnerRoom(
        db,
        quotas,
        auth.user.id,
        incoming.reduce(
          (total, file) => total + (file.kind === 'binary' ? file.blob.size : file.size),
          0,
        ),
      );
      await storeBlobs(
        db,
        s3,
        config.S3_BUCKET,
        incoming.flatMap((file) => (file.kind === 'binary' ? [file.blob] : [])),
      );
      const project = await db.transaction(async (tx) => {
        const row = await insertProject(
          tx,
          auth.user.id,
          name ?? nameFromArchive(archive.fileName),
        );
        await writeFiles(tx, row.id, null, incoming, extracted.folders);
        const mainFileId = await ensureMainFile(tx, row.id);
        return { ...row, mainFileId };
      });
      request.log.info(
        { projectId: project.id, files: incoming.length, warnings: warnings.length },
        'project imported',
      );
      const response: ImportProjectResponse = {
        project: toSummary(project, 'owner', auth.user.displayName, []),
        warnings,
      };
      void reply.status(201);
      return response;
    } finally {
      await scratch.cleanup();
    }
  });

  app.get('/api/projects/:id/export', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { project } = await loadProject(db, id, auth.user.id, 'reader');
    const snapshot = await materializeProject(context, id);
    const stream = writeArchive(snapshot, (hash) => readBlob(s3, config.S3_BUCKET, hash));
    return reply
      .header('content-type', 'application/zip')
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${project.name}.zip`)}`,
      )
      .header('cache-control', 'no-store')
      .send(stream);
  });
}
