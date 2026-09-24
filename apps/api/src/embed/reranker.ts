/**
 * Reranker local (cross-encoder, Transformers.js/ONNX): lê pergunta e trecho juntos e devolve um escore de relevância.
 * Diferente do bi-encoder (e5), que compara vetores independentes, o cross-encoder enxerga a relação entre os dois textos —
 * é o que fecha a lacuna de vocabulário ("tempo de constituição" ≈ "funcionamento regular há três anos").
 */
import { AutoModelForSequenceClassification, AutoTokenizer, env, type PreTrainedModel, type PreTrainedTokenizer } from '@huggingface/transformers';
import { config } from '../config.ts';

export type RerankerId = 'bge-m3' | 'jina-v2' | 'bge-base';

export type RerankerSpec = { id: RerankerId; hfName: string; dtype: 'q8' | 'int8' | 'fp32'; maxTokens: number; license: string };

export const RERANKERS: Record<RerankerId, RerankerSpec> = {
  'bge-m3': { id: 'bge-m3', hfName: 'onnx-community/bge-reranker-v2-m3-ONNX', dtype: 'q8', maxTokens: 1024, license: 'Apache-2.0' },
  'jina-v2': { id: 'jina-v2', hfName: 'jinaai/jina-reranker-v2-base-multilingual', dtype: 'q8', maxTokens: 1024, license: 'CC-BY-NC-4.0' },
  'bge-base': { id: 'bge-base', hfName: 'Xenova/bge-reranker-base', dtype: 'q8', maxTokens: 512, license: 'MIT' },
};

export type Reranker = {
  spec: RerankerSpec;
  /** Escore (logit) de cada trecho para a consulta; maior = mais relevante. */
  score(query: string, texts: string[]): Promise<number[]>;
  loadTimeMs(): number | null;
};

const loaded = new Map<RerankerId, Reranker>();
const BATCH = 8;

export function getReranker(id: RerankerId): Reranker {
  let r = loaded.get(id);
  if (!r) {
    r = createReranker(RERANKERS[id]);
    loaded.set(id, r);
  }
  return r;
}

function createReranker(spec: RerankerSpec): Reranker {
  env.cacheDir = config.modelsDir;
  env.allowRemoteModels = true;
  let loadMs: number | null = null;
  let modelPromise: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;
  const load = () => {
    if (!modelPromise) {
      const t0 = performance.now();
      modelPromise = Promise.all([
        AutoTokenizer.from_pretrained(spec.hfName),
        AutoModelForSequenceClassification.from_pretrained(spec.hfName, { dtype: spec.dtype, device: 'cpu' }),
      ]).then(([tokenizer, model]) => {
        loadMs = Math.round(performance.now() - t0);
        return { tokenizer, model };
      });
    }
    return modelPromise;
  };
  return {
    spec,
    async score(query, texts) {
      if (texts.length === 0) return [];
      const { tokenizer, model } = await load();
      const out: number[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const docs = texts.slice(i, i + BATCH);
        const inputs = tokenizer(docs.map(() => query), { text_pair: docs, padding: true, truncation: true, max_length: spec.maxTokens });
        const { logits } = await model(inputs);
        const data = logits.data as Float32Array;
        const cols = logits.dims[logits.dims.length - 1] ?? 1;
        for (let j = 0; j < docs.length; j++) out.push(data[j * cols + (cols - 1)] ?? 0);
      }
      return out;
    },
    loadTimeMs: () => loadMs,
  };
}
