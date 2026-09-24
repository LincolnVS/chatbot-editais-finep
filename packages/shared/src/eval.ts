import { z } from 'zod';
import type { AnswerStatus, GroundingIssue } from './citation.ts';
import type { PipelineConfigPatch } from './pipeline-config.ts';

export const EVAL_MODES = ['rag', 'full_context', 'closed_book'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

/** Variante de arquitetura avaliada: modo de geração + ajustes sobre a configuração do workspace. */
export type EvalArm = {
  id: EvalArmId;
  label: string;
  /** Rótulo curto para cabeçalhos de tabela. */
  short: string;
  mode: EvalMode;
  description: string;
  patch: PipelineConfigPatch;
  /** Braço de controle: não é uma configuração válida do produto, só mede o comportamento do modelo. */
  control?: boolean;
  /** Precisa de modelo com janela grande (documento inteiro no contexto). */
  largeContext?: boolean;
};

export const EVAL_ARM_IDS = ['full_context', 'rag_dense', 'rag_bm25', 'rag_no_gate', 'rag_leaves', 'rag_expand', 'rag_hybrid', 'rag_search', 'rag_top4', 'closed_book'] as const;
export type EvalArmId = (typeof EVAL_ARM_IDS)[number];

/**
 * Braços na ordem da escada experimental: do baseline sem recuperação até a arquitetura do produto.
 * Só o último braço usa o gate de fundamentação; os demais ficam em `warn` (o gate observa, mas não altera a resposta).
 * A leitura é por PARES, e cada par difere em um componente só: vetorial vs híbrido e léxico vs híbrido isolam a fusão RRF;
 * híbrido vs só folhas isola a expansão folha→pai; híbrido vs híbrido + expansão de consulta isola a reformulação da pergunta;
 * híbrido + expansão vs produto isola o gate; documento inteiro vs híbrido isola a recuperação
 * (os dois em `warn`). Documento inteiro vs produto muda duas coisas — recuperação e gate — e serve como comparação de ponta a ponta, não de componente.
 */
export const EVAL_ARMS: Record<EvalArmId, EvalArm> = {
  full_context: {
    id: 'full_context',
    label: 'Documento inteiro',
    short: 'Doc. inteiro',
    mode: 'full_context',
    description: 'Edital completo no contexto do modelo, citando seções. Baseline sem recuperação: mede o que o RAG precisa superar.',
    patch: { generation: { grounding: 'warn', maxRepairs: 0 } },
    largeContext: true,
  },
  rag_dense: {
    id: 'rag_dense',
    label: 'RAG vetorial (padrão)',
    short: 'RAG vetorial',
    mode: 'rag',
    description: 'RAG clássico: só similaridade de cosseno entre embeddings (multilingual-e5), sem BM25 e sem gate. É a linha de base de RAG.',
    patch: { retrieval: { mode: 'dense', expandToParent: true, queryExpansion: 0, glossary: false, docGlossary: false, llmGlossary: false }, generation: { grounding: 'warn', maxRepairs: 0 } },
  },
  rag_bm25: {
    id: 'rag_bm25',
    label: 'RAG léxico (BM25)',
    short: 'RAG BM25',
    mode: 'rag',
    description: 'Só busca por termos (FTS5/BM25), sem embeddings e sem gate. Isola a contribuição da busca léxica.',
    patch: { retrieval: { mode: 'bm25', expandToParent: true, queryExpansion: 0, glossary: false, docGlossary: false, llmGlossary: false }, generation: { grounding: 'warn', maxRepairs: 0 } },
  },
  rag_leaves: {
    id: 'rag_leaves',
    label: 'RAG híbrido sem expansão ao pai',
    short: 'RAG só folhas',
    mode: 'rag',
    description: 'Igual ao híbrido sem gate, mas com os chunks-folha crus: a seção inteira nunca substitui a folha. Comparado ao híbrido, isola o efeito da expansão folha→pai.',
    patch: { retrieval: { mode: 'hybrid', expandToParent: false, queryExpansion: 0, glossary: false, docGlossary: false, llmGlossary: false }, generation: { grounding: 'warn', maxRepairs: 0 } },
  },
  rag_no_gate: {
    id: 'rag_no_gate',
    label: 'RAG híbrido sem gate',
    short: 'RAG híbrido',
    mode: 'rag',
    description: 'BM25 + vetorial fundidos por RRF, com expansão folha→pai, mas sem gate de fundamentação: o texto do modelo vai cru. Comparado aos braços vetorial e léxico, isola o efeito da fusão.',
    patch: { retrieval: { mode: 'hybrid', expandToParent: true, queryExpansion: 0, glossary: false, docGlossary: false, llmGlossary: false }, generation: { grounding: 'warn', maxRepairs: 0 } },
  },
  rag_expand: {
    id: 'rag_expand',
    label: 'RAG híbrido + expansão de consulta (modelo + glossário)',
    short: 'RAG + expansão',
    mode: 'rag',
    description: 'Híbrido sem gate, com a pergunta reescrita pelo modelo em 4 variantes no vocabulário de edital e expandida pelo glossário do domínio (variantes determinísticas) antes da busca; cada variante entra na fusão RRF. Comparado ao híbrido, isola o efeito da expansão de consulta.',
    patch: { retrieval: { mode: 'hybrid', expandToParent: true, queryExpansion: 4, glossary: false, docGlossary: true, llmGlossary: false }, generation: { grounding: 'warn', maxRepairs: 0 } },
  },
  rag_hybrid: {
    id: 'rag_hybrid',
    label: 'Configuração híbrida (RAG híbrido + expansão + gate)',
    short: 'Híbrida',
    mode: 'rag',
    description: 'A configuração do chat: híbrido com expansão folha→pai, expansão de consulta e gate de fundamentação strict com uma rodada de reparo. Último degrau da escada.',
    patch: { retrieval: { mode: 'hybrid', expandToParent: true, queryExpansion: 4, glossary: false, docGlossary: true, llmGlossary: false }, generation: { grounding: 'strict', maxRepairs: 1 } },
  },
  rag_search: {
    id: 'rag_search',
    label: 'Configuração com busca adicional (buscas pedidas pelo modelo)',
    short: 'Busca adicional',
    description: 'Configuração híbrida em que o modelo pode pedir buscas adicionais (<buscar>…</buscar>) antes de responder, até 2 rodadas. Mais lenta; mira os erros de recuperação.',
    mode: 'rag',
    patch: { retrieval: { mode: 'hybrid', expandToParent: true, queryExpansion: 4, glossary: false, docGlossary: true, llmGlossary: false }, generation: { grounding: 'strict', maxRepairs: 1, extraSearch: true } },
  },
  rag_top4: {
    id: 'rag_top4',
    label: 'RAG híbrido com contexto reduzido (top-4)',
    short: 'RAG top-4',
    mode: 'rag',
    description: 'Fora da escada: híbrido com metade dos trechos (top-k 4). Mede a sensibilidade ao tamanho do contexto.',
    patch: { retrieval: { mode: 'hybrid', topK: 4, queryExpansion: 0, glossary: false, docGlossary: false, llmGlossary: false }, generation: { grounding: 'warn', maxRepairs: 0 } },
  },
  closed_book: {
    id: 'closed_book',
    label: 'Sem documento (controle)',
    short: 'Sem doc.',
    mode: 'closed_book',
    description: 'Braço de controle: o modelo responde sem nenhum documento. Não é um modo válido do produto — mede quanto o modelo inventa ou se abstém sem fonte.',
    patch: {},
    control: true,
  },
};

/** Braços da escada experimental, na ordem em que aparecem nos resultados. */
export const DEFAULT_EVAL_ARMS: EvalArmId[] = ['full_context', 'rag_dense', 'rag_bm25', 'rag_no_gate', 'rag_leaves', 'rag_expand', 'rag_hybrid'];

/** Linha do padrão-ouro (CSV): pergunta, item esperado, valores que a resposta precisa conter e se há resposta no corpus. */
export type EvalQuestion = {
  id: string;
  /** Workspace (edital) da pergunta: id, código da chamada ou nome. Vazio = o workspace passado na execução. */
  workspace?: string;
  question: string;
  /** Item/seção do edital onde está a resposta (ex.: "8.1"); vazio quando não se aplica. */
  expectedItem?: string;
  /** Num workspace com vários editais: trecho do título do documento onde está a resposta (o item "4.1" existe em todos). */
  expectedDocument?: string;
  /** Valores literais (datas, R$, %, prazos) que uma resposta correta contém. */
  expectedValues: string[];
  /** false = a resposta não está nos documentos; o comportamento correto é abster-se. */
  answerable: boolean;
  /** Agrupamento livre (elegibilidade, prazos, valores…) para as tabelas por tema. */
  topic?: string;
  /** `direta` = resposta num item só; `composta` = resposta espalhada em vários itens/tabela. */
  nivel?: 'direta' | 'composta';
  /** Resposta de referência escrita pelo anotador (não usada na pontuação automática; base da revisão e de um futuro juiz). */
  expectedAnswer?: string;
};

/** Resultado de uma pergunta em um braço. */
export type EvalCase = {
  questionId: string;
  arm: EvalArmId;
  mode: EvalMode;
  workspaceId: string;
  workspaceName: string;
  question: string;
  expectedItem?: string;
  expectedValues: string[];
  answerable: boolean;
  topic?: string;
  status: AnswerStatus | 'error';
  /** Texto final (após gate); vazio em erro. */
  text: string;
  /** Texto cru do modelo quando o gate alterou algo. */
  rawText?: string;
  error?: string;
  citations: number;
  invalidLabels: number;
  /** O item esperado entrou no contexto do modelo (rag: chunks recuperados; full_context: sempre true; closed_book: null). */
  retrievalHit: boolean | null;
  /** Alguma citação aponta para o item esperado (null quando não há item esperado ou o modo não cita). */
  citedExpected: boolean | null;
  /** Valores esperados encontrados no texto final / no texto cru. */
  valuesFound: number;
  valuesFoundRaw: number;
  valuesExpected: number;
  abstained: boolean;
  /** Pergunta respondível: todos os valores esperados presentes (ou resposta dada, se não há valores). Sem resposta: abstenção. */
  correct: boolean;
  /** Gate: blocos factuais, blocos citados, blocos removidos, valores sem respaldo e problemas remanescentes. */
  blocks: number;
  cited: number;
  removed: number;
  unsupportedValues: number;
  /** Entre os valores sem respaldo, os que existem em outro ponto do contexto: citação no item errado (ausente em casos antigos). */
  misplacedValues?: number;
  /** O texto do modelo (após reparo) não tinha problema de fundamentação (null quando o gate está desligado — closed_book). */
  grounded: boolean | null;
  /** Política do gate que valeu para o caso (casos antigos não têm; deriva-se do braço). */
  gate?: 'strict' | 'warn' | 'off';
  /** Problemas de fundamentação encontrados no texto do modelo (trechos truncados), para o detalhe na tela. */
  issues?: GroundingIssue[];
  repaired: boolean;
  fallbackFrom?: string;
  /** Variantes da expansão de consulta usadas na busca (rag com `queryExpansion` > 0). */
  variants?: string[];
  /** Buscas adicionais pedidas pelo modelo (braço com busca extra). */
  searches?: string[];
  /** Tempo total da resposta (busca, geração, reparos), incluindo a subida do CLI quando o provedor é o Claude Code. */
  latencyMs: number;
  /** Subida do CLI do Claude Code dentro de `latencyMs` (um processo por chamada; não existe com chave própria ou modelo local). */
  overheadMs?: number;
  /** `overheadMs` estimado (execuções anteriores à medição: 1,6 s por chamada ao modelo). */
  overheadEstimated?: boolean;
  inputTokens: number;
  outputTokens: number;
};

export type GatePolicy = 'strict' | 'warn' | 'off';

/** Política do gate de um caso: a gravada no caso ou, em execuções antigas, a do braço (ou a imposta à execução). */
export function casePolicy(c: Pick<EvalCase, 'arm' | 'gate'>, runGrounding?: GatePolicy): GatePolicy {
  if (c.gate) return c.gate;
  const spec = EVAL_ARMS[c.arm];
  if (spec.mode === 'closed_book') return 'off';
  return spec.patch.generation?.grounding ?? runGrounding ?? 'strict';
}

/** Métricas agregadas de um braço (taxas em 0–1; null quando não há casos aplicáveis). */
export type EvalArmSummary = {
  arm: EvalArmId;
  mode: EvalMode;
  n: number;
  errors: number;
  answerable: number;
  unanswerable: number;
  /** Casos corretos / n. */
  accuracy: number | null;
  /** Respondíveis corretas / respondíveis. */
  answerAccuracy: number | null;
  /** Sem resposta com abstenção / sem resposta. */
  abstentionAccuracy: number | null;
  /** Respondíveis em que o modelo se absteve / respondíveis. */
  falseAbstention: number | null;
  /** Item esperado no contexto / respondíveis com item esperado (só rag). */
  retrievalHitRate: number | null;
  /** Alguma citação no item esperado / respondíveis com item esperado. */
  citedExpectedRate: number | null;
  /** Casos em que o texto do modelo não tinha problema de fundamentação / casos com gate. */
  groundedRate: number | null;
  /**
   * Casos em que o texto do modelo trazia informação sem referência (bloco sem citação, valor que não consta dos trechos
   * citados) ou citação inventada / casos com gate. Mesma conta em todos os braços: com gate strict nada disso chega ao
   * usuário (o gate ajusta a resposta); em warn é entregue como está.
   */
  unreferencedRate: number | null;
  /** Casos em que algum valor da resposta existe no contexto, mas não no item citado (nem no pai/filho) / casos com gate. Só casos que registram `misplacedValues`. */
  misplacedCitationRate: number | null;
  /** Casos em que o gate removeu algo ou achou valor sem respaldo / casos com gate. */
  gateInterventionRate: number | null;
  repairedRate: number | null;
  /** Latência média SEM a subida do CLI (o que o provedor/algoritmo realmente levou). */
  meanLatencyMs: number | null;
  /** Subida média do CLI descontada de `meanLatencyMs` (0 quando não há). */
  meanOverheadMs: number | null;
  meanTokens: number | null;
  totalTokens: number;
};

/** Métricas de um workspace (edital) da execução. */
export type EvalWorkspaceSummary = {
  workspaceId: string;
  workspaceName: string;
  questions: number;
  summary: EvalArmSummary[];
};

export type EvalRunStatus = 'running' | 'done' | 'error';

export type EvalRun = {
  id: string;
  label?: string;
  createdAt: string;
  finishedAt?: string;
  status: EvalRunStatus;
  error?: string;
  /** Workspaces (editais) cobertos pelas perguntas. */
  workspaces: Array<{ id: string; name: string }>;
  documentIds?: string[];
  questionsFile: string;
  questionCount: number;
  arms: EvalArmId[];
  llm: { provider: string; model: string };
  /** Política do gate imposta a todos os braços que não a definem (vazio = a de cada braço/workspace). */
  grounding?: 'strict' | 'warn' | 'off';
  pauseMs: number;
  promptVersion: string;
  progress: { done: number; total: number };
  /**
   * Expansão de consulta por pergunta × workspace (`<questionId>|<workspaceId>`), gerada uma vez e repartida entre os
   * braços — assim os braços comparados buscam com as mesmas variantes, e a retomada reaproveita as já geradas.
   */
  expansions?: Record<string, { variants: string[]; inputTokens: number; outputTokens: number }>;
  /** Geral (todas as perguntas). */
  summary: EvalArmSummary[];
  /** Por documento (workspace) do dataset. */
  byWorkspace: EvalWorkspaceSummary[];
  cases: EvalCase[];
};

/** Item da listagem (sem os casos). */
export type EvalRunSummary = Omit<EvalRun, 'cases'>;

/** Uma pergunta do padrão-ouro vinda da tela Dataset (o id identifica a linha; a ordem do array é a ordem do arquivo). */
export const EvalQuestionInput = z.object({
  id: z.string().min(1).max(40),
  workspace: z.string().max(120).optional(),
  question: z.string().min(1).max(500),
  expectedItem: z.string().max(40).optional(),
  expectedDocument: z.string().max(120).optional(),
  expectedValues: z.array(z.string().max(200)).max(20).default([]),
  answerable: z.boolean().default(true),
  topic: z.string().max(40).optional(),
  nivel: z.enum(['direta', 'composta']).optional(),
  expectedAnswer: z.string().max(4000).optional(),
});
export type EvalQuestionInput = z.input<typeof EvalQuestionInput>;

export const EvalDatasetRequest = z.object({
  file: z.string().regex(/^[\w.-]+\.csv$/).optional(),
  questions: z.array(EvalQuestionInput).min(1).max(500),
});

export const EvalRunRequest = z.object({
  /** Workspace padrão (perguntas sem coluna `workspace`) e filtro: só perguntas desse workspace quando informado. */
  workspaceId: z.string().optional(),
  documentIds: z.array(z.string()).optional(),
  arms: z.array(z.enum(EVAL_ARM_IDS)).min(1).default(DEFAULT_EVAL_ARMS),
  /** Nome do arquivo dentro de `eval/` (sem caminho). */
  questionsFile: z.string().regex(/^[\w.-]+\.csv$/).default('nucleo.csv'),
  label: z.string().max(80).optional(),
  grounding: z.enum(['strict', 'warn', 'off']).optional(),
  /** Família de prompt imposta a todos os braços (ex.: `qa.v4`); vazio = a dos settings do workspace. */
  promptVersion: z.string().regex(/^qa\.v\d+$/).optional(),
  /** Pausa entre chamadas (ms) para respeitar limites de requisições por minuto de free tiers. */
  pauseMs: z.number().int().min(0).max(60_000).default(0),
});
export type EvalRunRequest = z.infer<typeof EvalRunRequest>;
/** Corpo aceito pelo POST (campos com default opcionais). */
export type EvalRunRequestInput = z.input<typeof EvalRunRequest>;
