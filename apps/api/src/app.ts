/** Monta a aplicação Hono: middlewares, rotas da API e arquivos estáticos do frontend. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { ZodError } from 'zod';
import type { AppContext } from './context.ts';
import { DoclingUnavailableError } from './ingest/docling.ts';
import { ContextTooLargeError, NoDocumentsError } from './llm/answer.ts';
import { ClaudeCodeError } from './llm/claude-code.ts';
import { isProviderError } from './llm/providers.ts';
import { ApiError } from './routes/common.ts';
import { healthRoutes } from './routes/health.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { documentRoutes } from './routes/documents.ts';
import { searchRoutes } from './routes/search.ts';
import { askRoutes } from './routes/ask.ts';
import { chatRoutes } from './routes/chat.ts';
import { conversationRoutes } from './routes/conversations.ts';
import { llmRoutes } from './routes/llm.ts';
import { evalRoutes } from './routes/eval.ts';
import { EvalError } from './eval/runner.ts';

/** Status HTTP por código de erro do harness de avaliação. */
const EVAL_STATUS: Record<string, 404 | 409> = { not_found: 404, questions_not_found: 404, workspace_unknown: 404, running: 409, llm_mismatch: 409, duplicate_id: 409 };

/** Origens do frontend em desenvolvimento (Vite). */
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
/** Build do frontend, servido em produção pelo mesmo processo. */
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.use('*', cors({ origin: DEV_ORIGINS, exposeHeaders: ['X-Conversation-Id'], allowHeaders: ['Content-Type', 'X-LLM-Provider', 'X-LLM-Base-URL', 'X-LLM-Model', 'X-LLM-Key'] }));

  // Log de acesso: método, rota, status e duração. Nunca registra headers (X-LLM-Key) nem corpo.
  app.use('/api/*', async (c, next) => {
    const started = performance.now();
    await next();
    const ms = Math.round(performance.now() - started);
    const entry = { method: c.req.method, path: c.req.path, status: c.res.status, ms };
    if (c.res.status >= 500) ctx.log.error(entry, 'req');
    else if (c.res.status >= 400) ctx.log.warn(entry, 'req');
    else ctx.log.info(entry, 'req');
  });

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message, code: i.code }));
      const first = issues[0];
      const message = first ? `Dados inválidos${first.path ? ` em '${first.path}'` : ''}: ${first.message}` : 'Dados inválidos';
      return c.json({ error: { code: 'validation', message, issues } }, 400);
    }
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof HTTPException) return c.json({ error: { code: 'http', message: err.message || `HTTP ${err.status}` } }, err.status);
    if (err instanceof DoclingUnavailableError) return c.json({ error: { code: 'parser_indisponivel', message: err.message } }, 503);
    if (err instanceof ContextTooLargeError) {
      return c.json({ error: { code: err.code, message: err.message, chars: err.chars, budget: err.budget }, fitsInWindow: false }, 413);
    }
    if (err instanceof NoDocumentsError) return c.json({ error: { code: err.code, message: err.message } }, 409);
    if (err instanceof EvalError) return c.json({ error: { code: err.code, message: err.message } }, EVAL_STATUS[err.code] ?? 400);
    // O CLI local não envolve chave: a mensagem (sem login, limite de uso, CLI ausente) pode ir inteira para a tela.
    if (err instanceof ClaudeCodeError) return c.json({ error: { code: `claude_code_${err.code}`, message: err.message } }, 502);
    if (isProviderError(err)) {
      // Rede de segurança: nunca serializar o erro cru (requestBodyValues/responseBody/message podem conter a chave).
      const e = err as { name?: string; statusCode?: number; url?: string };
      ctx.log.warn({ name: e.name, statusCode: e.statusCode, url: e.url, method: c.req.method, path: c.req.path }, 'erro do provedor LLM');
      return c.json({ error: { code: 'llm_error', message: 'Falha no provedor de LLM (verifique provedor, modelo e chave)' } }, 502);
    }
    ctx.log.error({ err, method: c.req.method, path: c.req.path }, 'erro não tratado');
    return c.json({ error: { code: 'internal', message: 'Erro interno do servidor' } }, 500);
  });

  for (const routes of [healthRoutes, workspaceRoutes, documentRoutes, searchRoutes, askRoutes, chatRoutes, conversationRoutes, llmRoutes, evalRoutes]) {
    app.route('/api', routes(ctx));
  }

  // Frontend compilado (se existir): arquivos estáticos + fallback index.html para as rotas do SPA.
  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use('/*', serveStatic({ root: WEB_DIST }));
    app.get('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : serveStatic({ root: WEB_DIST, path: 'index.html' })(c, next)));
    ctx.log.info({ dir: WEB_DIST }, 'frontend estático habilitado');
  }

  app.notFound((c) => c.json({ error: { code: 'not_found', message: `Rota não encontrada: ${c.req.method} ${c.req.path}` } }, 404));

  return app;
}
