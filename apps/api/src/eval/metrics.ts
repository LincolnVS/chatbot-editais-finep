/** Pontuação de um caso (pergunta × braço) e agregação por braço, geral e por workspace. Funções puras, sem I/O. */
import type { AnswerResult, EvalArmId, EvalArmSummary, EvalCase, EvalQuestion, EvalWorkspaceSummary } from '@editais/shared';
import { ABSTENTION_RE, EVAL_ARMS, containsValue } from '@editais/shared';

/**
 * A resposta é uma abstenção: o gate não deixou nada citável (`not_found`/`unsupported`) ou a frase de abstenção
 * ABRE a resposta. Uma ressalva no fim ("o restante não consta nos documentos selecionados") faz parte de uma
 * resposta parcial — a regra 5/7 do prompt v3 pede exatamente isso — e não conta como abstenção.
 */
export function isAbstention(status: EvalCase['status'], text: string): boolean {
  if (status === 'not_found' || status === 'unsupported') return true;
  const firstLine = text.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const firstSentence = /^[^.!?]*[.!?]?/.exec(firstLine)?.[0] ?? firstLine;
  return ABSTENTION_RE.test(firstSentence);
}

/**
 * Pergunta sem resposta no corpus: correta se abstém. Pergunta respondível com valores esperados: correta quando todos
 * aparecem no texto final com alguma citação — mesmo que a resposta abra com a frase de abstenção ("não consta
 * 'pontuação adicional' com esse nome; o que há é o indicador Regionalização, 0 ou 1 [c_x]"): o modelo achou a
 * informação, e a frase é ressalva de terminologia. Sem valores esperados, precisa ter respondido de fato.
 */
function isCorrect(q: EvalQuestion, status: EvalCase['status'], abstained: boolean, valuesFound: number, citations: number): boolean {
  if (!q.answerable) return abstained;
  if (status === 'clarification' || status === 'error') return false;
  if (q.expectedValues.length === 0) return !abstained;
  return valuesFound === q.expectedValues.length && (!abstained || citations > 0);
}

/** `item` cobre `expected`: igual, subitem (8.1 cobre 8.1.2) ou pai (8 cobre 8.1). */
export function itemCovers(item: string | undefined, expected: string): boolean {
  if (!item) return false;
  return item === expected || item.startsWith(`${expected}.`) || expected.startsWith(`${item}.`);
}

type Locatable = { itemNumber?: string; sectionPath: string; text?: string; documentTitle?: string };

/** Com `expectedDocument`, o trecho precisa ser do documento certo (num corpus, o item "4.1" existe em todos os editais). */
export function inExpectedDocument(chunk: Locatable, expectedDocument: string | undefined): boolean {
  if (!expectedDocument) return true;
  const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return fold(chunk.documentTitle ?? '').includes(fold(expectedDocument));
}

/**
 * O trecho cobre o item esperado: pelo número do item (igual, filho ou pai — o chunk-pai traz a seção inteira),
 * pelo caminho de seção (o chunk está dentro do item esperado) ou por conter a cláusula "12.5. …" no texto.
 */
export function coversItem(chunk: Locatable, expected: string): boolean {
  if (itemCovers(chunk.itemNumber, expected)) return true;
  // O caminho gravado usa " › " (ver `sectionPath` no parsed-document); " > " fica por compatibilidade com fixtures antigas.
  const inside = chunk.sectionPath.split(/ [›>] /).some((p) => {
    const n = /^(\d+(?:\.\d+)*)/.exec(p)?.[1];
    return n !== undefined && (n === expected || n.startsWith(`${expected}.`));
  });
  if (inside) return true;
  if (!chunk.text) return false;
  return new RegExp(String.raw`(?:^|\s)${expected.replaceAll('.', String.raw`\.`)}\.\s`, 'm').test(chunk.text);
}

export type CaseTarget = { arm: EvalArmId; workspaceId: string; workspaceName: string };

type CaseHead = Pick<EvalCase, 'questionId' | 'arm' | 'mode' | 'workspaceId' | 'workspaceName' | 'question' | 'expectedItem' | 'expectedValues' | 'answerable' | 'topic'>;

