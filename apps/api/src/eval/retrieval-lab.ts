/**
 * Laboratório de recuperação: mede, SEM chamar LLM de geração, se o item esperado do padrão-ouro entra no contexto (hit@top-k)
 * para combinações dos componentes da busca — glossário, bônus de seção, reranker, top-k — com e sem expansão de consulta.
 * A expansão é reproduzida a partir das variantes gravadas nas execuções anteriores (`data/eval/runs/*.json`): cada execução
 * é uma amostra da reescrita do modelo, então "com expansão" sai como média/mínimo entre amostras.
 *
 * `node apps/api/src/eval/retrieval-lab.ts [--questions nucleo.csv] [--rerankers bge-m3,jina-v2] [--topk 12,16,20] [--out lab.json]`
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PipelineConfig, type EvalQuestion, type EvalRun } from '@editais/shared';
import { createContext } from '../context.ts';
import { getReranker, type RerankerId } from '../embed/reranker.ts';
import { retrieve } from '../retrieval/hybrid.ts';
import { coversItem, inExpectedDocument } from './metrics.ts';
import { loadQuestions, planQuestions, runsDir } from './runner.ts';

const { values: opts } = parseArgs({
  options: {
    questions: { type: 'string', default: 'nucleo.csv' },
    rerankers: { type: 'string', default: 'bge-m3' },
    topk: { type: 'string', default: '12' },
    candidates: { type: 'string', default: '30' },
    out: { type: 'string' },
    only: { type: 'string' },
  },
});

const ctx = createContext();
const planned = planQuestions(ctx, loadQuestions(ctx, opts.questions), undefined).filter((p) => p.question.expectedItem);
const rerankers = opts.rerankers.split(',').map((s) => s.trim()).filter(Boolean) as RerankerId[];
const topks = opts.topk.split(',').map(Number);
const candidatesList = opts.candidates.split(',').map(Number);

/* ---------- amostras de expansão gravadas ---------- */
type Sample = { runId: string; label: string; model: string; variants: Map<string, string[]> };
function loadSamples(): Sample[] {
  const dir = runsDir(ctx);
  const out: Sample[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EvalRun;
    if (!run.expansions || run.questionsFile !== opts.questions) continue;
    const variants = new Map<string, string[]>();
    for (const [key, e] of Object.entries(run.expansions)) if (e.variants.length >= 4) variants.set(key, e.variants.slice(0, 4));
    if (variants.size < planned.length * 0.9) continue;
    out.push({ runId: run.id, label: run.label ?? run.id, model: run.llm.model, variants });
  }
  return out;
}
const samples = loadSamples();

/* ---------- cache de rerank (pergunta × chunk) ---------- */
const cacheFile = path.join(ctx.config.dataDir, 'eval', 'rerank-cache.json');
const rerankCache: Record<string, number> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
let cacheDirty = false;
function rerankWith(id: RerankerId) {
  const r = getReranker(id);
  return async (query: string, texts: string[]) => {
    const out = new Array<number>(texts.length);
    const missing: number[] = [];
    texts.forEach((t, i) => {
      const k = `${id}|${query}|${t.slice(0, 400)}`;
      if (k in rerankCache) out[i] = rerankCache[k]!;
      else missing.push(i);
    });
    if (missing.length > 0) {
      const scores = await r.score(query, missing.map((i) => texts[i]!));
      missing.forEach((i, j) => {
        out[i] = scores[j]!;
        rerankCache[`${id}|${query}|${texts[i]!.slice(0, 400)}`] = scores[j]!;
      });
      cacheDirty = true;
    }
    return out;
  };
}

/* ---------- configurações ---------- */
type Variant = { name: string; retrieval: Partial<PipelineConfig['retrieval']>; expansion: boolean };
const grid: Variant[] = [];
for (const topK of topks) for (const candidates of candidatesList) for (const expansion of [false, true]) for (const glossary of [false, true]) for (const docGlossary of [false, true]) for (const llmGlossary of [false, true]) for (const sharedGlossary of [false, true]) for (const prf of [false, true]) for (const rerank of ['off', ...rerankers] as Array<'off' | RerankerId>) {
  if (glossary && (docGlossary || llmGlossary)) continue; // o glossário à mão não se combina com os derivados do documento
  if (sharedGlossary && !docGlossary && !llmGlossary) continue; // o acervo é uma ampliação do glossário do documento
  const parts = [expansion ? 'exp' : 'noexp', glossary ? 'gloss:mao' : '', docGlossary ? 'gloss:doc' : '', llmGlossary ? 'gloss:llm' : '', sharedGlossary ? 'acervo' : '', prf ? 'prf' : '',
    rerank !== 'off' ? `rr:${rerank}` : '', `k${topK}`, candidates !== 30 ? `c${candidates}` : ''].filter(Boolean);
  grid.push({ name: parts.join('+'), retrieval: { topK, candidates, glossary, docGlossary, llmGlossary, sharedGlossary, prf, sectionBoost: false, rerank, queryExpansion: expansion ? 4 : 0 }, expansion });
}
const selected = opts.only ? grid.filter((g) => opts.only!.split(',').some((p) => g.name.includes(p))) : grid;

