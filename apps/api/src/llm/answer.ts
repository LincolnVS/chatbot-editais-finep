/** Núcleo de resposta: retrieval + geração + validação de citações + gate de fundamentação (usado por /ask, /chat e pelo harness). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel, LanguageModelUsage, ModelMessage, UIMessageChunk, UIMessageStreamWriter } from 'ai';
import { APICallError, RetryError, createUIMessageStream, generateText, streamText, toUIMessageStream } from 'ai';
import type { Db } from '../db/sqlite.ts';
import type {
  AnswerResult, AnswerWarning, CanonicalSection, DocumentSummary, GroundingIssue, GroundingReport, LlmConfig, PipelineConfig, RetrievalResult, StoredChunk, Usage, AnswerTimings } from '@editais/shared';
import { configHash } from '@editais/shared';
import { retrieve } from '../retrieval/hybrid.ts';
import { listRetrievableDocuments, getChunksByLabels } from '../db/queries.ts';
import { storage } from '../storage.ts';
import { describeError, makeModel, providerLabel } from './providers.ts';
import { sectionText, validateCitations, validateSectionCitations, type CitationValidation, type SectionWithDocument, extractLabels } from './citations.ts';
import { ABSTENTION_RE, applyGrounding, repairInstruction, type GroundingOutcome, sourceValues } from './grounding.ts';
import { cliOverheadMs, expandQuery, type Expansion } from './expand.ts';

export type AnswerInput = {
  db: Db;
  workspaceId: string;
  question: string;
  documentIds?: string[];
  config: PipelineConfig;
  llm: LlmConfig;
  /** Provedor reserva usado quando o principal falha por limite de uso, indisponibilidade ou timeout. */
  llmFallback?: LlmConfig;
  history?: ModelMessage[];
  embedQuery: (text: string) => Promise<Float32Array>;
  /** Resultado de `prepareAnswer(input)` já calculado (evita repetir o retrieval e antecipa os erros de preparação). */
  prepared?: Prepared;
  /** Expansão de consulta já gerada (o harness gera uma vez por pergunta e reparte entre os braços). */
  expansion?: Expansion;
};

/** Multiplicador do orçamento de retrieval para o baseline de documento integral (28k × 12 ≈ 336k chars). */
export const FULL_CONTEXT_BUDGET_FACTOR = 12;
const GENERATION_TIMEOUT_MS = 120_000;

/** Lançado quando o escopo não tem nenhum documento pronto (modo full_context) — a rota responde 409. */
export class NoDocumentsError extends Error {
  readonly code = 'no_documents';
  constructor() {
    super('Nenhum documento pronto no escopo selecionado para o modo full_context.');
    this.name = 'NoDocumentsError';
  }
}

/** Lançado quando o(s) documento(s) do baseline não cabem no orçamento — nunca truncamos em silêncio. */
export class ContextTooLargeError extends Error {
  readonly code = 'context_too_large';
  readonly fitsInWindow = false;
  readonly chars: number;
  readonly budget: number;
  constructor(chars: number, budget: number) {
    super(`Documento(s) integral(is) com ${chars} caracteres excedem o orçamento de ${budget} (contextBudgetChars × ${FULL_CONTEXT_BUDGET_FACTOR}).`);
    this.name = 'ContextTooLargeError';
    this.chars = chars;
    this.budget = budget;
  }
}

/** Resposta determinística quando o retrieval não devolve nenhum trecho: não há o que citar, então o modelo nem é chamado. */
const NO_CONTEXT_ANSWER =
  'Não consta nos documentos selecionados. Não encontrei nenhum trecho relacionado à pergunta nos documentos do escopo. ' +
  'Tente reformular com os termos usados no edital (nome do item, seção ou anexo) ou confira se o documento certo está selecionado.';

/* ---------- prompts ---------- */

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const promptCache = new Map<string, string>();

/** Carrega e cacheia o prompt `llm/prompts/<name>.md`. */
export function loadPrompt(name: string): string {
  const cached = promptCache.get(name);
  if (cached !== undefined) return cached;
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  if (!fs.existsSync(file)) throw new Error(`Prompt não encontrado: ${file}`);
  const text = fs.readFileSync(file, 'utf8').trim();
  promptCache.set(name, text);
  return text;
}

/** Nome do prompt efetivo para o modo: família "qa.vN" → "baseline.vN" / "closed_book.vN". */
export function resolvePromptName(mode: AnswerResult['mode'], promptVersion: string): string {
  const family = promptVersion.match(/^qa\.(v\d+)$/);
  if (!family) return promptVersion;
  if (mode === 'full_context') return `baseline.${family[1]}`;
  if (mode === 'closed_book') return `closed_book.${family[1]}`;
  return promptVersion;
}

/* ---------- preparação do prompt por modo ---------- */

export type Prepared = {
  mode: AnswerResult['mode'];
  promptName: string;
  instructions: string;
  messages: ModelMessage[];
  retrieval?: RetrievalResult;
  fitsInWindow?: boolean;
  /** Há material citável (chunks/seções) — o reparo só faz sentido nesse caso. */
  canRepair: boolean;
  labelKind: 'chunk' | 'section';
  validate: (text: string) => CitationValidation;
  /** Texto-fonte de um rótulo válido (para o gate de fundamentação). */
  sourceText: (label: string) => string | undefined;
  /** Texto de todo o contexto enviado ao modelo (para o gate separar citação no item errado de valor inventado). */
  contextText?: () => string;
  /** Resposta pronta sem chamar o modelo (retrieval vazio). */
  immediate?: string;
  warnings: AnswerWarning[];
  /** Tokens gastos na preparação (expansão de consulta), somados ao uso da resposta. */
  extraUsage?: LanguageModelUsage;
  /** Tempo das etapas de preparação (expansão e busca), em ms. */
  timings?: Pick<AnswerTimings, 'expansionMs' | 'retrievalMs' | 'overheadMs'>;
  /** Buscas adicionais já pedidas pelo modelo (modo busca extra). */
  searched?: string[];
  /** Instante em que a preparação começou (a rota prepara antes de abrir o stream; o total conta desde aqui). */
  startedAt?: number;
};

