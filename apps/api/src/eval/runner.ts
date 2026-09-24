/** Harness de avaliação: roda o padrão-ouro em cada braço (variante de arquitetura), pontua e grava `data/eval/runs/<id>.json`. */
import fs from 'node:fs';
import path from 'node:path';
import { monotonicFactory } from 'ulid';
import type { EvalArmId, EvalCase, EvalQuestion, EvalRun, EvalRunRequest, EvalRunSummary, LlmConfig, PipelineConfig, Workspace } from '@editais/shared';
import { EVAL_ARMS } from '@editais/shared';
import type { AppContext } from '../context.ts';
import { getWorkspace, listWorkspaces } from '../db/queries.ts';
import { answerOnce, prepareAnswer, preparedForRegrade, regrade, type Prepared } from '../llm/answer.ts';
import type { LanguageModelUsage } from 'ai';
import { expandQuery, type Expansion } from '../llm/expand.ts';
import { describeError, providerLabel } from '../llm/providers.ts';
import { mergePipelineConfig } from '../routes/common.ts';
import { errorCase, estimateOverhead, rescoreCase, scoreCase, summarize, summarizeByWorkspace, type CaseTarget } from './metrics.ts';
import { parseQuestions, toCsv } from './questions.ts';

const ulid = monotonicFactory();
/** Execuções em andamento neste processo (a listagem funde com os arquivos gravados). */
const active = new Map<string, EvalRun>();
/** Limite de uso do provedor (free tier por minuto): espera o tempo que ele pede (ou 20 s) e tenta de novo, até 3 vezes. */
const RATE_LIMIT_RE = /rate.?limit|quota|tokens per minute|429/i;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DEFAULT_MS = 20_000;
/** Cota diária esgotada (Groq "tokens per day (TPD)", Gemini "free_tier_requests … plan and billing"): não adianta esperar — a execução para e pode ser retomada depois. */
const DAILY_QUOTA_RE = /per day|\(TPD\)|\(RPD\)|free_tier_requests|plan and billing|usage limit|hit your (?:session |weekly |daily )?limit/i;

/** "Please try again in 12.5s" / "in 255ms" / "in 3m10.5s" → ms de espera (com folga); sem indicação → padrão. */
export function retryAfterMs(message: string): number {
  const m = /try again in (?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)\s?(ms|s)\b)?/i.exec(message);
  if (!m || (m[1] === undefined && m[2] === undefined)) return RATE_LIMIT_DEFAULT_MS;
  const minutes = Number(m[1] ?? 0) * 60_000;
  const rest = m[2] === undefined ? 0 : Number(m[2]) * (m[3] === 'ms' ? 1 : 1000);
  return Math.min(120_000, Math.round(minutes + rest) + 1500);
}

export function isDailyQuota(message: string): boolean {
  return DAILY_QUOTA_RE.test(message);
}

export class EvalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EvalError';
    this.code = code;
  }
}

export function runsDir(ctx: AppContext): string {
  return ctx.config.evalRunsDir;
}

function runPath(ctx: AppContext, id: string): string {
  return path.join(runsDir(ctx), `${id}.json`);
}

export function loadQuestions(ctx: AppContext, file: string): EvalQuestion[] {
  const full = path.join(ctx.config.evalDir, path.basename(file));
  if (!fs.existsSync(full)) throw new EvalError('questions_not_found', `Arquivo de perguntas não encontrado: ${path.relative(ctx.config.evalDir, full)} (pasta eval/)`);
  const questions = parseQuestions(fs.readFileSync(full, 'utf8'));
  if (questions.length === 0) throw new EvalError('questions_empty', 'Arquivo de perguntas sem linhas');
  return questions;
}

/** Arquivo do padrão-ouro em uso pela tela Dataset (`EVAL_DATASET`, default nucleo.csv). */
export function datasetFile(ctx: AppContext): string {
  return ctx.config.evalDataset;
}

/** Grava o padrão-ouro de volta no CSV (a tela Dataset edita item, valores, resposta de referência e respondível). */
export function saveQuestions(ctx: AppContext, file: string, questions: EvalQuestion[]): EvalQuestion[] {
  const name = path.basename(file);
  if (!/^[\w.-]+\.csv$/.test(name)) throw new EvalError('questions_not_found', `Nome de arquivo inválido: ${name}`);
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) throw new EvalError('duplicate_id', `Pergunta com id repetido: ${q.id}`);
    ids.add(q.id);
  }
  fs.mkdirSync(ctx.config.evalDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.config.evalDir, name), toCsv(questions));
  return questions;
}

