/** Fila de ingestão in-process (p-queue, um documento por vez). */
import PQueue from 'p-queue';
import type { AppContext } from '../context.ts';
import type { IngestionJob, PipelineConfig } from '@editais/shared';
import { getJob, listPendingJobs, upsertJob } from '../db/queries.ts';
import { ingestDocument, type IngestOptions } from './pipeline.ts';

const queue = new PQueue({ concurrency: 1 });
/** Documentos aguardando na fila (ainda não iniciados) e as opções com que vão rodar. */
const waiting = new Map<string, IngestOptions>();

export function enqueueIngestion(ctx: AppContext, documentId: string, opts: { force?: boolean; config?: PipelineConfig } = {}): IngestionJob {
  const pending = waiting.get(documentId);
  if (pending) {
    if (opts.force) pending.force = true;
    if (opts.config) pending.config = opts.config;
    return getJob(ctx.db, documentId) ?? upsertJob(ctx.db, documentId, { stage: 'parse', status: 'queued', progress: 0 });
  }

  waiting.set(documentId, { ...opts });
  const job = upsertJob(ctx.db, documentId, { stage: 'parse', status: 'queued', progress: 0, message: 'aguardando na fila', error: null });
  ctx.jobEvents.emit(`job:${documentId}`, job);

  void queue.add(async () => {
    const options = waiting.get(documentId) ?? opts;
    waiting.delete(documentId);
    try {
      await ingestDocument(ctx, documentId, options);
    } catch (err) {
      // ingestDocument já marca o job como failed; aqui só chegam erros anteriores ao pipeline (documento apagado etc.).
      ctx.log.error({ err, documentId }, 'ingestão abortada antes do pipeline');
    }
  });
  return job;
}

/** Reenfileira jobs `queued`/`processing` deixados por um encerramento abrupto. Devolve quantos foram reenfileirados. */
export function resumePendingJobs(ctx: AppContext): number {
  const pending = listPendingJobs(ctx.db);
  for (const job of pending) enqueueIngestion(ctx, job.documentId);
  return pending.length;
}

export function subscribeJob(ctx: AppContext, documentId: string, cb: (job: IngestionJob) => void): () => void {
  const event = `job:${documentId}`;
  ctx.jobEvents.on(event, cb);
  return () => {
    ctx.jobEvents.off(event, cb);
  };
}

export function queueSize(): { pending: number; size: number } {
  return { pending: queue.pending, size: queue.size };
}
