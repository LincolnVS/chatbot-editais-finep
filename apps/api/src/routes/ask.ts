/** POST /api/ask — resposta completa em JSON (sem stream): AskRequest + headers X-LLM-* → AnswerResult. */
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { answerOnce } from '../llm/answer.ts';
import { describeError, isProviderError, providerLabel, resolveLlmConfig } from '../llm/providers.ts';
import { AskRequest } from '@editais/shared';
import { ApiError, mergePipelineConfig, readJson, requireWorkspace } from './common.ts';

export function askRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post('/ask', async (c) => {
    const body = AskRequest.parse(await readJson(c));
    const workspace = requireWorkspace(ctx.db, body.workspaceId);
    const config = mergePipelineConfig(workspace.settings, { ...body.pipelineConfig, generation: { ...body.pipelineConfig?.generation, mode: body.mode } });
    const llm = resolveLlmConfig(c.req.raw.headers, ctx.config.llmDefault);
    let result;
    try {
      result = await answerOnce({
        db: ctx.db,
        workspaceId: workspace.id,
        question: body.question,
        documentIds: body.documentIds,
        config,
        llm,
        llmFallback: ctx.config.llmFallback,
        embedQuery: (text) => ctx.embedder(config.embedModel).embedQuery(text),
      });
    } catch (err) {
      // Erro do provedor (chave inválida, modelo inexistente, endpoint fora do ar) → 502 com a mensagem redigida.
      // Nunca logar o erro cru: o APICallError traz o prompt inteiro e a resposta do provedor (que pode ecoar a chave).
      if (!isProviderError(err)) throw err;
      const message = describeError(err, llm);
      ctx.log.warn({ provider: providerLabel(llm), statusCode: (err as { statusCode?: number }).statusCode, message }, 'falha no provedor LLM');
      throw new ApiError(502, 'llm_error', message);
    }
    ctx.log.info({ workspaceId: workspace.id, mode: result.mode, status: result.status, provider: result.provider, citations: result.citations.length, removed: result.grounding.removed, latencyMs: result.latencyMs }, 'ask respondido');
    return c.json(result);
  });

  return app;
}