/** Campos copiados da pergunta e do alvo para o caso (item/tema só quando existem). */
function caseHead(q: EvalQuestion, target: CaseTarget): CaseHead {
  return {
    questionId: q.id,
    arm: target.arm,
    mode: EVAL_ARMS[target.arm].mode,
    workspaceId: target.workspaceId,
    workspaceName: target.workspaceName,
    question: q.question,
    ...(q.expectedItem ? { expectedItem: q.expectedItem } : {}),
    expectedValues: q.expectedValues,
    answerable: q.answerable,
    ...(q.topic ? { topic: q.topic } : {}),
  };
}

function countValues(text: string, expected: string[]): number {
  return expected.filter((v) => containsValue(text, v)).length;
}

export function scoreCase(q: EvalQuestion, target: CaseTarget, result: AnswerResult): EvalCase {
  const mode = EVAL_ARMS[target.arm].mode;
  const raw = result.rawText ?? result.text;
  const valuesFound = countValues(result.text, q.expectedValues);
  const valuesFoundRaw = countValues(raw, q.expectedValues);
  const abstained = isAbstention(result.status, result.text);
  const gated = result.grounding.policy !== 'off';
  const correct = isCorrect(q, result.status, abstained, valuesFound, result.citations.length);
  const context = result.retrieval?.context ?? [];
  const expectedItem = q.expectedItem;
  const applicable = mode !== 'closed_book' && expectedItem !== undefined;
  const retrievalHit = applicable ? mode === 'full_context' || context.some((c) => coversItem(c, expectedItem) && inExpectedDocument(c, q.expectedDocument)) : null;
  // Em RAG a citação resolve ao chunk do contexto (texto completo); em full_context só há item/seção da citação.
  const citedExpected = applicable ? result.citations.some((c) => { const k = context.find((x) => x.label === c.label) ?? c; return coversItem(k, expectedItem) && inExpectedDocument(k, q.expectedDocument); }) : null;
  return {
    ...caseHead(q, target),
    status: result.status,
    text: result.text,
    ...(result.rawText ? { rawText: result.rawText } : {}),
    citations: result.citations.length,
    invalidLabels: result.invalidLabels.length,
    retrievalHit,
    citedExpected,
    valuesFound,
    valuesFoundRaw,
    valuesExpected: q.expectedValues.length,
    abstained,
    correct,
    blocks: result.grounding.blocks,
    cited: result.grounding.cited,
    removed: result.grounding.removed,
    unsupportedValues: result.grounding.unsupportedValues.length,
    ...(result.grounding.misplacedValues ? { misplacedValues: result.grounding.misplacedValues.length } : {}),
    grounded: gated ? result.grounding.issues.length === 0 : null,
    gate: result.grounding.policy,
    ...(result.extraSearches?.length ? { searches: result.extraSearches } : {}),
    ...(result.grounding.issues.length > 0 ? { issues: result.grounding.issues } : {}),
    repaired: result.repaired,
    ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
    latencyMs: result.latencyMs,
    ...(result.timings.overheadMs ? { overheadMs: result.timings.overheadMs } : {}),
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  };
}

/** Repontua um caso já gravado (texto e citações não mudam) com o pontuador atual — usado quando uma regra de valor é corrigida. */
/** Subida do CLI medida em 16/09 (Sonnet e Haiku): ≈ 1,6 s por chamada, constante — vale como estimativa para execuções anteriores à medição. */
const CLI_OVERHEAD_PER_CALL_MS = 1600;

/** Execução antiga pelo CLI do Claude Code sem a subida medida: estima pelo número de chamadas ao modelo (geração, reparo, rodadas de busca extra). */
export function estimateOverhead(c: EvalCase, provider: string): Pick<EvalCase, 'overheadMs' | 'overheadEstimated'> {
  if (c.overheadMs !== undefined && !c.overheadEstimated) return {};
  if (!provider.startsWith('claude-code') || c.status === 'error') return {};
  const searchRounds = c.searches?.length ? Math.ceil(c.searches.length / 3) : 0;
  const calls = 1 + (c.repaired ? 1 : 0) + searchRounds;
  return { overheadMs: Math.min(c.latencyMs, calls * CLI_OVERHEAD_PER_CALL_MS), overheadEstimated: true };
}

export function rescoreCase(q: EvalQuestion, c: EvalCase): EvalCase {
  if (c.status === 'error') return c;
  const valuesFound = countValues(c.text, q.expectedValues);
  const abstained = isAbstention(c.status, c.text);
  return {
    ...c,
    valuesFound,
    valuesFoundRaw: countValues(c.rawText ?? c.text, q.expectedValues),
    valuesExpected: q.expectedValues.length,
    abstained,
    correct: isCorrect(q, c.status, abstained, valuesFound, c.citations),
  };
}

