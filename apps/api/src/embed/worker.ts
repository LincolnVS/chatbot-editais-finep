/** Worker de embeddings (worker_threads): carrega o modelo Transformers.js uma vez e responde às mensagens do cliente. */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { pipeline, env } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbedModelSpec } from './registry.ts';

export type WorkerInit = { spec: EmbedModelSpec; modelsDir: string };
export type WorkerRequest = { id: number; type: 'passages' | 'query' | 'count'; texts: string[] } | { type: 'close' };
export type WorkerResponse =
  | { type: 'ready'; loadTimeMs: number }
  | { type: 'result'; id: number; ok: true; vectors: ArrayBuffer; dims: number }
  | { type: 'result'; id: number; ok: true; counts: number[] }
  | { type: 'result'; id: number; ok: false; error: string };

if (!parentPort) throw new Error('embed/worker.ts deve rodar como worker_thread');
const port: MessagePort = parentPort;

const { spec, modelsDir } = workerData as WorkerInit;

// Cache local (DATA_DIR/models/<hfName>/…); baixa do Hub só se faltar algum arquivo.
env.cacheDir = modelsDir;
env.allowRemoteModels = true;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function loadModel(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    const t0 = performance.now();
    extractorPromise = pipeline('feature-extraction', spec.hfName, { dtype: spec.dtype, device: 'cpu' }).then((p) => {
      port.postMessage({ type: 'ready', loadTimeMs: Math.round(performance.now() - t0) } satisfies WorkerResponse);
      return p;
    });
  }
  return extractorPromise;
}

async function embed(texts: string[]): Promise<{ vectors: ArrayBuffer; dims: number }> {
  const extractor = await loadModel();
  // O pipeline tokeniza com padding + truncation (limite = max_position_embeddings do modelo, 512 no e5).
  const out = await extractor(texts, { pooling: spec.pooling, normalize: spec.normalize });
  const dims = out.dims[out.dims.length - 1] ?? spec.dims;
  const data = out.data as Float32Array;
  // cópia num buffer próprio para poder transferir a posse ao thread principal
  const copy = new Float32Array(data.length);
  copy.set(data);
  return { vectors: copy.buffer, dims };
}

/** Tokens por texto SEM truncamento (o pipeline trunca em max_position_embeddings; aqui medimos o excesso). */
async function countTokens(texts: string[]): Promise<number[]> {
  const extractor = await loadModel();
  return texts.map((t) => {
    const enc = extractor.tokenizer(t, { truncation: false, padding: false, add_special_tokens: true });
    return enc.input_ids.dims[enc.input_ids.dims.length - 1] ?? 0;
  });
}

port.on('message', async (msg: WorkerRequest) => {
  if (msg.type === 'close') {
    try {
      if (extractorPromise) await (await extractorPromise).dispose();
    } finally {
      process.exit(0);
    }
  }
  try {
    if (msg.type === 'count') {
      port.postMessage({ type: 'result', id: msg.id, ok: true, counts: await countTokens(msg.texts) } satisfies WorkerResponse);
      return;
    }
    const { vectors, dims } = await embed(msg.texts);
    port.postMessage({ type: 'result', id: msg.id, ok: true, vectors, dims } satisfies WorkerResponse, [vectors]);
  } catch (err) {
    port.postMessage({ type: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
});

// Começa a carregar assim que o worker sobe (a primeira requisição não espera).
void loadModel().catch(() => { /* o erro é reportado na primeira requisição */ });