type Result = { name: string; hit: number; hitMin: number | null; hitMax: number | null; samples: number; misses: string[]; latencyMs: number };
const results: Result[] = [];

async function hitRate(v: Variant, variantsFor: ((key: string) => string[]) | null): Promise<{ rate: number; misses: string[]; latencyMs: number }> {
  let hits = 0;
  const misses: string[] = [];
  let latency = 0;
  for (const p of planned) {
    const q: EvalQuestion = p.question;
    const config = PipelineConfig.parse({ ...p.workspace.settings, retrieval: { ...p.workspace.settings.retrieval, ...v.retrieval } });
    const key = `${q.id}|${p.workspace.id}`;
    const t0 = performance.now();
    const r = await retrieve({
      db: ctx.db,
      workspaceId: p.workspace.id,
      query: q.question,
      variants: variantsFor ? variantsFor(key) : [],
      config,
      embedQuery: (text) => ctx.embedder(config.embedModel).embedQuery(text),
      ...(config.retrieval.rerank !== 'off' ? { rerank: rerankWith(config.retrieval.rerank) } : {}),
    });
    latency += performance.now() - t0;
    if (r.context.some((c) => coversItem(c, q.expectedItem!) && inExpectedDocument(c, q.expectedDocument))) hits++;
    else misses.push(q.id);
  }
  return { rate: hits / planned.length, misses, latencyMs: latency / planned.length };
}

console.error(`${planned.length} perguntas com item esperado · ${samples.length} amostras de expansão (${samples.map((s) => `${s.label}/${s.model}`).join(', ')}) · ${selected.length} configurações`);
for (const v of selected) {
  const t0 = performance.now();
  if (!v.expansion) {
    const r = await hitRate(v, null);
    results.push({ name: v.name, hit: r.rate, hitMin: null, hitMax: null, samples: 0, misses: r.misses, latencyMs: r.latencyMs });
  } else {
    const rates: number[] = [];
    const missCount = new Map<string, number>();
    let lat = 0;
    for (const s of samples) {
      const r = await hitRate(v, (key) => s.variants.get(key) ?? []);
      rates.push(r.rate);
      lat += r.latencyMs;
      for (const m of r.misses) missCount.set(m, (missCount.get(m) ?? 0) + 1);
    }
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    results.push({ name: v.name, hit: mean, hitMin: Math.min(...rates), hitMax: Math.max(...rates), samples: rates.length, misses: [...missCount.entries()].sort((a, b) => b[1] - a[1]).map(([q, n]) => `${q}×${n}`), latencyMs: lat / rates.length });
  }
  const last = results.at(-1)!;
  console.error(`${v.name.padEnd(40)} hit ${(last.hit * 100).toFixed(1)}%${last.hitMin !== null ? ` (min ${(last.hitMin * 100).toFixed(0)}% · max ${(last.hitMax! * 100).toFixed(0)}%)` : ''} · ${last.latencyMs.toFixed(0)} ms/pergunta · ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  if (cacheDirty) {
    fs.writeFileSync(cacheFile, JSON.stringify(rerankCache));
    cacheDirty = false;
  }
}

results.sort((a, b) => b.hit - a.hit || a.latencyMs - b.latencyMs);
console.log('\n| configuração | hit@k | min | max | amostras | ms/pergunta | erros |');
console.log('|---|---:|---:|---:|---:|---:|---|');
for (const r of results) console.log(`| ${r.name} | ${(r.hit * 100).toFixed(1)}% | ${r.hitMin === null ? '—' : `${(r.hitMin * 100).toFixed(0)}%`} | ${r.hitMax === null ? '—' : `${(r.hitMax * 100).toFixed(0)}%`} | ${r.samples || '—'} | ${r.latencyMs.toFixed(0)} | ${r.misses.slice(0, 8).join(' ')} |`);
if (opts.out) fs.writeFileSync(opts.out, JSON.stringify({ questions: planned.length, samples: samples.map((s) => ({ runId: s.runId, label: s.label, model: s.model })), results }, null, 1));
await ctx.close();
