/** Embeddings com o modelo REAL (multilingual-e5-small q8 em DATA_DIR/models) rodando no worker_thread. */
import { describe, it, expect, afterAll } from 'vitest';
import { getEmbedder, closeAllEmbedders } from '../src/embed/client.ts';

const MODEL = 'e5-small-q8';

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

describe('embed/client (modelo real)', () => {
  afterAll(async () => {
    await closeAllEmbedders();
  });

  it('gera embeddings de 384 dims, L2-normalizados, e a consulta fica mais próxima da passagem pertinente', async () => {
    const embedder = getEmbedder(MODEL);
    expect(getEmbedder(MODEL)).toBe(embedder); // singleton por modelo
    expect(embedder.spec.dims).toBe(384);

    const passages = [
      'O prazo final para envio de propostas é 07/04/2026, às 18h, pela Plataforma de Apoio e Financiamento.',
      'A contrapartida financeira mínima exigida das instituições estaduais é de 5% do valor solicitado.',
      'Serão eliminadas as propostas que não atenderem aos critérios de elegibilidade desta chamada.',
    ];
    const progress: Array<[number, number]> = [];
    const t0 = performance.now();
    const vectors = await embedder.embedPassages(passages, (done, total) => progress.push([done, total]));
    const passagesMs = performance.now() - t0;

    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(384);
      expect(norm(v)).toBeCloseTo(1, 3);
    }
    expect(progress).toEqual([[3, 3]]);

    const t1 = performance.now();
    const query = await embedder.embedQuery('prazo de submissão');
    const queryMs = performance.now() - t1;
    expect(query.length).toBe(384);
    expect(norm(query)).toBeCloseTo(1, 3);

    const simPrazo = dot(query, vectors[0]!);
    const simContrapartida = dot(query, vectors[1]!);
    expect(simPrazo).toBeGreaterThan(simContrapartida);

    const loadMs = embedder.loadTimeMs();
    expect(loadMs).not.toBeNull();
    expect(loadMs!).toBeGreaterThan(0);
    // métricas para a monografia (aparecem no relatório do vitest com --reporter=verbose)
    console.info(`[embed] carga do modelo: ${loadMs} ms; ${passages.length} passagens: ${passagesMs.toFixed(0)} ms (${(passagesMs / passages.length).toFixed(0)} ms/chunk, inclui espera da carga); query: ${queryMs.toFixed(0)} ms; sim(prazo)=${simPrazo.toFixed(3)} sim(contrapartida)=${simContrapartida.toFixed(3)}`);
  }, 120_000);

  it('processa lotes maiores que 16 com progresso por lote e determinismo', async () => {
    const embedder = getEmbedder(MODEL);
    const texts = Array.from({ length: 20 }, (_, i) => `Item ${i + 1}: despesas apoiáveis incluem material de consumo e serviços de terceiros.`);
    const progress: number[] = [];
    const t0 = performance.now();
    const vectors = await embedder.embedPassages(texts, (done) => progress.push(done));
    const ms = performance.now() - t0;
    expect(vectors).toHaveLength(20);
    expect(progress).toEqual([16, 20]);
    // mesmo texto sozinho ou dentro de um lote (padding diferente) → praticamente o mesmo vetor (q8 tem ruído numérico)
    const again = await embedder.embedPassages([texts[0]!]);
    expect(dot(again[0]!, vectors[0]!)).toBeGreaterThan(0.99);
    console.info(`[embed] 20 passagens: ${ms.toFixed(0)} ms (${(ms / 20).toFixed(1)} ms/chunk)`);
  }, 120_000);

  it('close() encerra o worker e o próximo uso recria', async () => {
    const embedder = getEmbedder(MODEL);
    await embedder.close();
    const v = await embedder.embedQuery('critérios de elegibilidade');
    expect(v.length).toBe(384);
  }, 120_000);
});
