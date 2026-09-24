/** Retrieval híbrido: BM25 (FTS5) + KNN (vec0) [+ glossário] → RRF [+ bônus de seção] [→ reranker] → top-k → expansão folha→pai → ordenação por precedência. */
import type { Db } from '../db/sqlite.ts';
import type { PipelineConfig, RetrievalCandidate, RetrievalResult, StoredChunk } from '@editais/shared';
import { configHash } from '@editais/shared';
import { attestedTerms, bm25Search, getChunksByLabels, getChunksByRowids, getCorpusGlossary, getGlossary, getSearchScope, knnSearch, listRetrievableDocuments, IDENTIFIER_RE } from '../db/queries.ts';
import { glossaryVariants } from './glossary.ts';
import { docGlossaryVariants } from './doc-glossary.ts';
import type { GlossaryEntry } from '../ingest/glossary-extract.ts';
import { feedbackQuery, feedbackTerms } from './prf.ts';
import { namedDocuments, principalDocuments } from './routing.ts';

export type RetrieveInput = {
  db: Db;
  workspaceId: string;
  query: string;
  /** Reformulações da pergunta (expansão de consulta): cada uma gera suas listas BM25/vetorial e entra na fusão. */
  variants?: string[];
  documentIds?: string[];
  config: PipelineConfig;
  embedQuery: (text: string) => Promise<Float32Array>;
  /** Reranker (cross-encoder): escores dos textos para a consulta. Obrigatório quando config.retrieval.rerank ≠ 'off'. */
  rerank?: (query: string, texts: string[]) => Promise<number[]>;
};

