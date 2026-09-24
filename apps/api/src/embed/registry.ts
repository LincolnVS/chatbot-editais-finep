/** Registry de modelos de embedding locais (Transformers.js / ONNX). */
export type EmbedModelSpec = {
  id: string;
  /** Nome no Hugging Face Hub (subpasta em DATA_DIR/models quando já baixado). */
  hfName: string;
  dims: number;
  dtype: 'q8' | 'fp32';
  /** Prefixos exigidos pelo modelo. */
  passagePrefix: string;
  queryPrefix: string;
  pooling: 'mean' | 'cls';
  normalize: boolean;
  maxTokens: number;
  license: string;
};

export const EMBED_MODELS: Record<string, EmbedModelSpec> = {
  'e5-small-q8': {
    id: 'e5-small-q8',
    hfName: 'Xenova/multilingual-e5-small',
    dims: 384,
    dtype: 'q8',
    passagePrefix: 'passage: ',
    queryPrefix: 'query: ',
    pooling: 'mean',
    normalize: true,
    maxTokens: 512,
    license: 'MIT',
  },
  'e5-base-q8': {
    id: 'e5-base-q8',
    hfName: 'Xenova/multilingual-e5-base',
    dims: 768,
    dtype: 'q8',
    passagePrefix: 'passage: ',
    queryPrefix: 'query: ',
    pooling: 'mean',
    normalize: true,
    maxTokens: 512,
    license: 'MIT',
  },
};

export function getEmbedModelSpec(id: string): EmbedModelSpec {
  const spec = EMBED_MODELS[id];
  if (!spec) throw new Error(`Modelo de embedding desconhecido: ${id}. Conhecidos: ${Object.keys(EMBED_MODELS).join(', ')}`);
  return spec;
}

/** Nome da tabela vec0 para um modelo: só [a-z0-9_]. */
export function vecTableName(modelId: string): string {
  return `chunks_vec_${modelId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}
