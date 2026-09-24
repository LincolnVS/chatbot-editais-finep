import { z } from 'zod';
import { canonicalJson, sha256 } from './hash.ts';

/** Configuração completa do pipeline RAG. */
export const ChunkingConfig = z.object({
  /** `hier` = chunker hierárquico (seção › item › alínea, tabela como bloco); `fixed` = janela fixa (controle). */
  strategy: z.enum(['hier', 'fixed']).default('hier'),
  /** Tamanho máximo do chunk em caracteres (≈ 4 chars/token em pt-BR; 1600 ≈ 400 tokens). */
  maxChars: z.number().int().min(200).max(8000).default(1600),
  /** Sobreposição em caracteres — só usada quando um bloco precisa ser fatiado ou em `fixed`. */
  overlapChars: z.number().int().min(0).max(2000).default(150),
  /** `markdown` = tabela vira 1 chunk em Markdown; `markdown+rows` = também 1 chunk-frase por linha. */
  tableMode: z.enum(['markdown', 'markdown+rows']).default('markdown'),
  /** Junta blocos vizinhos do mesmo `sectionPath` até `maxChars`. */
  mergePeers: z.boolean().default(true),
});

export const RetrievalConfig = z.object({
  mode: z.enum(['hybrid', 'dense', 'bm25']).default('hybrid'),
  /** Candidatos por índice antes da fusão. */
  candidates: z.number().int().min(1).max(200).default(30),
  /**
   * Constante do RRF (escore = Σ 1/(k + posição)). Com k pequeno o topo de cada lista domina; com k grande (60, valor
   * clássico) conta mais "em quantas listas apareceu" do que a posição — o que dilui a fusão quando a expansão de
   * consulta soma várias listas. Escolhido por varredura offline (taxa de item esperado no contexto).
   */
  rrfK: z.number().int().min(1).default(1),
  topK: z.number().int().min(1).max(50).default(12),
  /** Substitui folhas pelo pai (seção) quando ≥ 2 folhas do mesmo pai foram selecionadas e o pai cabe. */
  expandToParent: z.boolean().default(true),
  /** Orçamento de contexto enviado ao LLM, em caracteres. */
  contextBudgetChars: z.number().int().min(1000).default(28000),
  /**
   * Expansão de consulta: quantas reformulações da pergunta o modelo gera antes da busca (0 = desligada).
   * Cada variante roda BM25 + vetorial e entra na fusão RRF; fecha a lacuna de vocabulário entre pergunta e edital.
   */
  queryExpansion: z.number().int().min(0).max(6).default(4),
  /**
   * Glossário do domínio escrito à mão (18 grupos). Mantido só para comparação: foi montado olhando as perguntas de
   * avaliação, então não vale como resultado. O padrão é `docGlossary`.
   */
  glossary: z.boolean().default(false),
  /**
   * Glossário derivado do documento: na ingestão, o sistema extrai do próprio edital as definições numeradas, as siglas
   * e as expressões "entende-se por …". Na consulta, tocar um termo traz as formas irmãs. Não depende das perguntas.
   */
  docGlossary: z.boolean().default(true),
  /**
   * Camada do glossário gerada por LLM na ingestão: o modelo lê só o documento e escreve, para cada termo do edital,
   * como um proponente leigo perguntaria a mesma coisa. Fecha o lado do vocabulário do usuário, que a extração literal
   * não alcança ("tempo de constituição" ↔ "registro na Junta Comercial").
   */
  llmGlossary: z.boolean().default(false),
  /**
   * Glossário do acervo: os editais já ingeridos entram no glossário de qualquer busca. Editais da mesma instituição
   * repetem a terminologia, então o que um define serve de mapa para outro que usa a palavra sem definir. Um termo de
   * outro edital só vira expansão se existir no documento em escopo — senão seria consulta com palavra que o texto não tem.
   */
  sharedGlossary: z.boolean().default(false),
  /**
   * Realimentação por pseudo-relevância (Rocchio/RM3): busca uma vez, tira os termos mais discriminativos dos melhores
   * trechos e busca de novo com eles. Fecha a lacuna de vocabulário sem lista nenhuma e sem LLM.
   */
  prf: z.boolean().default(false),
  /** Quantos trechos do topo alimentam a realimentação. */
  prfDocs: z.number().int().min(1).max(20).default(5),
  /** Quantos termos entram na consulta de realimentação. */
  prfTerms: z.number().int().min(1).max(30).default(8),
  /** Estrutura do edital: candidatos das seções mais bem rankeadas (chunks de seção no topo da fusão) ganham bônus — a seção "Elegibilidade" puxa seus itens. */
  sectionBoost: z.boolean().default(false),
  /** Reranker (cross-encoder local) sobre os melhores candidatos da fusão; 'off' mantém a ordem RRF. */
  rerank: z.enum(['off', 'bge-m3', 'jina-v2', 'bge-base']).default('off'),
  /** Quantos candidatos (ordem RRF) passam pelo reranker. */
  rerankCandidates: z.number().int().min(5).max(100).default(40),
  /**
   * Roteamento por documento (workspace com vários editais): documento nomeado na pergunta ganha bônus; sem documento
   * nomeado, cada edital principal garante uma cota mínima no top-k (perguntas comparativas). Com um edital só, não faz nada.
   */
  documentRouting: z.boolean().default(true),
});