/** Candidato em construção (o RetrievalCandidate final é derivado daqui). */
type Working = {
  chunk: StoredChunk;
  bm25Rank?: number;
  denseRank?: number;
  rrf: number;
  /** Escore do reranker (só nos candidatos que passaram por ele). */
  rerank?: number;
  selected: boolean;
  expandedTo?: string;
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex que casa o identificador como token inteiro (evita "6.5.5" dentro de "6.5.5.1" ou "16.5.5"). */
function identifierMatcher(id: string): RegExp {
  if (/^R\$/.test(id)) return new RegExp(`R\\$\\s?${escapeRe(id.replace(/^R\$\s?/, ''))}(?![\\d,])`);
  if (/^\p{Lu}+$/u.test(id)) return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(id)}(?![\\p{L}\\p{N}])`, 'u');
  // item numerado ou data
  return new RegExp(`(?<![\\d.\\/])${escapeRe(id)}(?![\\d\\/]|\\.\\d)`);
}

/** Identificadores exatos presentes na consulta (dedupe, ordem de aparição). */
export function extractIdentifiers(query: string): string[] {
  return [...new Set(query.match(IDENTIFIER_RE) ?? [])];
}

/** Origens do glossário do documento que a configuração liga. */
function glossaryKinds(rc: PipelineConfig['retrieval']): GlossaryEntry['kind'][] {
  return [
    ...(rc.docGlossary ? (['definicao', 'sigla', 'expressao'] as const) : []),
    ...(rc.llmGlossary ? (['llm'] as const) : []),
  ];
}

/**
 * Variantes do glossário derivado dos documentos. Com `sharedGlossary`, o glossário dos outros editais já ingeridos
 * entra junto — mas só pode contribuir com termo que exista no que está sendo buscado, senão vira consulta com palavra
 * que o texto não tem. O acervo ensina a relação; o documento em escopo precisa ter a palavra.
 */
function glossaryVariantsDoDocumento(input: RetrieveInput, scope: SearchScopeArg): string[] {
  const { db, workspaceId, config } = input;
  const rc = config.retrieval;
  const kinds = glossaryKinds(rc);
  if (kinds.length === 0) return [];
  const proprio = getGlossary(db, workspaceId, input.documentIds, kinds);
  if (!rc.sharedGlossary) return docGlossaryVariants(input.query, proprio);
  const doAcervo = getCorpusGlossary(db, listRetrievableDocuments(db, workspaceId, input.documentIds).map((d) => d.id), kinds);
  return docGlossaryVariants(input.query, [...proprio, ...doAcervo], undefined, (termos) => attestedTerms(db, scope, termos));
}

/** Quantos candidatos da primeira rodada formam a amostra de idf da realimentação. */
const PRF_AMOSTRA = 200;

export async function retrieve(input: RetrieveInput): Promise<RetrievalResult> {
  const t0 = performance.now();
  const { db, workspaceId, query, config } = input;
  const rc = config.retrieval;
  const hash = configHash(config);

  // 1. escopo
  const scope = getSearchScope(db, workspaceId, input.documentIds);
  if (scope.chunkSets.length === 0) {
    return { query, configHash: hash, candidates: [], context: [], contextChars: 0, latencyMs: performance.now() - t0 };
  }

  // 2. listas por índice — a pergunta original e, com expansão de consulta, cada variante (+ variantes do glossário)
  // dedupe: variante repetida faz a mesma busca duas vezes e entra duas vezes no RRF, dobrando o peso daquela lista
  const variants = [...new Set([
    ...(input.variants ?? []),
    ...(rc.glossary ? glossaryVariants(query) : []),
    ...glossaryVariantsDoDocumento(input, scope),
  ].map((v) => v.trim()).filter((v) => v && v !== query.trim()))];
  let { bm25, dense, extra } = await searchLists(input, scope, variants);

  // 2b. realimentação por pseudo-relevância: termos discriminativos dos melhores trechos viram uma busca a mais
  if (rc.prf) {
    const feedback = prfVariant(db, query, bm25, dense, rc.prfDocs, rc.prfTerms);
    if (feedback) {
      variants.push(feedback);
      ({ bm25, dense, extra } = await searchLists(input, scope, variants));
    }
  }

  // 3. RRF (+ bônus para identificadores exatos da consulta no modo híbrido)
  const working = fuseRanks(db, bm25.map((r) => r.rowid), dense.map((r) => r.rowid), rc.rrfK, extra);
  if (rc.mode === 'hybrid') boostIdentifiers(working, query, rc.rrfK);
  if (rc.sectionBoost) boostSections(working, rc.rrfK);
  const { namedTitles, quotaDocs } = routeDocuments(input, working);
  if (rc.rerank !== 'off') {
    if (!input.rerank) throw new Error('retrieval.rerank ligado sem função de rerank');
    await rerankTop(working, query, rc.rerankCandidates, input.rerank);
  }
  const ranked = [...working.values()].sort(byScore);

  // 4. top-k (com cota mínima por edital principal quando há vários e nenhum foi nomeado)
  let selected = quotaDocs.length >= 2 ? selectWithQuota(ranked, quotaDocs, rc.topK) : ranked.slice(0, rc.topK);
  for (const w of selected) w.selected = true;

  // 5. expansão folha→pai (até ponto fixo: table_row → table → section) e reposição do top-k
  if (rc.expandToParent) {
    for (let changed = true, rounds = 0; changed && rounds < 4; rounds++) {
      ({ selected, changed } = expandToParents(db, workspaceId, config, working, selected));
    }
    refillTopK(ranked, selected, rc.topK);
  }

  // 6. orçamento (ordem RRF) e 7. ordem final por precedência
  const { context, used } = fitBudget(selected, rc.contextBudgetChars);

  // 8. resultado
  const candidates: RetrievalCandidate[] = [...working.values()].sort(byScore).map((w) => {
    const c: RetrievalCandidate = { label: w.chunk.label, chunkRowid: w.chunk.rowid, rrfScore: w.rrf, selected: w.selected };
    if (w.bm25Rank !== undefined) c.bm25Rank = w.bm25Rank;
    if (w.denseRank !== undefined) c.denseRank = w.denseRank;
    if (w.expandedTo !== undefined) c.expandedTo = w.expandedTo;
    return c;
  });

  return {
    query,
    ...(variants.length > 0 ? { variants } : {}),
    ...(namedTitles.length > 0 ? { namedDocuments: namedTitles } : {}),
    configHash: hash,
    candidates,
    context: context.map((w) => w.chunk),
    contextChars: used,
    latencyMs: performance.now() - t0,
  };
}

/** Ordem: quem passou pelo reranker vem antes (pelo escore dele); o resto pela fusão. */
type SearchScopeArg = ReturnType<typeof getSearchScope>;

/** Listas por índice: BM25 e/ou vetorial da pergunta (com ranks) e de cada variante (só para a fusão). */
async function searchLists(input: RetrieveInput, scope: SearchScopeArg, variants: string[]): Promise<{ bm25: Array<{ rowid: number; score: number }>; dense: Array<{ rowid: number; distance: number }>; extra: number[][] }> {
  const { db, config } = input;
  const rc = config.retrieval;
  const bm25 = rc.mode === 'dense' ? [] : bm25Search(db, scope, input.query, rc.candidates);
  const dense = rc.mode === 'bm25' ? [] : knnSearch(db, config.embedModel, scope, await input.embedQuery(input.query), rc.candidates);
  const extra: number[][] = [];
  for (const v of variants) {
    if (rc.mode !== 'dense') extra.push(bm25Search(db, scope, v, rc.candidates).map((r) => r.rowid));
    if (rc.mode !== 'bm25') extra.push(knnSearch(db, config.embedModel, scope, await input.embedQuery(v), rc.candidates).map((r) => r.rowid));
  }
  return { bm25, dense, extra };
}

/** Roteamento por documento: bônus (posição 1 extra no RRF) aos trechos do documento nomeado; sem nomeado, devolve os editais principais para a cota. */
function routeDocuments(input: RetrieveInput, working: Map<number, Working>): { namedTitles: string[]; quotaDocs: string[] } {
  const rc = input.config.retrieval;
  if (!rc.documentRouting) return { namedTitles: [], quotaDocs: [] };
  const docs = listRetrievableDocuments(input.db, input.workspaceId, input.documentIds);
  const named = namedDocuments(input.query, docs);
  if (named.size === 0) return { namedTitles: [], quotaDocs: principalDocuments(docs).map((d) => d.id) };
  for (const w of working.values()) if (named.has(w.chunk.documentId)) w.rrf += 1 / (rc.rrfK + 1);
  return { namedTitles: docs.filter((d) => named.has(d.id)).map((d) => d.title), quotaDocs: [] };
}

/** Cota por edital: os melhores `quota` trechos de cada edital principal entram primeiro; o resto do top-k segue a ordem global. */
function selectWithQuota(ranked: Working[], docIds: string[], topK: number): Working[] {
  const quota = Math.max(1, Math.floor(topK / (2 * docIds.length)));
  const chosen = new Set<Working>();
  for (const id of docIds) {
    let n = 0;
    for (const w of ranked) {
      if (n >= quota) break;
      if (w.chunk.documentId === id && !chosen.has(w)) {
        chosen.add(w);
        n++;
      }
    }
  }
  for (const w of ranked) {
    if (chosen.size >= topK) break;
    chosen.add(w);
  }
  return ranked.filter((w) => chosen.has(w)).slice(0, topK);
}

/** Consulta de realimentação a partir dos trechos mais bem colocados da primeira rodada. */
function prfVariant(db: Db, query: string, bm25: Array<{ rowid: number }>, dense: Array<{ rowid: number }>, docs: number, termos: number): string | null {
  const topo = [...new Set([...bm25.slice(0, docs).map((r) => r.rowid), ...dense.slice(0, docs).map((r) => r.rowid)])];
  if (topo.length === 0) return null;
  const textos = getChunksByRowids(db, topo).map((c) => c.text);
  const amostra = getChunksByRowids(db, [...new Set([...bm25, ...dense].map((r) => r.rowid))].slice(0, PRF_AMOSTRA)).map((c) => c.text);
  return feedbackQuery(query, feedbackTerms(query, textos, amostra, termos));
}

function byScore(a: Working, b: Working): number {
  const ra = a.rerank ?? Number.NEGATIVE_INFINITY;
  const rb = b.rerank ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  return b.rrf - a.rrf || a.chunk.rowid - b.chunk.rowid;
}

/**
 * Estrutura do edital: os chunks de seção ("3. CRITÉRIOS DE ELEGIBILIDADE") rankeiam bem pelo título e pelo conteúdo amplo;
 * os filhos das 3 melhores seções ganham bônus proporcional à posição da seção. É o que leva "quem pode propor" ao item 3.6
 * mesmo sem palavra em comum com ele.
 */
function boostSections(working: Map<number, Working>, rrfK: number): void {
  const sections = [...working.values()].filter((w) => w.chunk.kind === 'section').sort(byScore).slice(0, 3);
  if (sections.length === 0) return;
  for (const w of working.values()) {
    if (w.chunk.kind === 'section') continue;
    const path = w.chunk.sectionPath;
    const idx = sections.findIndex((sec) => (w.chunk.parentLabel !== undefined && w.chunk.parentLabel === sec.chunk.label) || (sec.chunk.heading !== undefined && sec.chunk.heading !== '' && path.includes(sec.chunk.heading)) || (sec.chunk.itemNumber !== undefined && path.startsWith(`${sec.chunk.itemNumber}. `)));
    if (idx >= 0) w.rrf += 1 / (rrfK + idx + 1);
  }
}

/** Reranker sobre os N melhores da fusão (ordem RRF): pergunta e trecho lidos juntos; os demais ficam atrás, na ordem RRF. */
async function rerankTop(working: Map<number, Working>, query: string, n: number, rerank: NonNullable<RetrieveInput['rerank']>): Promise<void> {
  const top = [...working.values()].sort(byScore).slice(0, n);
  if (top.length === 0) return;
  const scores = await rerank(query, top.map((w) => `${w.chunk.contextPrefix} ${w.chunk.text}`));
  top.forEach((w, i) => { w.rerank = scores[i] ?? Number.NEGATIVE_INFINITY; });
}

/**
 * Reciprocal Rank Fusion das listas da pergunta original (que guardam bm25Rank/denseRank) e das listas extras
 * das variantes (só somam ao escore); carrega os chunks do banco (um rowid pode ter sumido entre a busca e a leitura).
 */
function fuseRanks(db: Db, bm25Rowids: number[], denseRowids: number[], rrfK: number, extra: number[][] = []): Map<number, Working> {
  const ranks = new Map<number, { bm25Rank?: number; denseRank?: number; rrf: number }>();
  const add = (rowid: number, key: 'bm25Rank' | 'denseRank' | null, rank: number) => {
    const entry = ranks.get(rowid) ?? { rrf: 0 };
    if (key) entry[key] = rank;
    entry.rrf += 1 / (rrfK + rank);
    ranks.set(rowid, entry);
  };
  bm25Rowids.forEach((rowid, i) => add(rowid, 'bm25Rank', i + 1));
  denseRowids.forEach((rowid, i) => add(rowid, 'denseRank', i + 1));
  for (const list of extra) list.forEach((rowid, i) => add(rowid, null, i + 1));

  const chunkByRowid = new Map(getChunksByRowids(db, [...ranks.keys()]).map((c) => [c.rowid, c]));
  const working = new Map<number, Working>();
  for (const [rowid, r] of ranks) {
    const chunk = chunkByRowid.get(rowid);
    if (!chunk) continue;
    const w: Working = { chunk, rrf: r.rrf, selected: false };
    if (r.bm25Rank !== undefined) w.bm25Rank = r.bm25Rank;
    if (r.denseRank !== undefined) w.denseRank = r.denseRank;
    working.set(rowid, w);
  }
  return working;
}

/** Chunks que contêm um identificador exato da consulta (item "6.5.5", data, valor, sigla) ganham o equivalente a uma posição 1 extra no RRF. */
function boostIdentifiers(working: Map<number, Working>, query: string, rrfK: number): void {
  const matchers = extractIdentifiers(query).map(identifierMatcher);
  if (matchers.length === 0) return;
  for (const w of working.values()) {
    const hay = `${w.chunk.itemNumber ?? ''} ${w.chunk.text}`;
    if (matchers.some((re) => re.test(hay))) w.rrf += 1 / (rrfK + 1);
  }
}

/** Vagas liberadas pela expansão: próximos candidatos (ordem RRF) não cobertos por um pai já selecionado. */
function refillTopK(ranked: Working[], selected: Working[], topK: number): void {
  const covered = new Set(selected.map((w) => keyOf(w.chunk, w.chunk.label)));
  for (const w of ranked) {
    if (selected.length >= topK) break;
    if (w.selected || w.expandedTo !== undefined) continue;
    if (w.chunk.parentLabel && covered.has(keyOf(w.chunk, w.chunk.parentLabel))) continue;
    w.selected = true;
    selected.push(w);
  }
}

/** Mantém, em ordem RRF, o que cabe no orçamento de caracteres; o contexto final vai por precedência (retificações primeiro). */
function fitBudget(selected: Working[], budgetChars: number): { context: Working[]; used: number } {
  selected.sort(byScore);
  let used = 0;
  const context: Working[] = [];
  for (const w of selected) {
    const size = w.chunk.charCount || w.chunk.text.length;
    if (used + size > budgetChars) {
      w.selected = false;
      continue;
    }
    used += size;
    context.push(w);
  }
  context.sort((a, b) => b.chunk.precedence - a.chunk.precedence || byScore(a, b));
  return { context, used };
}

/** Chave (documento, chunk_set, rótulo) — rótulos só são únicos dentro de um chunk_set. */
function keyOf(chunk: Pick<StoredChunk, 'documentId' | 'chunkSetId'>, label: string): string {
  return `${chunk.documentId}|${chunk.chunkSetId}|${label}`;
}

/** Substitui grupos de ≥ 2 folhas do mesmo pai pelo chunk-pai (quando cabe em maxChars×3); um pai já selecionado também absorve suas folhas. */
function expandToParents(db: Db, workspaceId: string, config: PipelineConfig, working: Map<number, Working>, selected: Working[]): { selected: Working[]; changed: boolean } {
  const maxParentChars = config.chunking.maxChars * 3;
  const byKey = new Map<string, Working>();
  for (const w of working.values()) byKey.set(keyOf(w.chunk, w.chunk.label), w);

  // folhas selecionadas agrupadas pelo pai
  const groups = new Map<string, Working[]>();
  for (const w of selected) {
    if (!w.chunk.parentLabel) continue;
    const key = keyOf(w.chunk, w.chunk.parentLabel);
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  const expandable = [...groups.entries()].filter(([key, leaves]) => leaves.length >= 2 || byKey.get(key)?.selected);
  if (expandable.length === 0) return { selected, changed: false };

  // pais que ainda não são candidatos: carregar do banco
  const missing = expandable.filter(([key]) => !byKey.has(key)).map(([key]) => key.split('|')[2]!);
  for (const chunk of getChunksByLabels(db, workspaceId, missing)) {
    byKey.set(keyOf(chunk, chunk.label), { chunk, rrf: 0, selected: false });
  }

  const removed = new Set<Working>();
  const added: Working[] = [];
  for (const [key, leaves] of expandable) {
    const parent = byKey.get(key);
    if (!parent || parent.chunk.charCount > maxParentChars) continue;
    let absorbed = 0;
    for (const leaf of leaves) {
      leaf.selected = false;
      leaf.expandedTo = parent.chunk.label;
      absorbed += leaf.rrf;
      removed.add(leaf);
    }
    parent.rrf = Math.max(parent.rrf, absorbed);
    const best = Math.max(...leaves.map((l) => l.rerank ?? Number.NEGATIVE_INFINITY));
    if (Number.isFinite(best)) parent.rerank = Math.max(parent.rerank ?? Number.NEGATIVE_INFINITY, best);
    if (!parent.selected) {
      parent.selected = true;
      added.push(parent);
    }
    working.set(parent.chunk.rowid, parent);
  }
  return { selected: [...selected.filter((w) => !removed.has(w)), ...added], changed: removed.size > 0 || added.length > 0 };
}