const ANAPHORA_RE = /\b(isso|isto|esse|essa|esses|essas|ele|ela|eles|elas|dele|dela|deles|delas|mesmo|mesma|tamb[ée]m|nesse|nessa|neste|nesta|desse|dessa|a[íi])\b/i;
const FOLLOW_UP_START_RE = /^(e|mas|ent[ãa]o|ok|certo|sim|n[ãa]o)\b/i;

/** Follow-ups curtos ("e o valor?", "isso vale para ICTs?") herdam a pergunta anterior na consulta de retrieval. */
export function condenseQuestion(question: string, history: ModelMessage[] | undefined): { query: string; condensedFrom?: string } {
  const previous = [...(history ?? [])].reverse().find((m) => m.role === 'user');
  if (!previous || typeof previous.content !== 'string') return { query: question };
  const words = question.trim().split(/\s+/).filter((w) => w.length > 2);
  const short = words.length < 5;
  const dependent = ANAPHORA_RE.test(question) || FOLLOW_UP_START_RE.test(question.trim());
  if (!short && !dependent) return { query: question };
  return { query: `${previous.content.trim()} ${question.trim()}`, condensedFrom: question };
}

/** Modo RAG: expansão da consulta, busca híbrida e prompt com os trechos (mede o tempo das duas etapas). */
async function prepareRag(input: AnswerInput, promptName: string, instructions: string, withHistory: (userText: string) => ModelMessage[]): Promise<Prepared> {
    const { query, condensedFrom } = condenseQuestion(input.question, input.history);
    const count = input.config.retrieval.queryExpansion;
    const t0 = performance.now();
    const expansion = count > 0 && input.expansion ? input.expansion : await expandQuery(input.llm, query, count);
    const expansionMs = Math.round(performance.now() - t0);
    const retrieval = await retrieve({
      db: input.db,
      workspaceId: input.workspaceId,
      query,
      variants: expansion.variants,
      documentIds: input.documentIds,
      config: input.config,
      embedQuery: input.embedQuery,
    });
    if (condensedFrom) retrieval.condensedFrom = condensedFrom;
    const warnings: AnswerWarning[] = [];
    if (expansion.error) warnings.push({ code: 'expansion_failed', message: `A expansão de consulta falhou e a busca usou só a pergunta original: ${expansion.error}` });
    return {
      ...ragPrepared(input, retrieval, { promptName, instructions, withHistory }),
      warnings: [...ragWarnings(input, retrieval), ...warnings],
      timings: { ...(count > 0 ? { expansionMs } : {}), retrievalMs: Math.round(retrieval.latencyMs), ...(expansion.overheadMs ? { overheadMs: expansion.overheadMs } : {}) },
      ...(expansion.usage ? { extraUsage: expansion.usage } : {}),
    };
}

type RagPromptParts = { promptName: string; instructions: string; withHistory: (userText: string) => ModelMessage[] };

/** Nenhum candidato lexical: os trechos vieram só por similaridade e podem não responder (só vale quando a busca léxica rodou). */
function ragWarnings(input: AnswerInput, retrieval: RetrievalResult): AnswerWarning[] {
  const weak = input.config.retrieval.mode !== 'dense' && retrieval.context.length > 0 && !retrieval.candidates.some((c) => c.bm25Rank !== undefined);
  return weak ? [{ code: 'weak_retrieval', message: 'Nenhum trecho contém os termos da pergunta; os trechos usados vieram só por similaridade.' }] : [];
}

/** Prompt, validação e fonte dos rótulos a partir de um retrieval (o contexto pode crescer com a busca extra). */
function ragPrepared(input: AnswerInput, retrieval: RetrievalResult, prompt: RagPromptParts, searched: string[] = []): Prepared {
  const context = retrieval.context;
  const byLabel = new Map(context.map((c) => [c.label, c]));
  const weak = ragWarnings(input, retrieval).length > 0;
  return {
    mode: 'rag',
    promptName: prompt.promptName,
    instructions: prompt.instructions,
    messages: prompt.withHistory(ragUserMessage(context, input.question, weak, { extraSearch: input.config.generation.extraSearch, searched })),
    retrieval,
    canRepair: context.length > 0,
    labelKind: 'chunk',
    validate: (text) => validateCitations(text, context),
    sourceText: (label) => {
      const chunk = byLabel.get(label);
      return chunk ? `${chunk.itemNumber ?? ''} ${chunk.sectionPath}\n${chunk.text}` : undefined;
    },
    contextText: () => documentsText(input),
    ...(context.length === 0 ? { immediate: NO_CONTEXT_ANSWER } : {}),
    warnings: [],
    searched,
  };
}

/** Quantas rodadas de busca extra o modelo pode pedir e quanto o contexto pode crescer com elas. */
const MAX_EXTRA_SEARCH_ROUNDS = 2;
const EXTRA_SEARCH_TOP_K = 6;
const EXTRA_SEARCH_MAX_CHARS = 10_000;
const SEARCH_TAG_RE = /<buscar>\s*([^<]{3,200}?)\s*<\/buscar>/gi;

