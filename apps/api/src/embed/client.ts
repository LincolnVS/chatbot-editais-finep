/** Cliente de embeddings: roda o modelo Transformers.js num `worker_threads` (não bloqueia o servidor). */
import { Worker } from 'node:worker_threads';
import { config } from '../config.ts';
import { getEmbedModelSpec, type EmbedModelSpec } from './registry.ts';
import type { WorkerInit, WorkerRequest, WorkerResponse } from './worker.ts';

export type Embedder = {
  spec: EmbedModelSpec;
  /** Embeddings L2-normalizados dos textos (já com prefixo de passagem). */
  embedPassages(texts: string[], onProgress?: (done: number, total: number) => void): Promise<Float32Array[]>;
  /** Embedding L2-normalizado da consulta (com prefixo de query). */
  embedQuery(text: string): Promise<Float32Array>;
  /** Tokens de cada texto (com prefixo de passagem, sem truncar) — para medir quantos chunks o modelo trunca. Opcional (fakes de teste não implementam). */
  countTokens?(texts: string[]): Promise<number[]>;
  /** Tempo de carga do modelo (ms) — para logs/monografia. */
  loadTimeMs(): number | null;
  close(): Promise<void>;
};

const BATCH_SIZE = 16;

type WorkerResult = { vectors: ArrayBuffer; dims: number } | { counts: number[] };
type Pending = { resolve: (v: WorkerResult) => void; reject: (e: Error) => void };

/** Estado de um worker por modelo. */
class EmbedWorker {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private loadMs: number | null = null;
  private readonly spec: EmbedModelSpec;
  private readonly modelsDir: string;

  constructor(spec: EmbedModelSpec, modelsDir: string) {
    this.spec = spec;
    this.modelsDir = modelsDir;
  }

  loadTimeMs(): number | null {
    return this.loadMs;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const init: WorkerInit = { spec: this.spec, modelsDir: this.modelsDir };
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: init });
    worker.on('message', (msg: WorkerResponse) => {
      if (msg.type === 'ready') {
        this.loadMs = msg.loadTimeMs;
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (!msg.ok) p.reject(new Error(`Falha no embedding (${this.spec.id}): ${msg.error}`));
      else if ('counts' in msg) p.resolve({ counts: msg.counts });
      else p.resolve({ vectors: msg.vectors, dims: msg.dims });
    });
    const fail = (reason: string) => {
      if (this.worker === worker) this.worker = null;
      for (const p of this.pending.values()) p.reject(new Error(`Worker de embeddings (${this.spec.id}) encerrou: ${reason}`));
      this.pending.clear();
    };
    worker.on('error', (err: Error) => fail(err.message));
    worker.on('exit', (code) => fail(`exit code ${code}`));
    this.worker = worker;
    return worker;
  }

  private request(type: 'passages' | 'query' | 'count', texts: string[]): Promise<WorkerResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<WorkerResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, texts } satisfies WorkerRequest);
    });
  }

  /** Tokens por texto (sem truncar). */
  async countTokens(texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];
    const result = await this.request('count', texts);
    return 'counts' in result ? result.counts : [];
  }

  /** Envia um lote (≤ BATCH_SIZE textos, já com prefixo) e devolve um Float32Array por texto. */
  async embedBatch(type: 'passages' | 'query', texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const result = await this.request(type, texts);
    if (!('vectors' in result)) throw new Error(`Resposta inesperada do worker de embeddings (${this.spec.id})`);
    const { vectors, dims } = result;
    if (dims !== this.spec.dims) throw new Error(`Modelo ${this.spec.id} devolveu ${dims} dims (registry: ${this.spec.dims})`);
    const all = new Float32Array(vectors);
    return texts.map((_, i) => all.slice(i * dims, (i + 1) * dims));
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    worker.postMessage({ type: 'close' } satisfies WorkerRequest);
    await worker.terminate();
  }
}

const embedders = new Map<string, Embedder>();

function createEmbedder(spec: EmbedModelSpec): Embedder {
  const w = new EmbedWorker(spec, config.modelsDir);
  return {
    spec,
    async embedPassages(texts, onProgress) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE).map((t) => spec.passagePrefix + t);
        out.push(...(await w.embedBatch('passages', batch)));
        onProgress?.(out.length, texts.length);
      }
      return out;
    },
    async embedQuery(text) {
      const [vec] = await w.embedBatch('query', [spec.queryPrefix + text]);
      return vec!;
    },
    countTokens: (texts) => w.countTokens(texts.map((t) => spec.passagePrefix + t)),
    loadTimeMs: () => w.loadTimeMs(),
    close: () => w.close(),
  };
}

/** Devolve o embedder (singleton por modelId). */
export function getEmbedder(modelId: string): Embedder {
  let e = embedders.get(modelId);
  if (!e) {
    e = createEmbedder(getEmbedModelSpec(modelId));
    embedders.set(modelId, e);
  }
  return e;
}

/** Encerra todos os workers (shutdown). */
export async function closeAllEmbedders(): Promise<void> {
  const all = [...embedders.values()];
  embedders.clear();
  await Promise.all(all.map((e) => e.close()));
}
