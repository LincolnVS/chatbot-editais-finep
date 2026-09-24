/**
 * CLI do harness: `npm run eval -- [--workspace <id|código|nome>] [--arms rag_hybrid,rag_dense,…] [--questions nucleo.csv] [--grounding warn] [--label "…"] [--pause <ms>]` ou `--resume <id>`.
 * Sem `--workspace`, cada pergunta usa a coluna `workspace` do CSV (vários editais numa execução).
 * Provedor: o LLM_DEFAULT_* do .env, ou `--provider google --model gemini-2.5-flash` (chave lida da variável indicada em `--api-key-env`, default GOOGLE_API_KEY/GROQ_API_KEY/… por provedor),
 * ou `--provider claude-code --model sonnet` (CLI do Claude Code logado nesta máquina; sem chave).
 */
import { parseArgs } from 'node:util';
import { EVAL_ARMS, EVAL_ARM_IDS, EvalRunRequest, LlmConfig, type EvalArmSummary } from '@editais/shared';
import { createContext } from '../context.ts';
import { listWorkspaces } from '../db/queries.ts';
import { createEvalRun, executeEvalRun, listEvalRuns, rescoreEvalRun, resumeEvalRun } from './runner.ts';

const { values: opts } = parseArgs({
  options: {
    workspace: { type: 'string', short: 'w' },
    arms: { type: 'string' },
    questions: { type: 'string', default: 'nucleo.csv' },
    grounding: { type: 'string' },
    prompt: { type: 'string' },
    label: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    'base-url': { type: 'string' },
    'api-key-env': { type: 'string' },
    documents: { type: 'string' },
    pause: { type: 'string', default: '0' },
    resume: { type: 'string' },
    rescore: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

const KEY_ENV: Record<string, string> = { google: 'GOOGLE_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', 'openai-compatible': 'GROQ_API_KEY' };

function usage(): void {
  console.error('uso: npm run eval -- [--workspace <id|código|nome>] [--arms a,b,c] [--questions questions.csv] [--grounding strict|warn|off] [--prompt qa.vN] [--label "…"] [--pause <ms>] [--provider google|openai|anthropic|openai-compatible|claude-code --model <modelo> [--base-url …] [--api-key-env VAR]] | --resume <id da execução> | --rescore <id|all>');
  console.error(`braços: ${EVAL_ARM_IDS.map((id) => `${id} (${EVAL_ARMS[id].short})`).join(', ')}`);
}

if (opts.help) {
  usage();
  process.exit(0);
}

const ctx = createContext();

// Repontuação: recalcula as métricas de execuções já gravadas com o pontuador atual (nenhuma chamada ao modelo).
if (opts.rescore) {
  const ids = opts.rescore === 'all' ? listEvalRuns(ctx).map((r) => r.id) : [opts.rescore];
  for (const id of ids) {
    const run = await rescoreEvalRun(ctx, id);
    console.log(`repontuada ${run.id} (${run.label ?? '-'}) · ${run.cases.length} casos`);
    console.log(table(run.summary));
  }
  await ctx.close();
  process.exit(0);
}

const workspaces = listWorkspaces(ctx.db);
const workspace = opts.workspace ? workspaces.find((w) => [w.id, w.name, w.callCode ?? ''].includes(opts.workspace!)) : undefined;
if (opts.workspace && !workspace) {
  usage();
  console.error(`workspace "${opts.workspace}" não encontrado; existentes: ${workspaces.map((w) => `${w.id} (${w.name}${w.callCode ? `, ${w.callCode}` : ''})`).join(', ') || 'nenhum'}`);
  await ctx.close();
  process.exit(1);
}

const llm = opts.provider
  ? LlmConfig.parse({ kind: opts.provider, model: opts.model, baseURL: opts['base-url'], apiKey: process.env[opts['api-key-env'] ?? KEY_ENV[opts.provider] ?? ''] })
  : LlmConfig.parse({ ...ctx.config.llmDefault, ...(opts.model ? { model: opts.model } : {}) });
const { run, planned } = opts.resume ? resumeEvalRun(ctx, opts.resume, llm) : createEvalRun(ctx, {
  request: EvalRunRequest.parse({
    workspaceId: workspace?.id,
    arms: opts.arms?.split(',').map((m) => m.trim()).filter(Boolean),
    questionsFile: opts.questions,
    grounding: opts.grounding,
    promptVersion: opts.prompt,
    label: opts.label,
    documentIds: opts.documents?.split(',').map((d) => d.trim()).filter(Boolean),
    pauseMs: Number(opts.pause),
  }),
  llm,
});
console.log(`execução ${run.id}${opts.resume ? ` retomada em ${run.progress.done}/${run.progress.total}` : ''}: ${planned.length} perguntas (${run.workspaces.map((w) => w.name).join(', ')}) × ${run.arms.join(', ')} · ${run.llm.provider}${run.grounding ? ` · gate ${run.grounding}` : ''} · ${run.promptVersion}${run.pauseMs ? ` · pausa ${run.pauseMs} ms` : ''}`);
const done = await executeEvalRun(ctx, run, planned, llm, (r, c) => {
  const mark = c.status === 'error' ? '!' : c.correct ? '✓' : '✗';
  console.log(`[${r.progress.done}/${r.progress.total}] ${mark} ${c.questionId} ${c.arm.padEnd(12)} ${c.status.padEnd(13)} ${c.latencyMs} ms${c.error ? ` — ${c.error}` : ''}`);
});

console.log(`\n${done.status === 'done' ? 'concluída' : `interrompida: ${done.error ?? ''}`} → data/eval/runs/${done.id}.json\n`);
console.log(table(done.summary));
for (const w of done.byWorkspace) console.log(`\n— ${w.workspaceName} (${w.questions} perguntas)\n${table(w.summary)}`);
await ctx.close();

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function table(summary: EvalArmSummary[]): string {
  const rows: Array<[string, (s: EvalArmSummary) => string]> = [
    ['↑ acurácia', (s) => pct(s.accuracy)],
    ['↑ respondíveis corretas', (s) => pct(s.answerAccuracy)],
    ['↑ abstenção correta', (s) => pct(s.abstentionAccuracy)],
    ['↓ abstenção indevida', (s) => pct(s.falseAbstention)],
    ['↑ item esperado recuperado', (s) => pct(s.retrievalHitRate)],
    ['↑ totalmente referenciadas', (s) => pct(s.groundedRate)],
    ['↓ sem referência ou inválida (strict: gate ajustou)', (s) => pct(s.unreferencedRate)],
    ['↓ com reparo', (s) => pct(s.repairedRate)],
    ['↓ latência média (sem subida do CLI)', (s) => (s.meanLatencyMs === null ? '—' : `${(s.meanLatencyMs / 1000).toFixed(1)} s`)],
    ['  subida do CLI descontada', (s) => (s.meanOverheadMs ? `${(s.meanOverheadMs / 1000).toFixed(1)} s` : '—')],
    ['↓ tokens médios', (s) => (s.meanTokens === null ? '—' : String(Math.round(s.meanTokens)))],
    ['erros', (s) => String(s.errors)],
  ];
  const head = `${'métrica (↑ maior é melhor, ↓ menor)'.padEnd(36)}${summary.map((s) => EVAL_ARMS[s.arm].short.padStart(14)).join('')}`;
  return [head, ...rows.map(([name, f]) => `${name.padEnd(36)}${summary.map((s) => f(s).padStart(14)).join('')}`)].join('\n');
}
