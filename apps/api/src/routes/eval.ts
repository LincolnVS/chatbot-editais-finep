/** /api/eval — execuções do harness: listar, ler, iniciar/retomar (em segundo plano) e apagar; arquivos de perguntas em eval/. */
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { EVAL_ARMS, EvalDatasetRequest, EvalRunRequest, type EvalQuestion } from '@editais/shared';
import { createEvalRun, datasetFile, deleteEvalRun, executeEvalRun, getEvalRun, listEvalRuns, listQuestionFiles, loadQuestions, resumeEvalRun, saveQuestions } from '../eval/runner.ts';
import { resolveLlmConfig } from '../llm/providers.ts';
import { ApiError, readJson } from './common.ts';

export function evalRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/eval/questions', (c) => c.json(listQuestionFiles(ctx)));

  app.get('/eval/arms', (c) => c.json(Object.values(EVAL_ARMS)));

  // Padrão-ouro em edição (tela Dataset): ler e gravar o CSV inteiro.
  app.get('/eval/dataset', (c) => {
    const file = c.req.query('file') ?? datasetFile(ctx);
    return c.json({ file, questions: loadQuestions(ctx, file) });
  });

  app.put('/eval/dataset', async (c) => {
    const body = EvalDatasetRequest.parse(await readJson(c));
    const file = body.file ?? datasetFile(ctx);
    const questions = body.questions.map((q) => ({ ...q, expectedValues: q.expectedValues ?? [], answerable: q.answerable ?? true })) as EvalQuestion[];
    saveQuestions(ctx, file, questions);
    ctx.log.info({ file, count: questions.length }, 'padrão-ouro atualizado');
    return c.json({ file, questions });
  });

  app.get('/eval/runs', (c) => c.json(listEvalRuns(ctx)));

  app.get('/eval/runs/:id', (c) => {
    const run = getEvalRun(ctx, c.req.param('id'));
    if (!run) throw new ApiError(404, 'not_found', 'Execução não encontrada');
    return c.json(run);
  });

  // Inicia e responde 202 com o estado inicial; a execução segue em segundo plano e a tela acompanha pelo GET.
  app.post('/eval/runs', async (c) => {
    const request = EvalRunRequest.parse(await readJson(c));
    const llm = resolveLlmConfig(c.req.raw.headers, ctx.config.llmDefault);
    const { run, planned } = createEvalRun(ctx, { request, llm });
    ctx.log.info({ evalRun: run.id, workspaces: run.workspaces.map((w) => w.id), arms: run.arms, questions: planned.length, provider: run.llm.provider }, 'avaliação iniciada');
    void executeEvalRun(ctx, run, planned, llm);
    return c.json(run, 202);
  });

  // Retoma uma execução interrompida com o mesmo modelo (os casos já pontuados ficam; os com erro são refeitos).
  app.post('/eval/runs/:id/resume', (c) => {
    const llm = resolveLlmConfig(c.req.raw.headers, ctx.config.llmDefault);
    const { run, planned } = resumeEvalRun(ctx, c.req.param('id'), llm);
    ctx.log.info({ evalRun: run.id, done: run.progress.done, total: run.progress.total }, 'avaliação retomada');
    void executeEvalRun(ctx, run, planned, llm);
    return c.json(run, 202);
  });

  app.delete('/eval/runs/:id', (c) => {
    if (!deleteEvalRun(ctx, c.req.param('id'))) throw new ApiError(404, 'not_found', 'Execução não encontrada');
    return c.body(null, 204);
  });

  return app;
}
