/** /api/llm — BYOK: testa uma configuração de provedor (corpo `TestLlmRequest` ou headers X-LLM-*) e informa o provedor default do servidor (sem expor a chave). */
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { resolveLlmConfig, testConnection } from '../llm/providers.ts';
import { TestLlmRequest, type LlmConfig } from '@editais/shared';
import { claudeCliStatus } from '../llm/claude-code.ts';
import { loadPrompt } from '../llm/answer.ts';
import { ApiError } from './common.ts';

const PROMPT_NAME_RE = /^[a-z_]+\.v\d+$/;

export function llmRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post('/llm/test', async (c) => {
    let cfg: LlmConfig;
    const raw = await c.req.text();
    if (raw.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ error: { code: 'invalid_json', message: 'Corpo da requisição deve ser JSON válido' } }, 400);
      }
      cfg = TestLlmRequest.parse(body).config;
    } else {
      cfg = resolveLlmConfig(c.req.raw.headers, ctx.config.llmDefault);
    }
    const result = await testConnection(cfg);
    ctx.log.info({ kind: cfg.kind, model: cfg.model, ok: result.ok, latencyMs: result.latencyMs }, 'teste de conexão LLM');
    return c.json({ ...result, kind: cfg.kind });
  });

  app.get('/llm/defaults', (c) => {
    const { kind, model, apiKey, baseURL } = ctx.config.llmDefault;
    const fallback = ctx.config.llmFallback;
    return c.json({ kind, model, baseURL: baseURL ?? null, hasServerKey: Boolean(apiKey), fallback: fallback ? { kind: fallback.kind, model: fallback.model } : null, claudeCli: claudeCliStatus() });
  });

  /** Texto de um prompt do sistema (qa.vN, baseline.vN, closed_book.vN), para a tela de arquitetura. */
  app.get('/llm/prompts/:name', (c) => {
    const name = c.req.param('name');
    if (!PROMPT_NAME_RE.test(name)) throw new ApiError(400, 'validation', 'Nome de prompt inválido');
    try {
      return c.json({ name, text: loadPrompt(name) });
    } catch {
      throw new ApiError(404, 'not_found', `Prompt não encontrado: ${name}`);
    }
  });

  return app;
}