export const GenerationConfig = z.object({
  /** `rag` = chunks recuperados; `full_context` = documento(s) inteiro(s) (baseline D4); `closed_book` = sem documento. */
  mode: z.enum(['rag', 'full_context', 'closed_book']).default('rag'),
  /** Nome/versão do prompt em `apps/api/src/llm/prompts/`. */
  promptVersion: z.string().default('qa.v4'),
  /** strict = blocos sem citação válida (ou com valores ausentes dos trechos) saem da resposta; warn = só avisa; off = sem gate. */
  grounding: z.enum(['strict', 'warn', 'off']).default('strict'),
  /** Rodadas extras pedindo ao modelo que corrija citações/valores antes de aplicar o gate. */
  maxRepairs: z.number().int().min(0).max(2).default(1),
  /**
   * Busca extra dirigida pelo modelo: se os trechos não bastarem, ele pede `<buscar>termos</buscar>`, a busca roda de novo
   * com esses termos e ele responde com os trechos acrescentados (até 2 rodadas). Mais lento; mira os erros de recuperação.
   */
  extraSearch: z.boolean().default(false),
});

export const PipelineConfig = z.object({
  parser: z.literal('docling').default('docling'),
  removeHeaderFooter: z.boolean().default(true),
  chunking: ChunkingConfig.prefault({}),
  /** Id do modelo no registry (`apps/api/src/embed/registry.ts`). Escolhido por medição offline (docs/09 §3.3): e5-base recupera o item esperado em 88% das perguntas no híbrido sem expansão, contra 81% do e5-small. */
  embedModel: z.string().default('e5-base-q8'),
  retrieval: RetrievalConfig.prefault({}),
  generation: GenerationConfig.prefault({}),
});

export type PipelineConfig = z.infer<typeof PipelineConfig>;
export type ChunkingConfig = z.infer<typeof ChunkingConfig>;
export type RetrievalConfig = z.infer<typeof RetrievalConfig>;
export type GenerationConfig = z.infer<typeof GenerationConfig>;

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = PipelineConfig.parse({});

/** Versão parcial e profunda de um tipo (usada pelos overrides de PipelineConfig). */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type PipelineConfigPatch = DeepPartial<PipelineConfig>;

/** Mesmo formato sem defaults e com todos os campos opcionais: valida um override parcial. */
function withoutDefaults(schema: z.ZodObject): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let f = field as z.ZodType;
    while (f instanceof z.ZodDefault || f instanceof z.ZodPrefault) f = f.unwrap() as z.ZodType;
    if (f instanceof z.ZodObject) f = withoutDefaults(f);
    shape[key] = f.optional();
  }
  return z.object(shape);
}

export const PipelineConfigPatch = withoutDefaults(PipelineConfig) as unknown as z.ZodType<PipelineConfigPatch>;

/** Hash canônico (sha256 do JSON ordenado) — identifica a configuração inteira. */
export function configHash(config: PipelineConfig): string {
  return sha256(canonicalJson(config));
}

/** Identifica o conjunto de chunks de um documento: depende só do parse e do chunking. */
export function chunkSetId(parseHash: string, chunking: ChunkingConfig, removeHeaderFooter: boolean): string {
  return sha256(canonicalJson({ parseHash, chunking, removeHeaderFooter })).slice(0, 16);
}
