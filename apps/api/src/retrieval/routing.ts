/**
 * Roteamento por documento num workspace com vários editais.
 *  - Documento nomeado na pergunta ("no edital de Tecnologias Digitais, …"): seus trechos — e os do aviso que o rerratifica,
 *    ou do edital que ele rerratifica — ganham bônus na fusão, como os identificadores exatos.
 *  - Nenhum documento nomeado e mais de um edital principal no escopo (pergunta comparativa: "qual dos editais…"): cada
 *    edital principal garante uma cota mínima de trechos no top-k, para o modelo enxergar os três antes de comparar.
 * Com um único edital no workspace as duas regras não fazem nada.
 */
import type { DocumentSummary } from '@editais/shared';

/** Palavras de título que não identificam um edital (aparecem em todos ou são estruturais). */
const GENERIC = new Set(
  `edital editais anexo anexos aviso avisos lista documentos documento detalhamento linhas tematicas telas formulario proposta
   propostas apresentacao rerratificacao retificacao chamada publica selecao regulamento finep mib para com dos das
   2024 2025 2026 2027 ict icts`.split(/\s+/).filter(Boolean),
);

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function tokens(s: string): string[] {
  return fold(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
}

/** Tokens distintivos do título: não genéricos e (quando há mais de um documento) não presentes em todos os títulos. */
function distinctiveTokens(docs: DocumentSummary[]): Map<string, Set<string>> {
  const perDoc = new Map(docs.map((d) => [d.id, new Set(tokens(d.title).filter((t) => !GENERIC.has(t)))]));
  if (docs.length > 1) {
    const counts = new Map<string, number>();
    for (const set of perDoc.values()) for (const t of set) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const set of perDoc.values()) for (const t of [...set]) if (counts.get(t) === docs.length) set.delete(t);
  }
  return perDoc;
}

/**
 * Documentos que a pergunta nomeia: ≥ 2 tokens distintivos do título na pergunta, ou 1 token que só esse título tem.
 * Inclui o vínculo de rerratificação nos dois sentidos.
 */
export function namedDocuments(query: string, docs: DocumentSummary[]): Set<string> {
  const q = new Set(tokens(query));
  const distinct = distinctiveTokens(docs);
  const owners = new Map<string, number>();
  for (const set of distinct.values()) for (const t of set) owners.set(t, (owners.get(t) ?? 0) + 1);
  const named = new Set<string>();
  for (const d of docs) {
    const hits = [...(distinct.get(d.id) ?? [])].filter((t) => q.has(t));
    if (hits.length >= 2 || hits.some((t) => owners.get(t) === 1)) named.add(d.id);
  }
  addAmendmentLinks(named, docs);
  addSharedTitleLinks(named, docs, distinct, owners);
  return named;
}

/** Rerratificação nos dois sentidos: nomear o edital inclui o aviso, e vice-versa. */
function addAmendmentLinks(named: Set<string>, docs: DocumentSummary[]): void {
  for (const d of docs) {
    if (d.amendsDocumentId && named.has(d.amendsDocumentId)) named.add(d.id);
    if (d.amendsDocumentId && named.has(d.id)) named.add(d.amendsDocumentId);
  }
}

/** Anexo que compartilha um token distintivo raro (≤ 2 títulos) com um documento nomeado — "Anexo 1 … (Tec. Digitais)". */
function addSharedTitleLinks(named: Set<string>, docs: DocumentSummary[], distinct: Map<string, Set<string>>, owners: Map<string, number>): void {
  for (const n of [...named]) {
    const mine = distinct.get(n) ?? new Set<string>();
    for (const d of docs) {
      if (named.has(d.id)) continue;
      const shared = [...(distinct.get(d.id) ?? [])].some((t) => mine.has(t) && (owners.get(t) ?? 0) <= 2);
      if (shared) named.add(d.id);
    }
  }
}

/** Editais principais do escopo (a cota por documento só vale entre eles). */
export function principalDocuments(docs: DocumentSummary[]): DocumentSummary[] {
  return docs.filter((d) => d.docType === 'edital' && d.docKind === 'edital_principal');
}
