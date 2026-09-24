/** /api/workspaces — CRUD de workspaces (1 workspace = 1 chamada pública) e suas settings (PipelineConfig). */
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import * as q from '../db/queries.ts';
import { storage } from '../storage.ts';
import { enqueueIngestion } from '../ingest/queue.ts';
import { CreateWorkspaceRequest, DEFAULT_PIPELINE_CONFIG, canonicalJson, type PipelineConfig } from '@editais/shared';
import { mergePipelineConfig, readJson, requireWorkspace } from './common.ts';

/** Parte da configuração que determina chunks e embeddings (mudou → o índice está desatualizado). */
function indexConfigKey(config: PipelineConfig): string {
  return canonicalJson({ parser: config.parser, removeHeaderFooter: config.removeHeaderFooter, chunking: config.chunking, embedModel: config.embedModel });
}

export function workspaceRoutes(ctx: AppContext): Hono {
  const { db } = ctx;
  const app = new Hono();

  app.get('/workspaces', (c) => c.json(q.listWorkspaces(db)));

  app.post('/workspaces', async (c) => {
    const body = CreateWorkspaceRequest.parse(await readJson(c));
    const settings = mergePipelineConfig(DEFAULT_PIPELINE_CONFIG, body.settings);
    const workspace = q.createWorkspace(db, { name: body.name, agency: body.agency, callCode: body.callCode, settings });
    ctx.log.info({ workspaceId: workspace.id, name: workspace.name }, 'workspace criado');
    return c.json(workspace, 201);
  });

  app.get('/workspaces/:id', (c) => {
    const workspace = requireWorkspace(db, c.req.param('id'));
    return c.json({ ...workspace, documents: q.listDocuments(db, workspace.id) });
  });

  app.patch('/workspaces/:id/settings', async (c) => {
    const workspace = requireWorkspace(db, c.req.param('id'));
    const settings = mergePipelineConfig(workspace.settings, await readJson(c));
    q.updateWorkspaceSettings(db, workspace.id, settings);
    let reindexing = 0;
    if (indexConfigKey(settings) !== indexConfigKey(workspace.settings)) {
      for (const doc of q.listDocuments(db, workspace.id)) {
        enqueueIngestion(ctx, doc.id);
        reindexing++;
      }
      if (reindexing) ctx.log.info({ workspaceId: workspace.id, reindexing }, 'settings do índice alteradas; documentos reenfileirados');
    }
    return c.json({ ...q.getWorkspace(db, workspace.id), reindexing });
  });

  app.delete('/workspaces/:id', (c) => {
    const workspace = requireWorkspace(db, c.req.param('id'));
    const documents = q.listDocuments(db, workspace.id);
    q.deleteWorkspace(db, workspace.id);
    for (const doc of documents) storage.removeDocumentFiles(doc.id);
    ctx.log.info({ workspaceId: workspace.id, documents: documents.length }, 'workspace apagado');
    return c.body(null, 204);
  });

  return app;
}