/**
 * Pedidos de busca do modelo (`<buscar>…</buscar>`), até 3. Na resposta espontânea a etiqueta só vale se for a resposta
 * inteira — senão confundiria com o modelo citando a etiqueta no meio de um texto. Depois da cobrança, que pediu busca
 * explicitamente, qualquer etiqueta conta: o modelo costuma justificar junto, e descartar por isso perde a busca.
 */
export function parseSearchRequests(text: string, soEtiquetas = true): string[] {
  const queries = [...text.matchAll(SEARCH_TAG_RE)].map((m) => (m[1] as string).trim());
  if (queries.length === 0) return [];
  if (soEtiquetas && text.replace(SEARCH_TAG_RE, '').trim().length > 80) return [];
  return [...new Set(queries)].slice(0, 3);
}

/** Roda as buscas pedidas pelo modelo (sem expansão, top-k menor) e acrescenta ao contexto os trechos que ainda não estavam nele. */
async function extendRagContext(input: AnswerInput, prepared: Prepared, queries: string[], prompt: RagPromptParts): Promise<Prepared> {
  const base = prepared.retrieval!;
  const have = new Set(base.context.map((c) => c.label));
  const context = [...base.context];
  const candidates = [...base.candidates];
  let extraChars = 0;
  const listas: RetrievalResult[] = [];
  for (const query of queries) {
    listas.push(await retrieve({
      db: input.db,
      workspaceId: input.workspaceId,
      query,
      variants: [],
      documentIds: input.documentIds,
      config: { ...input.config, retrieval: { ...input.config.retrieval, queryExpansion: 0, topK: EXTRA_SEARCH_TOP_K } },
      embedQuery: input.embedQuery,
    }));
  }
  // Rodízio entre as buscas: drenar a primeira lista até o orçamento acabar mata a segunda e a terceira, que costumam ser
  // as específicas — o modelo abre repetindo a pergunta e só depois chuta os termos do edital.
  for (let pos = 0; pos < EXTRA_SEARCH_TOP_K; pos++) {
    for (const r of listas) {
      const chunk = r.context[pos];
      if (!chunk || have.has(chunk.label) || extraChars + chunk.text.length > EXTRA_SEARCH_MAX_CHARS) continue;
      have.add(chunk.label);
      context.push(chunk);
      extraChars += chunk.text.length;
      const cand = r.candidates.find((c) => c.label === chunk.label);
      if (cand) candidates.push({ ...cand, selected: true });
    }
  }
  const retrieval: RetrievalResult = { ...base, context, candidates, contextChars: base.contextChars + extraChars };
  const searched = [...(prepared.searched ?? []), ...queries];
  return { ...ragPrepared(input, retrieval, prompt, searched), warnings: prepared.warnings, timings: prepared.timings, extraUsage: prepared.extraUsage, startedAt: prepared.startedAt };
}

/** Monta prompt/mensagens do modo (retrieval, documentos integrais ou closed book) sem chamar o LLM. */
export async function prepareAnswer(input: AnswerInput): Promise<Prepared> {
  if (input.prepared) return input.prepared;
  const startedAt = performance.now();
  const prepared = await buildPrepared(input);
  return { ...prepared, startedAt };
}

