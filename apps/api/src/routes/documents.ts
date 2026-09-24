/** Rotas de documentos: upload, status/eventos da ingestão, arquivo, chunks, reprocessamento e exclusão. */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { AppContext } from '../context.ts';
import * as q from '../db/queries.ts';
import { storage } from '../storage.ts';
import { enqueueIngestion, subscribeJob } from '../ingest/queue.ts';
import { z } from 'zod';
import { UploadDocumentFields, sha256, type IngestionJob } from '@editais/shared';
import { ApiError, requireDocument, requireWorkspace } from './common.ts';

const ReprocessBody = z.object({ force: z.boolean().default(false) });

/** Violação de índice único do SQLite (uploads simultâneos do mesmo PDF). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** `filename=` só aceita ASCII; nomes com acento (regra nos editais) vão em `filename*=` (RFC 6266/5987). */
function contentDisposition(filename: string): string {
  const ascii = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'documento.pdf';
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const SSE_HEARTBEAT_MS = 15_000;
/** Folga para os cabeçalhos do multipart além do limite do PDF. */
const MULTIPART_OVERHEAD = 1024 * 1024;

function isFinished(job: IngestionJob): boolean {
  return job.status === 'done' || job.status === 'failed';
}

/** Só a assinatura do arquivo conta: o `Content-Type` do multipart e a extensão vêm do cliente. */
function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function documentRoutes(ctx: AppContext): Hono {
  const { db, config } = ctx;
  const app = new Hono();

  app.post(
    '/workspaces/:id/documents',
    bodyLimit({
      maxSize: config.maxUploadBytes + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: { code: 'payload_too_large', message: `Upload acima de ${config.maxUploadBytes / (1024 * 1024)} MB` } }, 413),
    }),
    async (c) => {
      const workspace = requireWorkspace(db, c.req.param('id'));
      const body = await c.req.parseBody();
      const { file, ...rest } = body;
      if (!(file instanceof File)) throw new ApiError(400, 'validation', "Envie o PDF no campo multipart 'file'");
      if (file.size > config.maxUploadBytes) throw new ApiError(413, 'payload_too_large', `Arquivo acima de ${config.maxUploadBytes / (1024 * 1024)} MB`);
      const fields = UploadDocumentFields.parse(Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v === 'string' && v !== '')));

      const bytes = Buffer.from(await file.arrayBuffer());
      if (!isPdf(bytes)) throw new ApiError(400, 'validation', 'O arquivo enviado não é um PDF');
      if (fields.amendsDocumentId) {
        const amended = q.getDocument(db, fields.amendsDocumentId);
        if (!amended || amended.workspaceId !== workspace.id) throw new ApiError(400, 'validation', 'amendsDocumentId não pertence a este workspace');
      }

      const hash = sha256(bytes);
      const duplicate = q.findDocumentBySha256(db, workspace.id, hash);
      if (duplicate) throw new ApiError(409, 'duplicate', `Este PDF já foi enviado neste workspace como "${duplicate.title}" (${duplicate.id})`);

      const filename = path.basename(file.name || 'documento.pdf');
      let document;
      try {
        document = q.insertDocument(db, {
          workspaceId: workspace.id,
          docType: fields.docType,
          docKind: fields.docKind,
          title: fields.title ?? filename.replace(/\.pdf$/i, ''),
          filename,
          mime: 'application/pdf',
          sha256: hash,
          sizeBytes: bytes.length,
          publishedAt: fields.publishedAt,
          versionLabel: fields.versionLabel,
          amendsDocumentId: fields.amendsDocumentId,
        });
      } catch (err) {
        // dois uploads simultâneos do mesmo PDF passam pela verificação acima; o índice único (workspace_id, sha256) decide
        if (!isUniqueViolation(err)) throw err;
        throw new ApiError(409, 'duplicate', 'Este PDF já foi enviado neste workspace');
      }
      fs.mkdirSync(config.uploadsDir, { recursive: true });
      fs.writeFileSync(storage.uploadPath(document.id), bytes);
      const job = enqueueIngestion(ctx, document.id);
      ctx.log.info({ documentId: document.id, workspaceId: workspace.id, filename, sizeBytes: bytes.length, docKind: document.docKind }, 'documento enviado');
      return c.json({ document, job }, 202);
    },
  );

  app.get('/documents/:id', (c) => {
    const document = requireDocument(db, c.req.param('id'));
    const internals = q.getDocumentInternals(db, document.id);
    return c.json({
      ...document,
      job: q.getJob(db, document.id),
      stats: internals?.stats ?? null,
      chunkSetId: internals?.chunkSetId ?? null,
      pipelineHash: internals?.pipelineHash ?? null,
      sha256: internals?.sha256 ?? null,
    });
  });

  app.get('/documents/:id/status', (c) => {
    const document = requireDocument(db, c.req.param('id'));
    const job = q.getJob(db, document.id);
    if (!job) throw new ApiError(404, 'not_found', 'Documento ainda sem job de ingestão');
    return c.json(job);
  });

  app.get('/documents/:id/events', (c) => {
    const document = requireDocument(db, c.req.param('id'));
    return streamSSE(c, async (stream) => {
      const send = (job: IngestionJob) => stream.writeSSE({ event: 'job', data: JSON.stringify(job), id: job.updatedAt });
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        };
        const deliver = (job: IngestionJob) => {
          send(job)
            .then(() => {
              if (isFinished(job)) finish();
            })
            .catch(finish);
        };
        // Assina ANTES de ler o job atual: uma atualização emitida nesse intervalo não se perde (as escritas são
        // serializadas pelo writer do stream, na ordem de chamada).
        const unsubscribe = subscribeJob(ctx, document.id, deliver);
        // comentário SSE: mantém a conexão viva sem gerar eventos no cliente
        const heartbeat = setInterval(() => {
          stream.write(': heartbeat\n\n').catch(finish);
        }, SSE_HEARTBEAT_MS);
        stream.onAbort(finish);
        const current = q.getJob(db, document.id);
        if (current) deliver(current);
      });
    });
  });

  app.get('/documents/:id/file', (c) => {
    const document = requireDocument(db, c.req.param('id'));
    const p = storage.uploadPath(document.id);
    if (!fs.existsSync(p)) throw new ApiError(404, 'not_found', 'PDF não encontrado no armazenamento');
    const size = fs.statSync(p).size;
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Length', String(size));
    c.header('Content-Disposition', contentDisposition(document.filename));
    return c.body(Readable.toWeb(fs.createReadStream(p)) as ReadableStream);
  });

  app.get('/documents/:id/chunks', (c) => {
    const document = requireDocument(db, c.req.param('id'));
    const chunks = q.listDocumentChunks(db, document.id);
    return c.json({ documentId: document.id, chunkSetId: q.getDocumentInternals(db, document.id)?.chunkSetId ?? null, count: chunks.length, chunks });
  });

  app.get('/documents/:id/canonical', (c) => {
    const document = requireDocument(db, c.req.param('id'));
    const markdown = storage.readText(storage.canonicalMdPath(document.id));
    if (markdown === null) throw new ApiError(404, 'not_found', 'canonical.md ainda não gerado para este documento');
    return c.text(markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  app.post('/documents/:id/reprocess', async (c) => {
    const document = requireDocument(db, c.req.param('id'));
    // corpo vazio → reprocessa sem forçar novo parse; corpo presente é validado (`force: "true"` é erro, não false)
    const raw = await c.req.text();
    let parsedBody: unknown = {};
    if (raw.trim()) {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        throw new ApiError(400, 'invalid_json', 'Corpo da requisição deve ser JSON válido');
      }
    }
    const { force } = ReprocessBody.parse(parsedBody ?? {});
    const job = enqueueIngestion(ctx, document.id, { force });
    ctx.log.info({ documentId: document.id, force }, 'reprocessamento enfileirado');
    return c.json({ document: q.getDocument(db, document.id), job }, 202);
  });

  app.delete('/documents/:id', (c) => {
    const document = requireDocument(db, c.req.param('id'));
    q.deleteDocument(db, document.id);
    storage.removeDocumentFiles(document.id);
    ctx.log.info({ documentId: document.id }, 'documento apagado');
    return c.body(null, 204);
  });

  return app;
}
