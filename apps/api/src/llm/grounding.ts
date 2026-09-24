/**
 * Gate de fundamentação: cada bloco factual da resposta precisa de citação válida e os valores/datas escritos
 * precisam constar dos trechos citados. Em `strict`, o que não passa é omitido do texto final.
 */
import type { AnswerStatus, Citation, GroundingIssue, GroundingReport } from '@editais/shared';
import { ABSTENTION_RE, LABEL_RE, SECTION_RE, VALUE_RE, extractValues, normalizeValue, splitBlocks, stripLabels, type AnswerBlock } from '@editais/shared';

/** Orientação acrescentada quando o modelo só escreve a frase de abstenção. */
export const NOT_FOUND_HINT = 'Tente reformular com os termos usados no edital (nome do item, seção ou anexo) ou confira se o documento certo está no escopo.';

/** Mensagem exibida quando nada citável sobrou (política strict). */
export const UNSUPPORTED_FALLBACK =
  'Não encontrei nos documentos selecionados uma resposta com referência para essa pergunta. ' +
  'Tente reformular usando os termos do edital (nome do item, seção ou anexo) ou confira se o documento certo está no escopo.';

const MAX_ISSUE_CHARS = 200;

/** Conjunto de formas canônicas presentes num trecho-fonte (todas as leituras possíveis, para casar com o que o modelo escreveu). */
export function sourceValues(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(VALUE_RE)) {
    const v = normalizeValue(m[0]);
    if (v) set.add(v);
  }
  // números soltos dentro de datas/itens/valores (ex.: "2026" em 07/04/2026, "6.5" em 6.5.5, "1500" em R$ 1.500,00)
  for (const m of text.matchAll(/\d+/g)) set.add(m[0]);
  for (const m of text.matchAll(/\d+(?:\.\d+)+/g)) set.add(m[0]);
  for (const m of text.matchAll(/\d{1,3}(?:\.\d{3})+/g)) set.add(m[0].replace(/\./g, ''));
  for (const m of text.matchAll(/R\$\s?\d[\d.]*(?:,\d+)?/gi)) {
    const v = normalizeValue(m[0]);
    if (v) set.add(v.replace(/^R\$/, ''));
  }
  return set;
}

/* ---------- avaliação ---------- */

export type GroundingInput = {
  /** Texto já validado (só rótulos válidos, normalizados). */
  text: string;
  citations: Citation[];
  /** Texto-fonte de um rótulo válido (chunk ou seção). */
  sourceText: (label: string) => string | undefined;
  /** Valores de TODO o contexto enviado ao modelo (todos os trechos / documento inteiro), para separar citação no item errado de valor inventado. */
  contextValues?: Set<string>;
  policy: GroundingReport['policy'];
};

export type GroundingOutcome = {
  text: string;
  report: GroundingReport;
  status: AnswerStatus;
  /** Blocos que ficaram fora do texto final (para o reparo e para o rawText). */
  removedBlocks: AnswerBlock[];
};

type CitedValues = { byLabel: Map<string, Set<string>>; all: Set<string> };

/** Valores dos trechos-fonte por rótulo e a união de todos os rótulos válidos da resposta. */
function citedValues(labels: Iterable<string>, sourceText: GroundingInput['sourceText']): CitedValues {
  const byLabel = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const label of labels) {
    const values = sourceValues(sourceText(label) ?? '');
    byLabel.set(label, values);
    for (const v of values) all.add(v);
  }
  return { byLabel, all };
}

/** Número de item que é o próprio, o pai ou um filho de algum item citado ("item 5.6" num bloco que cita 5.6.1). */
function isRelatedItem(value: string, citedItems: string[]): boolean {
  if (!/^\d+(\.\d+)*$/.test(value)) return false;
  return citedItems.some((n) => n === value || n.startsWith(`${value}.`) || value.startsWith(`${n}.`));
}

/**
 * Problema de um bloco factual: sem citação válida, ou com valores ausentes dos trechos citados (os do bloco e, depois, todos).
 * Referência ao número do item pai/filho do citado não conta como valor sem respaldo. Entre os que faltam, os que existem
 * em outro ponto do contexto ficam marcados como `misplaced` (citação no item errado), os demais não constam do contexto.
 */
function checkBlock(block: AnswerBlock, validLabels: Set<string>, cited: CitedValues, itemOf: Map<string, string>, contextValues?: Set<string>): GroundingIssue | null {
  const labels = block.labels.filter((l) => validLabels.has(l));
  if (labels.length === 0) return { kind: 'uncited', text: excerpt(block.text) };
  const own = new Set<string>();
  for (const label of labels) for (const v of cited.byLabel.get(label) ?? []) own.add(v);
  const citedItems = labels.map((l) => itemOf.get(l)).filter((n): n is string => Boolean(n));
  const missing = extractValues(block.text).filter((v) => !own.has(v) && !cited.all.has(v) && !isRelatedItem(v, citedItems));
  if (missing.length === 0) return null;
  const misplaced = contextValues ? missing.filter((v) => contextValues.has(v)) : [];
  return { kind: 'unsupported_value', text: excerpt(block.text), values: missing, ...(misplaced.length > 0 ? { misplaced } : {}) };
}

