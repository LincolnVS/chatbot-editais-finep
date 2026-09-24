/** POST /api/workspaces/:id/search — só retrieval (BM25 + KNN + RRF), sem LLM. Alimenta o painel Transparência e o harness. */
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { retrieve } from '../retrieval/hybrid.ts';
import { SearchRequest } from '@editais/shared';
import { mergePipelineConfig, readJson, requireWorkspace } from './common.ts';

export function searchRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post('/workspaces/:id/search', async (c) => {
    const workspace = requireWorkspace(ctx.db, c.req.param('id'));
    // o workspace da URL prevalece sobre o do corpo
    const body = SearchRequest.parse({ ...((await readJson(c)) as object), workspaceId: workspace.id });
    const config = mergePipelineConfig(workspace.settings, body.pipelineConfig);
    const result = await retrieve({
      db: ctx.db,
      workspaceId: workspace.id,
      query: body.query,
      documentIds: body.documentIds,
      config,
      embedQuery: (text) => ctx.embedder(config.embedModel).embedQuery(text),
    });
    return c.json(result);
  });

  return app;
}