/** Arquivos CSV disponíveis em `eval/` (os começados por "_" ficam fora da tela: são padrões-ouro antigos). */
export function listQuestionFiles(ctx: AppContext): Array<{ file: string; count: number }> {
  if (!fs.existsSync(ctx.config.evalDir)) return [];
  return fs
    .readdirSync(ctx.config.evalDir)
    .filter((f) => f.endsWith('.csv') && !f.startsWith('_'))
    .map((file) => {
      try {
        return { file, count: parseQuestions(fs.readFileSync(path.join(ctx.config.evalDir, file), 'utf8')).length };
      } catch {
        return { file, count: 0 };
      }
    });
}

function save(ctx: AppContext, run: EvalRun): void {
  fs.mkdirSync(runsDir(ctx), { recursive: true });
  fs.writeFileSync(runPath(ctx, run.id), JSON.stringify(run, null, 2), 'utf8');
}

/** Pergunta já resolvida ao seu workspace. */
export type PlannedQuestion = { question: EvalQuestion; workspace: Workspace };

/** Resolve a coluna `workspace` (id, código da chamada ou nome) e aplica o filtro/padrão da execução. */
export function planQuestions(ctx: AppContext, questions: EvalQuestion[], defaultWorkspaceId: string | undefined): PlannedQuestion[] {
  const byKey = new Map<string, Workspace>();
  for (const w of listWorkspaces(ctx.db)) {
    byKey.set(w.id, w);
    byKey.set(w.name, w);
    if (w.callCode) byKey.set(w.callCode, w);
  }
  const fallback = defaultWorkspaceId ? getWorkspace(ctx.db, defaultWorkspaceId) : null;
  if (defaultWorkspaceId && !fallback) throw new EvalError('not_found', `Workspace não encontrado: ${defaultWorkspaceId}`);
  const planned: PlannedQuestion[] = [];
  for (const q of questions) {
    const ws = q.workspace ? byKey.get(q.workspace) : fallback;
    if (!ws) {
      if (q.workspace) throw new EvalError('workspace_unknown', `Pergunta ${q.id}: workspace "${q.workspace}" não existe (use id, código da chamada ou nome exato)`);
      throw new EvalError('workspace_required', `Pergunta ${q.id} não tem coluna workspace e nenhum workspace padrão foi informado`);
    }
    // Com workspace padrão informado, ele também filtra: só as perguntas desse edital.
    if (fallback && ws.id !== fallback.id) continue;
    planned.push({ question: q, workspace: ws });
  }
  if (planned.length === 0) throw new EvalError('questions_empty', 'Nenhuma pergunta para o workspace informado');
  return planned;
}

