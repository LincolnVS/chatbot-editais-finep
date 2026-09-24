import type { BBox } from './parsed-document.ts';
import type { StoredChunk } from './chunk.ts';

/** Citação validada pelo servidor — uma por rótulo `[c_xxxxxx]` válido presente na resposta. */
export type Citation = {
  /** Ordinal de exibição (1, 2, 3…) na ordem de primeira aparição na resposta. */
  ordinal: number;
  label: string;
  chunkRowid: number;
  documentId: string;
  documentTitle: string;
  docType: 'edital' | 'apoio';
  versionLabel?: string;
  page: number;
  bboxes: BBox[];
  sectionPath: string;
  itemNumber?: string;
  /** Sentença do chunk com maior sobreposição com a afirmação que precede o rótulo (≤ 400 chars). */
  quote: string;
  /** O rótulo existe entre os chunks enviados no contexto. Rótulos inexistentes são removidos do texto e contados. */
  exists: true;
  /** O chunk resolve a um item/seção/anexo (não só a uma página) — métrica T2b. */
  hasSection: boolean;
};

export type RetrievalCandidate = {
  label: string;
  chunkRowid: number;
  bm25Rank?: number;
  denseRank?: number;
  rrfScore: number;
  selected: boolean;
  /** Preenchido quando a folha foi substituída pelo pai. */
  expandedTo?: string;
};

export type RetrievalResult = {
  /** Consulta enviada aos índices (em follow-ups curtos, a pergunta anterior é anexada — ver `condensedFrom`). */
  query: string;
  /** Pergunta original quando `query` foi condensada com o histórico. */
  condensedFrom?: string;
  /** Reformulações geradas pela expansão de consulta e buscadas junto com `query`. */
  variants?: string[];
  /** Títulos dos documentos que a pergunta nomeia (roteamento por documento) — vazio quando nenhum. */
  namedDocuments?: string[];
  configHash: string;
  candidates: RetrievalCandidate[];
  /** Chunks finais que entram no prompt, na ordem de envio. */
  context: StoredChunk[];
  contextChars: number;
  latencyMs: number;
};

export type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/**
 * Desfecho da resposta, derivado do texto validado:
 * answered = tudo com citação; partial = parte omitida por falta de referência; clarification = o modelo pediu detalhes;
 * not_found = "Não consta nos documentos selecionados"; unsupported = nada citável sobrou (texto substituído pela orientação padrão).
 */
export type AnswerStatus = 'answered' | 'partial' | 'clarification' | 'not_found' | 'unsupported';

export type GroundingIssue = {
  kind: 'uncited' | 'unsupported_value';
  /** Bloco da resposta (parágrafo/item de lista) afetado, truncado. */
  text: string;
  /** Valores do bloco que não constam dos trechos citados. */
  values?: string[];
  /** Subconjunto de `values` que existe em outro ponto do contexto (documento inteiro / trechos): a citação apontou o item errado. */
  misplaced?: string[];
};

/** Resultado do gate de fundamentação: cada bloco factual precisa de citação válida e os valores citados devem constar dos trechos. */
export type GroundingReport = {
  policy: 'strict' | 'warn' | 'off';
  /** Blocos factuais avaliados. */
  blocks: number;
  /** Blocos com pelo menos uma citação válida. */
  cited: number;
  /** Blocos omitidos do texto final (só em strict). */
  removed: number;
  /** Valores/datas da resposta que não aparecem nos trechos citados. */
  unsupportedValues: string[];
  /** Entre os sem respaldo, os que existem em outro ponto do contexto (citação no item errado). Ausente em execuções antigas. */
  misplacedValues?: string[];
  issues: GroundingIssue[];
};

/** Tempo de cada etapa da resposta, em ms (etapas ausentes não rodaram neste modo). */
export type AnswerTimings = {
  /** Expansão de consulta (chamada ao LLM para as variantes). */
  expansionMs?: number;
  /** Busca híbrida + montagem do contexto. */
  retrievalMs?: number;
  /** Primeira chamada ao modelo (geração da resposta). */
  generationMs: number;
  /** Segunda chamada pedindo referências/correções, quando houve. */
  repairMs?: number;
  /** Buscas adicionais pedidas pelo modelo (modo busca extra): busca + nova geração. */
  searchMs?: number;
  /** Subida do CLI do Claude Code somada em todas as chamadas (tempo fora da API); some com chave própria ou modelo local. */
  overheadMs?: number;
  totalMs: number;
};

export type AnswerResult = {
  mode: 'rag' | 'full_context' | 'closed_book';
  status: AnswerStatus;
  /** Texto final após validação (rótulos inexistentes removidos) e gate de fundamentação. */
  text: string;
  /** Texto antes do gate (o que o modelo escreveu, já com rótulos normalizados) — só quando difere de `text`. */
  rawText?: string;
  grounding: GroundingReport;
  /** Avisos exibidos ao usuário (mesmos códigos das data parts do stream). */
  warnings: AnswerWarning[];
  citations: Citation[];
  /** Rótulos citados que não existiam no contexto (contados para a métrica de citações inválidas). */
  invalidLabels: string[];
  /** true se foi necessária uma segunda chamada pedindo citações/correções. */
  repaired: boolean;
  /** Problemas da primeira resposta que motivaram o reparo (vazio quando não houve reparo). */
  repairIssues?: GroundingIssue[];
  /** Preenchido quando o provedor principal falhou e a resposta veio do provedor reserva. */
  fallbackFrom?: string;
  /** Buscas adicionais que o modelo pediu (modo busca extra), na ordem. */
  extraSearches?: string[];
  retrieval?: RetrievalResult;
  /** Só em `full_context`: o(s) documento(s) coube(ram) no orçamento sem truncamento. */
  fitsInWindow?: boolean;
  provider: string;
  model: string;
  usage: Usage;
  latencyMs: number;
  timings: AnswerTimings;
  configHash: string;
  promptVersion: string;
};

export type AnswerWarningCode = 'no_citation' | 'invalid_labels' | 'blocks_removed' | 'unsupported_values' | 'weak_retrieval' | 'fallback_provider' | 'expansion_failed';
export type AnswerWarning = { code: AnswerWarningCode; message: string; labels?: string[] };