/** Caso com falha de chamada: zera as contagens e conta como incorreto. */
export function errorCase(q: EvalQuestion, target: CaseTarget, error: string, latencyMs: number): EvalCase {
  return {
    ...caseHead(q, target),
    status: 'error',
    text: '',
    error,
    citations: 0,
    invalidLabels: 0,
    retrievalHit: null,
    citedExpected: null,
    valuesFound: 0,
    valuesFoundRaw: 0,
    valuesExpected: q.expectedValues.length,
    abstained: false,
    correct: false,
    blocks: 0,
    cited: 0,
    removed: 0,
    unsupportedValues: 0,
    grounded: null,
    repaired: false,
    latencyMs,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function summarizeArm(arm: EvalArmId, all: EvalCase[]): EvalArmSummary {
  const mode = EVAL_ARMS[arm].mode;
  const cases = all.filter((c) => c.arm === arm);
  // Acerto: denominador é o braço inteiro — um caso com erro de chamada conta como falha (errorCase grava correct: false),
  // senão cada braço acabaria medido sobre uma população diferente. Custo (latência, tokens, reparo): só casos sem erro.
  const ok = cases.filter((c) => c.status !== 'error');
  const answerable = cases.filter((c) => c.answerable);
  const unanswerable = cases.filter((c) => !c.answerable);
  const withItem = answerable.filter((c) => c.retrievalHit !== null);
  const withCitedItem = answerable.filter((c) => c.citedExpected !== null);
  const gated = ok.filter((c) => c.grounded !== null);
  const withMisplaced = gated.filter((c) => c.misplacedValues !== undefined);
  const tokens = ok.map((c) => c.inputTokens + c.outputTokens);
  return {
    arm,
    mode,
    n: cases.length,
    errors: cases.length - ok.length,
    answerable: answerable.length,
    unanswerable: unanswerable.length,
    accuracy: rate(cases.filter((c) => c.correct).length, cases.length),
    answerAccuracy: rate(answerable.filter((c) => c.correct).length, answerable.length),
    abstentionAccuracy: rate(unanswerable.filter((c) => c.abstained).length, unanswerable.length),
    falseAbstention: rate(answerable.filter((c) => c.abstained).length, answerable.length),
    retrievalHitRate: mode === 'rag' ? rate(withItem.filter((c) => c.retrievalHit).length, withItem.length) : null,
    citedExpectedRate: rate(withCitedItem.filter((c) => c.citedExpected).length, withCitedItem.length),
    groundedRate: rate(gated.filter((c) => c.grounded).length, gated.length),
    // o que o modelo escreveu sem referência ou com citação inventada (em strict o gate ajusta; em warn vai assim)
    unreferencedRate: rate(gated.filter((c) => !c.grounded || c.invalidLabels > 0).length, gated.length),
    misplacedCitationRate: rate(withMisplaced.filter((c) => (c.misplacedValues ?? 0) > 0).length, withMisplaced.length),
    gateInterventionRate: rate(gated.filter((c) => c.removed > 0 || c.unsupportedValues > 0).length, gated.length),
    repairedRate: rate(ok.filter((c) => c.repaired).length, ok.length),
    meanLatencyMs: mean(ok.map((c) => c.latencyMs - (c.overheadMs ?? 0))),
    meanOverheadMs: mean(ok.map((c) => c.overheadMs ?? 0)),
    meanTokens: mean(tokens),
    totalTokens: tokens.reduce((a, b) => a + b, 0),
  };
}

/** Geral: um resumo por braço sobre todos os casos. */
export function summarize(arms: EvalArmId[], cases: EvalCase[]): EvalArmSummary[] {
  return arms.map((arm) => summarizeArm(arm, cases));
}

/** Por documento: um bloco por workspace (na ordem dada), cada um com o resumo por braço. */
export function summarizeByWorkspace(arms: EvalArmId[], workspaces: Array<{ id: string; name: string }>, cases: EvalCase[], questionsPerWorkspace: Map<string, number>): EvalWorkspaceSummary[] {
  return workspaces.map((w) => ({
    workspaceId: w.id,
    workspaceName: w.name,
    questions: questionsPerWorkspace.get(w.id) ?? 0,
    summary: summarize(arms, cases.filter((c) => c.workspaceId === w.id)),
  }));
}