async function buildPrepared(input: AnswerInput): Promise<Prepared> {
  const mode = input.config.generation.mode;
  const promptName = resolvePromptName(mode, input.config.generation.promptVersion);
  const instructions = loadPrompt(promptName);
  const withHistory = (userText: string): ModelMessage[] => [...(input.history ?? []), { role: 'user', content: userText }];

  if (mode === 'rag') return prepareRag(input, promptName, instructions, withHistory);

  if (mode === 'full_context') {
    const documents = loadFullDocuments(input);
    const budget = input.config.retrieval.contextBudgetChars * FULL_CONTEXT_BUDGET_FACTOR;
    const chars = documents.reduce((sum, d) => sum + d.markdown.length, 0);
    if (chars > budget) throw new ContextTooLargeError(chars, budget);
    // Com mais de um documento, as âncoras ganham prefixo por documento (sec-d2-15): "sec-15" existiria em todos.
    const multi = documents.length > 1;
    const anchorOf = (index: number, anchor: string) => (multi ? anchor.replace(/^sec-/, `sec-d${index + 1}-`) : anchor);
    const sections: SectionWithDocument[] = documents.flatMap((d, i) =>
      d.sections.map((s) => ({ ...s, anchor: anchorOf(i, s.anchor), documentId: d.summary.id, documentTitle: d.summary.title, docType: d.summary.docType, markdown: d.markdown })),
    );
    const byAnchor = new Map(sections.map((s) => [s.anchor, s]));
    const prompted = documents.map((d, i) => (multi ? { ...d, markdown: d.markdown.replace(/\{#sec-/g, `{#sec-d${i + 1}-`) } : d));
    return {
      mode,
      promptName,
      instructions,
      messages: withHistory(fullContextUserMessage(prompted, input.question)),
      fitsInWindow: true,
      canRepair: sections.length > 0,
      labelKind: 'section',
      validate: (text) => validateSectionCitations(text, sections),
      sourceText: (label) => {
        const section = byAnchor.get(label);
        return section ? sectionText(section) : undefined;
      },
      contextText: () => documents.map((d) => d.markdown).join('\n'),
      warnings: [],
    };
  }

  // closed_book: só a pergunta; qualquer rótulo que o modelo invente é removido (contexto vazio).
  return {
    mode,
    promptName,
    instructions,
    messages: withHistory(input.question),
    canRepair: false,
    labelKind: 'chunk',
    validate: (text) => validateCitations(text, []),
    sourceText: () => undefined,
    warnings: [],
  };
}

/** Contexto do RAG: lista de documentos + chunks rotulados + pergunta. */
export function ragUserMessage(context: StoredChunk[], question: string, weak = false, search: { extraSearch?: boolean; searched?: string[] } = {}): string {
  if (context.length === 0) {
    return `Nenhum trecho relevante foi encontrado nos documentos selecionados.\n\nPERGUNTA: ${question}`;
  }
  const searched = search.searched ?? [];
  let extra = '';
  if (search.extraSearch && searched.length < MAX_EXTRA_SEARCH_ROUNDS) {
    extra = '\n\nBUSCA EXTRA: se os trechos acima NÃO bastarem para responder com segurança (falta o item certo, um valor ou uma condição), NÃO responda ainda: escreva somente linhas no formato <buscar>termos ou pergunta específica</buscar> (no máximo 3), com as palavras que você procuraria no edital (nome do item, seção, anexo, termo técnico). Os trechos encontrados serão acrescentados e então você responde. Se os trechos bastam, responda normalmente.';
  }
  if (searched.length > 0) {
    extra += `\n\nBUSCA EXTRA já realizada por: ${searched.map((s) => `"${s}"`).join(', ')} — os trechos encontrados foram acrescentados acima.${searched.length >= MAX_EXTRA_SEARCH_ROUNDS ? ' Não há mais buscas: responda agora com o que há (ou diga que não consta).' : ''}`;
  }
  const firstByDoc = new Map<string, StoredChunk>();
  for (const chunk of context) if (!firstByDoc.has(chunk.documentId)) firstByDoc.set(chunk.documentId, chunk);
  const docLines = [...firstByDoc.values()].map((c) => {
    const notes = [`tipo: ${c.docType}${c.docType === 'apoio' ? ' — documento do usuário, não é norma' : ''}`];
    if (c.versionLabel) notes.push(`versão: ${c.versionLabel}`);
    if (c.precedence > 1) notes.push('retificação: prevalece sobre o texto original');
    return `- ${c.documentId} → "${c.documentTitle}" (${notes.join('; ')})`;
  });
  const hint = weak
    ? '\n\nAVISO: nenhum trecho contém os termos exatos da pergunta; os trechos abaixo vieram por similaridade e podem não responder. Na dúvida, diga que não consta ou peça mais detalhes.'
    : '';
  return `DOCUMENTOS:\n${docLines.join('\n')}${hint}\n\nTRECHOS:\n${context.map(chunkTag).join('\n\n')}${extra}\n\nPERGUNTA: ${question}`;
}

function chunkTag(c: StoredChunk): string {
  const attrs = [
    `id="${c.label}"`,
    `doc="${attr(c.documentTitle)}"`,
    `tipo="${c.docType}"`,
    `secao="${attr(c.itemNumber ?? c.sectionPath)}"`,
  ];
  if (c.itemNumber && c.sectionPath) attrs.push(`caminho="${attr(c.sectionPath)}"`);
  attrs.push(`pagina="${c.pageStart === c.pageEnd ? c.pageStart : `${c.pageStart}-${c.pageEnd}`}"`);
  attrs.push(`versao="${attr(c.versionLabel ?? 'original')}"`);
  if (c.precedence > 1) attrs.push('retifica="true"');
  return `<chunk ${attrs.join(' ')}>\n${c.text.trim()}\n</chunk>`;
}

function attr(value: string): string {
  return value.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
}

type FullDocument = { summary: DocumentSummary; markdown: string; sections: CanonicalSection[] };

/** Documentos do escopo (ready, vigentes), retificações primeiro, com canonical.md e sections.json lidos do storage. */
/** Texto integral dos documentos do escopo (para o gate saber se um valor consta do documento, ainda que fora do trecho citado). */
export function documentsText(input: Pick<AnswerInput, 'db' | 'workspaceId' | 'documentIds'>): string {
  return listRetrievableDocuments(input.db, input.workspaceId, input.documentIds)
    .map((d) => storage.readText(storage.canonicalMdPath(d.id)) ?? '')
    .join('\n');
}

/** Prepared mínimo para reaplicar validação e gate a uma resposta RAG já gerada: os trechos citados vêm do banco pelos rótulos. */
export function preparedForRegrade(input: Pick<AnswerInput, 'db' | 'workspaceId' | 'documentIds'>, text: string): Prepared {
  const context = getChunksByLabels(input.db, input.workspaceId, extractLabels(text));
  const byLabel = new Map(context.map((c) => [c.label, c]));
  return {
    mode: 'rag',
    promptName: '',
    instructions: '',
    messages: [],
    canRepair: false,
    labelKind: 'chunk',
    validate: (t) => validateCitations(t, context),
    sourceText: (label) => {
      const chunk = byLabel.get(label);
      return chunk ? `${chunk.itemNumber ?? ''} ${chunk.sectionPath}\n${chunk.text}` : undefined;
    },
    contextText: () => documentsText(input),
    warnings: [],
  };
}

function loadFullDocuments(input: AnswerInput): FullDocument[] {
  const summaries = listRetrievableDocuments(input.db, input.workspaceId, input.documentIds)
    .slice()
    .sort((a, b) => b.precedence - a.precedence || a.createdAt.localeCompare(b.createdAt));
  if (summaries.length === 0) throw new NoDocumentsError();
  return summaries.map((summary) => {
    const markdown = storage.readText(storage.canonicalMdPath(summary.id));
    if (markdown === null) throw new Error(`canonical.md ausente para o documento "${summary.title}" (${summary.id}); reprocesse o documento.`);
    return { summary, markdown, sections: parseSections(storage.readText(storage.sectionsJsonPath(summary.id))) };
  });
}

function parseSections(json: string | null): CanonicalSection[] {
  if (!json) return [];
  const parsed: unknown = JSON.parse(json);
  const list = Array.isArray(parsed) ? parsed : (parsed as { sections?: unknown }).sections;
  if (!Array.isArray(list)) return [];
  return list.filter((s): s is CanonicalSection => typeof s === 'object' && s !== null && typeof (s as CanonicalSection).anchor === 'string');
}

function fullContextUserMessage(documents: FullDocument[], question: string): string {
  const blocks = documents.map(({ summary, markdown }) => {
    const notes = [`tipo: ${summary.docType}${summary.docType === 'apoio' ? ' — documento do usuário, não é norma' : ''}`];
    if (summary.versionLabel) notes.push(`versão: ${summary.versionLabel}`);
    if (summary.precedence > 1) notes.push('retificação: prevalece sobre o texto original');
    return `=== DOCUMENTO: ${summary.title} (${notes.join('; ')}) ===\n${markdown.trim()}`;
  });
  return `${blocks.join('\n\n')}\n\nPERGUNTA: ${question}`;
}

/* ---------- avaliação (validação + gate) ---------- */

type Evaluated = {
  raw: string;
  validation: CitationValidation;
  outcome: GroundingOutcome;
};

function evaluate(prepared: Prepared, config: PipelineConfig, text: string): Evaluated {
  const validation = prepared.validate(text);
  const policy = prepared.mode === 'closed_book' ? 'off' : config.generation.grounding;
  const contextValues = prepared.contextText ? sourceValues(prepared.contextText()) : undefined;
  const outcome = applyGrounding({ text: validation.text, citations: validation.citations, sourceText: prepared.sourceText, contextValues, policy });
  return { raw: validation.text, validation, outcome };
}

/** Reaplica validação de citações e gate a um texto já gerado (repontuação de execuções antigas, sem chamar o modelo). */
export function regrade(prepared: Prepared, config: PipelineConfig, text: string): { validation: CitationValidation; outcome: GroundingOutcome } {
  const { validation, outcome } = evaluate(prepared, config, text);
  return { validation, outcome };
}

function needsRepair(prepared: Prepared, e: Evaluated): boolean {
  if (!prepared.canRepair) return false;
  if (e.outcome.report.issues.length > 0) return true;
  return !e.validation.hasAnyCitation && !ABSTENTION_RE.test(e.raw) && e.outcome.status !== 'clarification';
}

/** O reparo só substitui a primeira resposta se reduziu os problemas (ou trouxe a primeira citação válida). */
function improved(before: Evaluated, after: Evaluated): boolean {
  if (!before.validation.hasAnyCitation && after.validation.hasAnyCitation) return true;
  const a = after.outcome.report;
  const b = before.outcome.report;
  return a.issues.length < b.issues.length || (a.issues.length === b.issues.length && a.cited > b.cited);
}

function repairMessages(prepared: Prepared, firstAnswer: string, report: GroundingReport): ModelMessage[] {
  return [
    ...prepared.messages,
    { role: 'assistant', content: firstAnswer.trim() || '(resposta vazia)' },
    { role: 'user', content: repairInstruction(report, prepared.labelKind) },
  ];
}

function collectWarnings(prepared: Prepared, e: Evaluated, fallbackFrom: string | undefined): AnswerWarning[] {
  const warnings: AnswerWarning[] = [...prepared.warnings];
  const { validation, outcome } = e;
  if (validation.invalidLabels.length > 0) {
    warnings.push({ code: 'invalid_labels', labels: validation.invalidLabels, message: 'A resposta citou rótulos inexistentes; eles foram removidos.' });
  }
  if (outcome.report.policy === 'strict' && outcome.report.removed > 0) {
    const n = outcome.report.removed;
    warnings.push({ code: 'blocks_removed', message: `${n} ${n === 1 ? 'trecho da resposta foi omitido' : 'trechos da resposta foram omitidos'} por não ter referência nos documentos.` });
  } else if (outcome.report.policy === 'warn' && outcome.report.issues.some((i) => i.kind === 'uncited')) {
    warnings.push({ code: 'no_citation', message: 'Parte da resposta não tem trecho localizado nos documentos.' });
  }
  if (outcome.report.unsupportedValues.length > 0 && outcome.report.policy !== 'off') {
    warnings.push({ code: 'unsupported_values', labels: outcome.report.unsupportedValues, message: 'Valores da resposta não foram encontrados nos trechos citados.' });
  }
  if (fallbackFrom) warnings.push({ code: 'fallback_provider', message: `O provedor principal (${fallbackFrom}) falhou; a resposta veio do provedor reserva.` });
  return warnings;
}

/* ---------- geração ---------- */

/** Claude 5 rejeita `temperature` (API e CLI); nos demais provedores usamos 0 (reprodutibilidade dos experimentos). */
function callSettings(llm: LlmConfig): { temperature?: number; abortSignal: AbortSignal } {
  return { ...(llm.kind === 'anthropic' || llm.kind === 'claude-code' ? {} : { temperature: 0 }), abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS) };
}

function addUsage(acc: Usage, usage: LanguageModelUsage | undefined): void {
  if (!usage) return;
  const add = (key: keyof Usage, value: number | undefined) => {
    if (value === undefined) return;
    acc[key] = (acc[key] ?? 0) + value;
  };
  add('inputTokens', usage.inputTokens);
  add('outputTokens', usage.outputTokens);
  add('cacheReadTokens', usage.inputTokenDetails?.cacheReadTokens);
  add('cacheWriteTokens', usage.inputTokenDetails?.cacheWriteTokens);
}

/** Falhas em que vale tentar o provedor reserva: limite de uso, indisponibilidade, timeout, rede. */
export function isFallbackWorthy(err: unknown): boolean {
  if (RetryError.isInstance(err)) return isFallbackWorthy(err.lastError);
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 0;
    return err.isRetryable || status === 429 || status === 408 || status >= 500;
  }
  if (err instanceof Error) return err.name === 'TimeoutError' || err.name === 'AbortError' || /fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(err.message);
  return false;
}

type Generation = {
  final: Evaluated;
  /** Prepared final (o contexto pode ter crescido com a busca extra). */
  prepared: Prepared;
  repaired: boolean;
  repairIssues: GroundingIssue[];
  generationMs: number;
  repairMs?: number;
  searchMs?: number;
  overheadMs: number;
  extraSearches: string[];
  usage: Usage;
  llm: LlmConfig;
  fallbackFrom?: string;
  /** Texto que o cliente já viu no stream (para decidir se precisa reenviar). */
  streamedText: string;
};

type FirstCall = (model: LanguageModel, llm: LlmConfig, prepared: Prepared) => Promise<{ text: string; usage: LanguageModelUsage | undefined; overheadMs?: number }>;

/**
 * Negativa escorada no material ("não consta nos documentos", "não há menção nos trechos fornecidos", "não localizei no
 * edital") — é o que merece cobrança de busca. Negativa factual sem essa âncora ("não há faturamento mínimo no Arranjo
 * Simples") é resposta, não desistência, e não entra aqui. `ABSTENTION_RE` continua sendo o que conta como abstenção na
 * pontuação; este gatilho é só para decidir se vale insistir.
 */
const SEM_RESPOSTA_RE =
  /n[ãa]o (?:consta|h[áa]|foi poss[íi]vel|encontrei|localizei|identifiquei|est[áa]|aparece|menciona)[^.]{0,80}?(?:nos? (?:documentos?|trechos?|itens?|anexos?)|no edital|no material|selecionados?|fornecidos?|dispon[íi]ve(?:l|is))/i;

const ASK_BEFORE_ABSTAIN =
  'Você respondeu que algo "não consta" sem ter pedido busca extra. Antes de aceitar isso, escreva SOMENTE linhas <buscar>termos</buscar> (no máximo 3) com as palavras que o edital usaria para o que faltou — nome do item, seção, anexo ou o termo jurídico/administrativo equivalente (ex.: exigência de habilitação, comprovação, registro). Se realmente não houver o que buscar, responda apenas: NADA.';

/**
 * Modo think: abstenção (total ou parcial) sem nenhuma busca extra é a falha de recuperação típica — o item existe e o modelo
 * desistiu. Antes de aceitar, pede os termos que ele procuraria; sem termos, a abstenção fica como está.
 */
async function askSearchesBeforeAbstain(model: LanguageModel, llm: LlmConfig, question: string, answer: string): Promise<{ queries: string[]; usage: LanguageModelUsage | undefined; overheadMs: number }> {
  // Sem o contexto: para escolher os termos bastam a pergunta e a própria resposta, que já diz o que faltou. Reenviar os
  // trechos aqui custava ~20 mil tokens de entrada por pergunta cobrada, mais que o documento inteiro.
  const messages: ModelMessage[] = [
    { role: 'user', content: `Pergunta do usuário: ${question}` },
    { role: 'assistant', content: answer },
    { role: 'user', content: ASK_BEFORE_ABSTAIN },
  ];
  const r = await generateText({ model, messages, ...callSettings(llm) });
  return { queries: parseSearchRequests(r.text, false), usage: r.usage, overheadMs: cliOverheadMs(r.finalStep.providerMetadata) };
}

/** Etapas visíveis ao usuário durante a resposta (o stream escreve como data part). */
export type AnswerStage = { stage: 'generation' | 'search' | 'repair'; queries?: string[] };
type GenerationEvents = { onStage?: (stage: AnswerStage) => void; onContext?: (prepared: Prepared) => void };

/** Primeira geração (com fallback de provedor), busca extra pedida pelo modelo, avaliação, reparos e avaliação final. */
type SearchRounds = { prepared: Prepared; text: string; extraSearches: string[]; searchMs: number; overheadMs: number };

/**
 * Busca extra (modo think): o modelo pediu trechos em vez de responder — busca, acrescenta ao contexto e gera de novo (até 2
 * rodadas). Abstenção sem nenhuma busca é cobrada antes de ser aceita.
 */
async function extraSearchRounds(input: AnswerInput, initial: Prepared, firstText: string, llm: LlmConfig, first: FirstCall, events: GenerationEvents, usage: Usage): Promise<SearchRounds> {
  const out: SearchRounds = { prepared: initial, text: firstText, extraSearches: [], searchMs: 0, overheadMs: 0 };
  if (initial.mode !== 'rag' || !input.config.generation.extraSearch) return out;
  const prompt: RagPromptParts = { promptName: initial.promptName, instructions: initial.instructions, withHistory: (userText) => [...(input.history ?? []), { role: 'user', content: userText }] };
  for (let round = 0; round < MAX_EXTRA_SEARCH_ROUNDS; round++) {
    const tSearch = performance.now();
    let queries = parseSearchRequests(out.text);
    if (queries.length === 0 && round === 0 && SEM_RESPOSTA_RE.test(out.text)) {
      events.onStage?.({ stage: 'search', queries: [] });
      const asked = await askSearchesBeforeAbstain(makeModel(llm), llm, input.question, out.text);
      addUsage(usage, asked.usage);
      out.overheadMs += asked.overheadMs;
      queries = asked.queries;
    }
    if (queries.length === 0) {
      if (round === 0) out.searchMs += Math.round(performance.now() - tSearch);
      break;
    }
    events.onStage?.({ stage: 'search', queries });
    out.extraSearches.push(...queries);
    out.prepared = await extendRagContext(input, out.prepared, queries, prompt);
    events.onContext?.(out.prepared);
    events.onStage?.({ stage: 'generation' });
    const r = await first(makeModel(llm), llm, out.prepared);
    addUsage(usage, r.usage);
    out.overheadMs += r.overheadMs ?? 0;
    out.text = r.text;
    out.searchMs += Math.round(performance.now() - tSearch);
  }
  return out;
}

async function generateAnswer(input: AnswerInput, initial: Prepared, first: FirstCall, events: GenerationEvents = {}): Promise<Generation> {
  const usage: Usage = {};
  let prepared = initial;
  addUsage(usage, prepared.extraUsage);
  if (prepared.immediate !== undefined) {
    return { final: evaluate(prepared, input.config, prepared.immediate), prepared, repaired: false, repairIssues: [], usage, llm: input.llm, streamedText: '', generationMs: 0, overheadMs: 0, extraSearches: [] };
  }

  let llm = input.llm;
  let fallbackFrom: string | undefined;
  let text: string;
  let overheadMs = 0;
  const tGen = performance.now();
  events.onStage?.({ stage: 'generation' });
  try {
    const r = await first(makeModel(llm), llm, prepared);
    addUsage(usage, r.usage);
    overheadMs += r.overheadMs ?? 0;
    text = r.text;
  } catch (err) {
    const fallback = input.llmFallback;
    if (!fallback || llm.kind === 'mock' || !isFallbackWorthy(err) || sameLlm(fallback, llm)) throw err;
    fallbackFrom = providerLabel(llm);
    llm = fallback;
    const r = await first(makeModel(llm), llm, prepared);
    addUsage(usage, r.usage);
    overheadMs += r.overheadMs ?? 0;
    text = r.text;
  }
  const generationMs = Math.round(performance.now() - tGen);

  const searched = await extraSearchRounds(input, prepared, text, llm, first, events, usage);
  prepared = searched.prepared;
  text = searched.text;
  overheadMs += searched.overheadMs;
  const { extraSearches, searchMs } = searched;
  const streamedText = text;

  let current = evaluate(prepared, input.config, text);
  let repaired = false;
  const repairIssues: GroundingIssue[] = [];
  const model = makeModel(llm);
  const tRepair = performance.now();
  for (let round = 0; round < input.config.generation.maxRepairs && needsRepair(prepared, current); round++) {
    repaired = true;
    events.onStage?.({ stage: 'repair' });
    repairIssues.push(...(current.outcome.report.issues.length > 0 ? current.outcome.report.issues : [{ kind: 'uncited' as const, text: current.raw.slice(0, 200) }]));
    const second = await generateText({ model, instructions: prepared.instructions, messages: repairMessages(prepared, current.raw, current.outcome.report), ...callSettings(llm) });
    addUsage(usage, second.usage);
    overheadMs += cliOverheadMs(second.finalStep.providerMetadata);
    const candidate = evaluate(prepared, input.config, second.text);
    if (!improved(current, candidate)) break;
    current = candidate;
  }
  return {
    final: current,
    prepared,
    repaired,
    repairIssues,
    usage,
    llm,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    streamedText,
    generationMs,
    ...(repaired ? { repairMs: Math.round(performance.now() - tRepair) } : {}),
    ...(extraSearches.length > 0 ? { searchMs } : {}),
    overheadMs,
    extraSearches,
  };
}

function sameLlm(a: LlmConfig, b: LlmConfig): boolean {
  return a.kind === b.kind && a.model === b.model && (a.baseURL ?? '') === (b.baseURL ?? '');
}

function buildResult(input: AnswerInput, g: Generation, fallbackStartedAt: number): AnswerResult {
  const { validation, outcome } = g.final;
  const prepared = g.prepared;
  const text = outcome.text;
  const startedAt = prepared.startedAt ?? fallbackStartedAt;
  const overheadMs = (prepared.timings?.overheadMs ?? 0) + g.overheadMs;
  const result: AnswerResult = {
    mode: prepared.mode,
    status: outcome.status,
    text,
    grounding: outcome.report,
    warnings: collectWarnings(prepared, g.final, g.fallbackFrom),
    citations: validation.citations,
    invalidLabels: validation.invalidLabels,
    repaired: g.repaired,
    ...(prepared.retrieval ? { retrieval: prepared.retrieval } : {}),
    ...(prepared.fitsInWindow !== undefined ? { fitsInWindow: prepared.fitsInWindow } : {}),
    provider: providerLabel(g.llm),
    model: g.llm.model,
    usage: g.usage,
    latencyMs: Math.round(performance.now() - startedAt),
    timings: {
      ...(prepared.timings?.expansionMs !== undefined ? { expansionMs: prepared.timings.expansionMs } : {}),
      ...(prepared.timings?.retrievalMs !== undefined ? { retrievalMs: prepared.timings.retrievalMs } : {}),
      generationMs: g.generationMs,
      ...(g.repairMs !== undefined ? { repairMs: g.repairMs } : {}),
      ...(g.searchMs !== undefined ? { searchMs: g.searchMs } : {}),
      ...(overheadMs > 0 ? { overheadMs } : {}),
      totalMs: Math.round(performance.now() - startedAt),
    },
    ...(g.extraSearches.length > 0 ? { extraSearches: g.extraSearches } : {}),
    configHash: configHash(input.config),
    promptVersion: prepared.promptName,
  };
  if (g.final.raw !== text) result.rawText = g.final.raw;
  if (g.repaired) result.repairIssues = g.repairIssues;
  if (g.fallbackFrom) result.fallbackFrom = g.fallbackFrom;
  return result;
}

export async function answerOnce(input: AnswerInput): Promise<AnswerResult> {
  const startedAt = performance.now();
  const prepared = await prepareAnswer(input);
  const generation = await generateAnswer(input, prepared, async (model, llm, p) => {
    const r = await generateText({ model, instructions: p.instructions, messages: p.messages, ...callSettings(llm) });
    return { text: r.text, usage: r.usage, overheadMs: cliOverheadMs(r.finalStep.providerMetadata) };
  });
  return buildResult(input, generation, startedAt);
}

/* ---------- streaming (useChat) ---------- */

export function answerStream(input: AnswerInput): { stream: ReadableStream<UIMessageChunk>; result: Promise<AnswerResult> } {
  const startedAt = performance.now();
  let resolveResult!: (value: AnswerResult) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<AnswerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // O erro também chega ao cliente como part `error`; evita "unhandled rejection" quando só o stream é consumido.
  result.catch(() => {});

  const stream = createUIMessageStream({
    onError: (err) => describeError(err, input.llm),
    execute: async ({ writer }) => {
      try {
        const prepared = await prepareAnswer(input);
        writer.write({ type: 'start' });
        if (prepared.retrieval) writer.write({ type: 'data-retrieval', data: retrievalSummary(prepared.retrieval) });

        let streamedSomething = false;
        const generation = await generateAnswer(
          input,
          prepared,
          async (model, llm, p) => {
            // Provedor reserva ou busca extra depois de um stream parcial: descarta o que já foi exibido.
            if (streamedSomething) writer.write({ type: 'reset-step' });
            streamedSomething = true;
            return streamStep(writer, llm, { model, instructions: p.instructions, messages: p.messages, ...callSettings(llm) });
          },
          {
            onStage: (stage) => writer.write({ type: 'data-stage', data: stage }),
            onContext: (p) => {
              if (p.retrieval) writer.write({ type: 'data-retrieval', data: retrievalSummary(p.retrieval) });
            },
          },
        );
        const answer = buildResult(input, generation, startedAt);

        // Texto final diferente do que foi transmitido (reparo, gate ou resposta imediata): substitui o passo exibido.
        if (answer.text !== generation.streamedText) {
          if (streamedSomething) writer.write({ type: 'reset-step' });
          writer.write({ type: 'text-start', id: 'final' });
          writer.write({ type: 'text-delta', id: 'final', delta: answer.text });
          writer.write({ type: 'text-end', id: 'final' });
        }
        for (const citation of answer.citations) writer.write({ type: 'data-citation', data: citation });
        for (const warning of answer.warnings) writer.write({ type: 'data-warning', data: warning });
        writer.write({ type: 'data-status', data: statusData(answer) });
        writer.write({ type: 'finish' });
        resolveResult(answer);
      } catch (err) {
        rejectResult(err);
        throw err;
      }
    },
  });

  return { stream, result };
}

export type StatusData = { status: AnswerResult['status']; grounding: GroundingReport; provider: string; model: string; repaired: boolean; fallbackFrom?: string; timings: AnswerTimings; extraSearches?: string[] };

/** Data part `status` (também persistida com a mensagem): desfecho, gate e provedor efetivo. */
export function statusData(answer: AnswerResult): StatusData {
  return {
    status: answer.status,
    grounding: answer.grounding,
    provider: answer.provider,
    model: answer.model,
    repaired: answer.repaired,
    ...(answer.fallbackFrom ? { fallbackFrom: answer.fallbackFrom } : {}),
    timings: answer.timings,
    ...(answer.extraSearches ? { extraSearches: answer.extraSearches } : {}),
  };
}

/** Encaminha o texto de um streamText ao writer (sem start/finish) e devolve texto e uso ao terminar. */
async function streamStep(
  writer: UIMessageStreamWriter,
  llm: LlmConfig,
  args: { model: LanguageModel; instructions: string; messages: ModelMessage[]; temperature?: number; abortSignal: AbortSignal },
): Promise<{ text: string; usage: LanguageModelUsage; overheadMs: number }> {
  let streamError: unknown;
  const streamed = streamText({
    ...args,
    onError: ({ error }) => {
      streamError = error;
    },
  });
  const uiStream = toUIMessageStream({ stream: streamed.stream, sendStart: false, sendFinish: false, onError: (err) => describeError(err, llm) });
  const reader = uiStream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Erros de provedor viram uma única part `error` (via createUIMessageStream) ao relançar abaixo.
    if (value.type !== 'error') writer.write(value);
  }
  if (streamError !== undefined) throw streamError instanceof Error ? streamError : new Error(typeof streamError === 'string' ? streamError : 'Falha no stream do provedor');
  return { text: await streamed.text, usage: await streamed.usage, overheadMs: cliOverheadMs((await streamed.finalStep).providerMetadata) };
}

function retrievalSummary(retrieval: RetrievalResult): Omit<RetrievalResult, 'context'> {
  const summary: Omit<RetrievalResult, 'context'> & { context?: unknown } = { ...retrieval };
  delete summary.context;
  return summary;
}