function uniqueWorkspaces(planned: PlannedQuestion[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, { id: string; name: string }>();
  for (const p of planned) if (!seen.has(p.workspace.id)) seen.set(p.workspace.id, { id: p.workspace.id, name: p.workspace.name });
  return [...seen.values()];
}

function questionsPerWorkspace(planned: PlannedQuestion[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of planned) counts.set(p.workspace.id, (counts.get(p.workspace.id) ?? 0) + 1);
  return counts;
}

export type StartOptions = { request: EvalRunRequest; llm: LlmConfig };

/** Cria a execução (estado `running`, arquivo já gravado) sem rodar nada — quem chama decide entre `execute` síncrono ou em segundo plano. */
export function createEvalRun(ctx: AppContext, opts: StartOptions): { run: EvalRun; planned: PlannedQuestion[] } {
  const { request, llm } = opts;
  const planned = planQuestions(ctx, loadQuestions(ctx, request.questionsFile), request.workspaceId);
  const workspaces = uniqueWorkspaces(planned);
  const first = planned[0]!.workspace.settings;
  const run: EvalRun = {
    id: ulid(),
    ...(request.label ? { label: request.label } : {}),
    createdAt: new Date().toISOString(),
    status: 'running',
    workspaces,
    ...(request.documentIds?.length ? { documentIds: request.documentIds } : {}),
    questionsFile: request.questionsFile,
    questionCount: planned.length,
    arms: request.arms,
    llm: { provider: providerLabel(llm), model: llm.model },
    ...(request.grounding ? { grounding: request.grounding } : {}),
    pauseMs: request.pauseMs,
    promptVersion: request.promptVersion ?? first.generation.promptVersion,
    progress: { done: 0, total: planned.length * request.arms.length },
    summary: summarize(request.arms, []),
    byWorkspace: summarizeByWorkspace(request.arms, workspaces, [], questionsPerWorkspace(planned)),
    cases: [],
  };
  active.set(run.id, run);
  save(ctx, run);
  return { run, planned };
}

/** Retoma uma execução interrompida (cota diária, processo morto): mantém os casos já pontuados, refaz os com erro e os que faltam. Exige o mesmo modelo. */
export function resumeEvalRun(ctx: AppContext, id: string, llm: LlmConfig): { run: EvalRun; planned: PlannedQuestion[] } {
  if (active.has(id)) throw new EvalError('running', 'Execução ainda em andamento');
  const run = readRun(ctx, id);
  if (!run) throw new EvalError('not_found', 'Execução não encontrada');
  const wanted = { provider: providerLabel(llm), model: llm.model };
  if (wanted.provider !== run.llm.provider || wanted.model !== run.llm.model) {
    throw new EvalError('llm_mismatch', `A execução foi feita com ${run.llm.provider} / ${run.llm.model}; retomar com ${wanted.provider} / ${wanted.model} misturaria modelos`);
  }
  const ids = new Set(run.workspaces.map((w) => w.id));
  const planned = planQuestions(ctx, loadQuestions(ctx, run.questionsFile), run.workspaces.length === 1 ? run.workspaces[0]!.id : undefined).filter((p) => ids.has(p.workspace.id));
  run.cases = run.cases.filter((c) => c.status !== 'error');
  run.status = 'running';
  delete run.error;
  delete run.finishedAt;
  run.questionCount = planned.length;
  run.progress = { done: run.cases.length, total: planned.length * run.arms.length };
  active.set(run.id, run);
  save(ctx, run);
  return { run, planned };
}

/** Repontua uma execução gravada com o pontuador atual (as respostas não mudam; só as métricas derivadas dos valores esperados). */
export async function rescoreEvalRun(ctx: AppContext, id: string): Promise<EvalRun> {
  if (active.has(id)) throw new EvalError('running', 'Execução em andamento não pode ser repontuada');
  const run = readRun(ctx, id);
  if (!run) throw new EvalError('not_found', 'Execução não encontrada');
  const byId = new Map(loadQuestions(ctx, run.questionsFile).map((q) => [q.id, q]));
  const regraded: EvalCase[] = [];
  for (const c of run.cases) {
    const q = byId.get(c.questionId);
    regraded.push(q ? rescoreCase(q, { ...(await regradeGate(ctx, run, q, c)), ...estimateOverhead(c, run.llm.provider) }) : c);
  }
  run.cases = regraded;
  const counts = new Map<string, number>();
  for (const w of run.workspaces) counts.set(w.id, new Set(run.cases.filter((c) => c.workspaceId === w.id).map((c) => c.questionId)).size);
  run.summary = summarize(run.arms, run.cases);
  run.byWorkspace = summarizeByWorkspace(run.arms, run.workspaces, run.cases, counts);
  save(ctx, run);
  return run;
}

/**
 * O gate é determinístico e só depende do texto do modelo e dos documentos gravados, então a repontuação reaplica validação
 * de citações e gate ao texto cru — assim casos antigos ganham os campos novos (valores em outro item) sem chamar o modelo.
 * Documento inteiro: as seções vêm dos arquivos. RAG: os trechos citados vêm do banco pelos rótulos (o contexto exato não
 * fica gravado; um rótulo válido que não estivesse no contexto contaria como válido — diferença desprezível). Sem documento: nada a reaplicar.
 */
const preparedCache = new Map<string, Prepared | null>();
async function regradeGate(ctx: AppContext, run: EvalRun, q: EvalQuestion, c: EvalCase): Promise<EvalCase> {
  if (c.status === 'error' || c.mode === 'closed_book') return c;
  const ws = getWorkspace(ctx.db, c.workspaceId);
  if (!ws) return c;
  const cfg = armConfig(ws.settings, c.arm, run.grounding, run.promptVersion);
  const scope = { db: ctx.db, workspaceId: c.workspaceId, documentIds: run.documentIds };
  let prepared: Prepared | null;
  if (c.mode === 'full_context') {
    const key = `${run.id}:${c.workspaceId}`;
    const cached = preparedCache.get(key);
    if (cached === undefined) {
      try {
        prepared = await prepareAnswer({ ...scope, question: q.question, config: cfg, llm: { kind: 'mock', model: 'mock-1' }, embedQuery: async () => new Float32Array() });
      } catch {
        prepared = null;
      }
      preparedCache.set(key, prepared);
    } else {
      prepared = cached;
    }
  } else {
    prepared = preparedForRegrade(scope, c.rawText ?? c.text);
  }
  if (!prepared) return c;
  const { validation, outcome } = regrade(prepared, cfg, c.rawText ?? c.text);
  const gated = outcome.report.policy !== 'off';
  const next: EvalCase = {
    ...c,
    text: outcome.text,
    status: outcome.status,
    citations: validation.citations.length,
    invalidLabels: validation.invalidLabels.length,
    blocks: outcome.report.blocks,
    cited: outcome.report.cited,
    removed: outcome.report.removed,
    unsupportedValues: outcome.report.unsupportedValues.length,
    misplacedValues: outcome.report.misplacedValues?.length ?? 0,
    grounded: gated ? outcome.report.issues.length === 0 : null,
    gate: outcome.report.policy,
  };
  if (outcome.text !== validation.text) next.rawText = validation.text;
  else delete next.rawText;
  if (outcome.report.issues.length > 0) next.issues = outcome.report.issues;
  else delete next.issues;
  return next;
}

export type ProgressFn = (run: EvalRun, last: EvalCase) => void;

/** Executa pergunta a pergunta (todos os braços de cada uma), gravando o arquivo a cada caso; casos já presentes (retomada) são pulados. */
export async function executeEvalRun(ctx: AppContext, run: EvalRun, planned: PlannedQuestion[], llm: LlmConfig, onProgress?: ProgressFn): Promise<EvalRun> {
  const log = ctx.log.child({ evalRun: run.id });
  const counts = questionsPerWorkspace(planned);
  const done = new Set(run.cases.map((c) => `${c.questionId}|${c.arm}`));
  try {
    for (const { question, workspace } of planned) {
      for (const arm of run.arms) {
        if (done.has(`${question.id}|${arm}`)) continue;
        const target: CaseTarget = { arm, workspaceId: workspace.id, workspaceName: workspace.name };
        const item = await runCase(ctx, workspace.settings, run, question, target, llm);
        run.cases.push(item);
        run.progress.done = run.cases.length;
        run.summary = summarize(run.arms, run.cases);
        run.byWorkspace = summarizeByWorkspace(run.arms, run.workspaces, run.cases, counts);
        save(ctx, run);
        log.info({ question: question.id, arm, status: item.status, correct: item.correct, latencyMs: item.latencyMs }, 'caso avaliado');
        onProgress?.(run, item);
        if (run.pauseMs > 0) await new Promise((r) => setTimeout(r, run.pauseMs));
      }
    }
    run.status = 'done';
  } catch (err) {
    run.status = 'error';
    run.error = err instanceof Error ? err.message : String(err);
    log.error({ err: run.error }, 'execução interrompida');
  }
  run.finishedAt = new Date().toISOString();
  save(ctx, run);
  active.delete(run.id);
  return run;
}

/** Configuração efetiva do braço: settings do workspace ← patch do braço ← modo, prompt da execução ← gate imposto pela execução (se o braço não fixa o seu). */
export function armConfig(settings: PipelineConfig, arm: EvalArmId, grounding: EvalRun['grounding'], promptVersion?: string): PipelineConfig {
  const spec = EVAL_ARMS[arm];
  const withArm = mergePipelineConfig(settings, spec.patch);
  const gate = grounding && spec.patch.generation?.grounding === undefined ? { grounding } : {};
  return mergePipelineConfig(withArm, { generation: { mode: spec.mode, promptVersion: promptVersion ?? withArm.generation.promptVersion, ...gate } });
}

async function runCase(ctx: AppContext, settings: PipelineConfig, run: EvalRun, q: EvalQuestion, target: CaseTarget, llm: LlmConfig): Promise<EvalCase> {
  const config = armConfig(settings, target.arm, run.grounding, run.promptVersion);
  const started = performance.now();
  const ask = async () => answerOnce({
    db: ctx.db,
    workspaceId: target.workspaceId,
    question: q.question,
    documentIds: run.documentIds,
    config,
    llm,
    // Sem provedor reserva: cada execução mede um único modelo; limite de uso é tratado abaixo com nova tentativa.
    embedQuery: (text) => ctx.embedder(config.embedModel).embedQuery(text),
    ...(await sharedExpansion(run, q, target, config, llm)),
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await ask();
      const scored = scoreCase(q, target, result);
      return result.retrieval?.variants?.length ? { ...scored, variants: result.retrieval.variants } : scored;
    } catch (err) {
      // Erros de provedor/contexto viram um caso com status "error" (contam nas métricas como falha, não derrubam a execução); cota diária interrompe a execução.
      const message = describeError(err, llm);
      if (isDailyQuota(message)) throw new EvalError('quota', `Cota diária do provedor esgotada em ${q.id}/${target.arm}; retome a execução mais tarde. ${message}`);
      if (!RATE_LIMIT_RE.test(message) || attempt >= RATE_LIMIT_RETRIES) return errorCase(q, target, message, Math.round(performance.now() - started));
      await new Promise((r) => setTimeout(r, retryAfterMs(message)));
    }
  }
}

/**
 * Expansão de consulta gerada uma vez por pergunta × workspace e repartida entre os braços que a usam; o custo da
 * chamada entra em cada caso que a usa (é o que o produto paga por resposta). A falha da geração não é cacheada.
 */
async function sharedExpansion(run: EvalRun, q: EvalQuestion, target: CaseTarget, config: PipelineConfig, llm: LlmConfig): Promise<{ expansion?: Expansion }> {
  const count = config.retrieval.queryExpansion;
  if (config.generation.mode !== 'rag' || count <= 0) return {};
  const key = `${q.id}|${target.workspaceId}`;
  const cached = run.expansions?.[key];
  if (cached && cached.variants.length >= count) {
    return { expansion: { variants: cached.variants.slice(0, count), usage: tokenUsage(cached.inputTokens, cached.outputTokens) } };
  }
  const fresh = await expandQuery(llm, q.question, count);
  if (fresh.error) throw new Error(`Expansão de consulta falhou: ${fresh.error}`);
  run.expansions = { ...run.expansions, [key]: { variants: fresh.variants, inputTokens: fresh.usage?.inputTokens ?? 0, outputTokens: fresh.usage?.outputTokens ?? 0 } };
  return { expansion: fresh };
}

/** Uso de tokens só com os totais (o cache da expansão não guarda o detalhamento). */
function tokenUsage(inputTokens: number, outputTokens: number): LanguageModelUsage {
  return {
    inputTokens,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: inputTokens + outputTokens,
  };
}

function readRun(ctx: AppContext, id: string): EvalRun | null {
  const p = runPath(ctx, id);
  if (!fs.existsSync(p)) return null;
  try {
    const run = JSON.parse(fs.readFileSync(p, 'utf8')) as EvalRun;
    // Arquivos de antes dos braços (só `modes`) não têm a estrutura atual: ignorados na listagem.
    return Array.isArray(run.arms) && Array.isArray(run.workspaces) ? run : null;
  } catch {
    return null;
  }
}

function withoutCases(run: EvalRun): EvalRunSummary {
  const summary: Omit<EvalRun, 'cases'> & { cases?: EvalCase[] } = { ...run };
  delete summary.cases;
  return summary;
}

/** Execuções gravadas (mais recentes primeiro); as em andamento vêm da memória, com o progresso atual. */
export function listEvalRuns(ctx: AppContext): EvalRunSummary[] {
  if (!fs.existsSync(runsDir(ctx))) return [...active.values()].map(withoutCases);
  const ids = fs.readdirSync(runsDir(ctx)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const runs = ids.map((id) => active.get(id) ?? readRun(ctx, id)).filter((r): r is EvalRun => r !== null);
  // Um processo anterior pode ter morrido no meio: marcar como erro em vez de "em andamento" para sempre.
  for (const r of runs) if (r.status === 'running' && !active.has(r.id)) r.status = 'error';
  return runs.toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(withoutCases);
}

export function getEvalRun(ctx: AppContext, id: string): EvalRun | null {
  const run = active.get(id) ?? readRun(ctx, id);
  if (run && run.status === 'running' && !active.has(id)) run.status = 'error';
  return run;
}

export function deleteEvalRun(ctx: AppContext, id: string): boolean {
  if (active.has(id)) throw new EvalError('running', 'Execução em andamento não pode ser apagada');
  const p = runPath(ctx, id);
  if (!fs.existsSync(p)) return false;
  fs.rmSync(p);
  return true;
}