export function applyGrounding(input: GroundingInput): GroundingOutcome {
  const blocks = splitBlocks(input.text);
  const validLabels = new Set(input.citations.map((c) => c.label));
  const cited = citedValues(validLabels, input.sourceText);
  const itemOf = new Map(input.citations.filter((c) => c.itemNumber).map((c) => [c.label, c.itemNumber as string]));
  const strict = input.policy === 'strict';

  const issues: GroundingIssue[] = [];
  const removed = new Set<AnswerBlock>();
  let factualCount = 0;
  let citedCount = 0;
  for (const block of blocks.filter((b) => b.factual)) {
    factualCount++;
    const issue = checkBlock(block, validLabels, cited, itemOf, input.contextValues);
    if (issue?.kind !== 'uncited') citedCount++;
    if (!issue) continue;
    issues.push(issue);
    if (strict) removed.add(block);
  }
  // linha de citações cujos blocos saíram todos sai junto
  for (const b of blocks) if (b.citationLineFor && b.citationLineFor.every((t) => removed.has(t))) removed.add(b);

  const kept = strict ? blocks.filter((b) => !removed.has(b)) : blocks;
  let text = input.policy === 'off' ? input.text : joinBlocks(kept);
  const report: GroundingReport = {
    policy: input.policy,
    blocks: factualCount,
    cited: citedCount,
    removed: removed.size,
    unsupportedValues: [...new Set(issues.flatMap((i) => i.values ?? []))],
    misplacedValues: [...new Set(issues.flatMap((i) => i.misplaced ?? []))],
    issues: input.policy === 'off' ? [] : issues,
  };
  const hasCitations = kept.some((b) => b.labels.some((l) => validLabels.has(l)));
  const status = deriveStatus(text, hasCitations, removed.size > 0, input.policy !== 'off');
  if (status === 'unsupported' && strict) text = UNSUPPORTED_FALLBACK;
  if (status === 'not_found' && input.policy !== 'off' && stripLabels(text).trim().length < 60) text = `${text.trim()} ${NOT_FOUND_HINT}`;
  return { text, report, status, removedBlocks: [...removed] };
}

/** Sem gate (closed_book) não há citações a exigir: o que não é abstenção nem pergunta conta como respondido. */
function deriveStatus(text: string, hasCitations: boolean, removedAny: boolean, gated: boolean): AnswerStatus {
  if (hasCitations) return removedAny ? 'partial' : 'answered';
  if (ABSTENTION_RE.test(text)) return 'not_found';
  const lastLine = text.trim().split('\n').filter((l) => l.trim()).at(-1) ?? '';
  if (/\?\s*$/.test(lastLine)) return 'clarification';
  return gated ? 'unsupported' : 'answered';
}

/** Reconstrói o texto; blocos de parágrafo separados por linha em branco, itens/linhas de tabela contíguos. */
function joinBlocks(blocks: AnswerBlock[]): string {
  let out = '';
  let prev: AnswerBlock | null = null;
  for (const b of blocks) {
    if (prev) out += prev.kind === b.kind && (b.kind === 'list' || b.kind === 'table') ? '\n' : '\n\n';
    out += b.text;
    prev = b;
  }
  // parágrafos que sobraram só com conectivo vazio ("Detalhes:") não fazem sentido no fim
  return out.replace(/\n{3,}/g, '\n\n').replace(/(^|\n)[^\n]*:\s*$/, '').trim();
}

function excerpt(text: string): string {
  const plain = stripLabels(text).replace(/\s+/g, ' ').trim();
  return plain.length <= MAX_ISSUE_CHARS ? plain : `${plain.slice(0, MAX_ISSUE_CHARS - 1)}…`;
}

/** Instrução de reparo listando exatamente o que falhou (usada na segunda chamada ao modelo). */
export function repairInstruction(report: GroundingReport, labelKind: 'chunk' | 'section'): string {
  const label = labelKind === 'chunk' ? 'o rótulo [c_ID] do trecho' : 'a âncora [sec-ID] da seção';
  const lines: string[] = ['Sua resposta anterior tem problemas de referência. Reescreva a resposta COMPLETA corrigindo:'];
  const uncited = report.issues.filter((i) => i.kind === 'uncited');
  const values = report.issues.filter((i) => i.kind === 'unsupported_value');
  if (uncited.length > 0) {
    lines.push(`- Afirmações sem citação (acrescente ${label} correspondente após cada uma, ou remova o que não consta nos documentos):`);
    for (const i of uncited) lines.push(`  • "${i.text}"`);
  }
  if (values.length > 0) {
    lines.push('- Valores que NÃO aparecem nos trechos citados (copie o valor literal do trecho certo e cite-o, ou remova a afirmação):');
    for (const i of values) lines.push(`  • ${i.values?.join(', ')} em "${i.text}"`);
  }
  lines.push('Use somente rótulos existentes. Se a informação não constar, escreva exatamente: "Não consta nos documentos selecionados."');
  return lines.join('\n');
}

export { ABSTENTION_RE, LABEL_RE, SECTION_RE, splitBlocks, type AnswerBlock };
