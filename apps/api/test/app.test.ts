/** Integração ponta a ponta sem rede: rotas (app.ts) + fila + pipeline sobre um banco ':memory:' e um DATA_DIR temporário. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

// DATA_DIR precisa estar definido ANTES de config.ts ser importado (vi.hoisted roda antes dos imports estáticos).
const TMP_DIR = await vi.hoisted(async () => {
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
  const dir = mkdtempSync(join(tmpdir(), 'editais-app-test-'));
  process.env.DATA_DIR = dir;
  process.env.EVAL_DIR = join(dir, 'eval');
  return dir;
});

import type { AppContext } from '../src/context.ts';
import { config } from '../src/config.ts';
import { storage } from '../src/storage.ts';
import { openDatabase } from '../src/db/sqlite.ts';
import * as q from '../src/db/queries.ts';
import { getEmbedModelSpec } from '../src/embed/registry.ts';
import type { Embedder } from '../src/embed/client.ts';
import type { DoclingClient, DoclingServeResponse } from '../src/ingest/docling.ts';
import { DoclingUnavailableError } from '../src/ingest/docling.ts';
import { createApp } from '../src/app.ts';
import { ingestDocument } from '../src/ingest/pipeline.ts';
import { configHash, sha256, type AnswerResult, type EvalRun, type EvalRunSummary, type IngestionJob, type RetrievalResult, type StoredChunk, type Workspace } from '@editais/shared';

const FIXTURE = new URL('./fixtures/agrifam_ict_2026.docling-serve.json', import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as DoclingServeResponse;
const SPEC = getEmbedModelSpec('e5-small-q8');

/** Vetor pseudo-aleatório L2-normalizado derivado do texto (determinístico, sem modelo). */
function fakeVector(text: string): Float32Array {
  const v = new Float32Array(SPEC.dims);
  let seed = 0;
  for (const ch of sha256(text).slice(0, 16)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    v[i] = (seed / 0xffffffff) - 0.5;
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

const embedCalls: string[][] = [];
const fakeEmbedder: Embedder = {
  spec: SPEC,
  async embedPassages(texts, onProgress) {
    embedCalls.push(texts);
    onProgress?.(texts.length, texts.length);
    return texts.map(fakeVector);
  },
  async embedQuery(text) {
    return fakeVector(text);
  },
  loadTimeMs: () => 1,
  close: async () => {},
};

let doclingUp = true;
/** Atraso artificial do parse (para observar o SSE com o job ainda em andamento). */
let doclingDelayMs = 0;
const convertCalls: string[] = [];
const fakeDocling: DoclingClient = {
  async convertPdf(_pdf, filename) {
    if (!doclingUp) throw new DoclingUnavailableError('parser indisponível — suba com npm run dev:docling');
    convertCalls.push(filename);
    if (doclingDelayMs > 0) await new Promise((r) => setTimeout(r, doclingDelayMs));
    return fixture;
  },
  async version() {
    if (!doclingUp) throw new DoclingUnavailableError('parser indisponível — suba com npm run dev:docling');
    return 'docling@test';
  },
  async isUp() {
    return doclingUp;
  },
};

function makeContext(): AppContext {
  storage.ensureDirs();
  const db = openDatabase(':memory:');
  const jobEvents = new EventEmitter();
  return {
    db,
    config,
    log: pino({ level: 'silent' }),
    docling: fakeDocling,
    embedder: () => fakeEmbedder,
    jobEvents,
    async close() {
      db.close();
    },
  };
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n% fake edital para o teste de rotas\n%%EOF\n');

function upload(app: ReturnType<typeof createApp>, workspaceId: string, name: string, fields: Record<string, string> = {}, bytes: Buffer = PDF_BYTES) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return app.request(`/api/workspaces/${workspaceId}/documents`, { method: 'POST', body: form });
}

async function waitForJob(app: ReturnType<typeof createApp>, documentId: string, timeoutMs = 20_000): Promise<IngestionJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.request(`/api/documents/${documentId}/status`);
    const job = (await res.json()) as IngestionJob;
    if (job.status === 'done' || job.status === 'failed') return job;
    if (Date.now() > deadline) throw new Error(`timeout esperando o job de ${documentId} (stage=${job.stage})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('app (rotas + fila + pipeline)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  let workspace: Workspace;
  let editalId: string;
  let avisoId: string;

  beforeAll(() => {
    expect(config.dataDir).toBe(TMP_DIR);
    ctx = makeContext();
    app = createApp(ctx);
  });
  afterAll(async () => {
    await ctx.close();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('GET /api/health responde com db/docling/embedModel', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: true, docling: true, embedModel: 'e5-base-q8' });
  });

  it('404 JSON para rota desconhecida e 400 de validação (zod) no POST /api/workspaces', async () => {
    const missing = await app.request('/api/nada');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });

    const invalid = await app.request('/api/workspaces', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } });
    expect(invalid.status).toBe(400);
    const body = await json<{ error: { code: string; issues: Array<{ path: string }> } }>(invalid);
    expect(body.error.code).toBe('validation');
    expect(body.error.issues[0]?.path).toBe('name');

    const notJson = await app.request('/api/workspaces', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } });
    expect(notJson.status).toBe(400);
  });

  it('cria, lista, lê e altera settings de um workspace', async () => {
    const created = await app.request('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Agricultura Familiar ICT 2026', callCode: 'AGRIFAM-2026', settings: { chunking: { maxChars: 1400 } } }),
      headers: { 'content-type': 'application/json' },
    });
    expect(created.status).toBe(201);
    workspace = await json<Workspace>(created);
    expect(workspace.settings.chunking.maxChars).toBe(1400);
    expect(workspace.settings.retrieval.topK).toBe(12);

    const list = await json<Workspace[]>(await app.request('/api/workspaces'));
    expect(list.map((w) => w.id)).toContain(workspace.id);

    const patched = await app.request(`/api/workspaces/${workspace.id}/settings`, {
      method: 'PATCH', body: JSON.stringify({ retrieval: { topK: 5 } }), headers: { 'content-type': 'application/json' },
    });
    expect(patched.status).toBe(200);
    const after = await json<Workspace>(patched);
    // mesclagem profunda: topK mudou, maxChars do POST continua
    expect(after.settings.retrieval.topK).toBe(5);
    expect(after.settings.chunking.maxChars).toBe(1400);

    const bad = await app.request(`/api/workspaces/${workspace.id}/settings`, {
      method: 'PATCH', body: JSON.stringify({ retrieval: { mode: 'quantum' } }), headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);

    const detail = await json<Workspace & { documents: unknown[] }>(await app.request(`/api/workspaces/${workspace.id}`));
    expect(detail.documents).toEqual([]);
    expect((await app.request('/api/workspaces/naoexiste')).status).toBe(404);
  });

  it('upload valida arquivo, campos e amendsDocumentId', async () => {
    const noFile = await app.request(`/api/workspaces/${workspace.id}/documents`, { method: 'POST', body: new FormData() });
    expect(noFile.status).toBe(400);

    const notPdf = await upload(app, workspace.id, 'x.txt', {}, Buffer.from('apenas texto'));
    expect(notPdf.status).toBe(400);

    const badKind = await upload(app, workspace.id, 'edital.pdf', { docKind: 'inexistente' });
    expect(badKind.status).toBe(400);

    const badAmends = await upload(app, workspace.id, 'aviso.pdf', { amendsDocumentId: 'nao-existe' });
    expect(badAmends.status).toBe(400);
  });

  it('upload → 202 com job na fila → ingestão completa (parse → normalize → chunk → embed → index)', async () => {
    const res = await upload(app, workspace.id, 'agrifam_ict_2026_edital.pdf', { title: 'Chamada Agricultura Familiar ICT 2026', versionLabel: 'original' });
    expect(res.status).toBe(202);
    const { document, job } = await json<{ document: { id: string; title: string; status: string; precedence: number }; job: IngestionJob }>(res);
    expect(document.title).toBe('Chamada Agricultura Familiar ICT 2026');
    expect(document.status).toBe('uploaded');
    expect(job).toMatchObject({ documentId: document.id, stage: 'parse', status: 'queued' });
    editalId = document.id;
    expect(fs.existsSync(storage.uploadPath(editalId))).toBe(true);

    const done = await waitForJob(app, editalId);
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.stage).toBe('done');
    expect(done.progress).toBe(1);
    for (const stage of ['parse', 'normalize', 'chunk', 'embed', 'index', 'total']) expect(done.stageTimingsMs[stage]).toBeGreaterThanOrEqual(0);
    expect(convertCalls).toEqual(['agrifam_ict_2026_edital.pdf']);

    const detail = await json<{ status: string; pageCount: number; parserVersion: string; chunkCount: number; precedence: number; stats: { sections: number; tables: number } | null; chunkSetId: string | null }>(
      await app.request(`/api/documents/${editalId}`),
    );
    expect(detail.status).toBe('ready');
    expect(detail.pageCount).toBe(27);
    expect(detail.parserVersion).toBe('docling@test');
    expect(detail.precedence).toBe(1);
    expect(detail.chunkCount).toBeGreaterThan(40);
    expect(detail.stats?.sections).toBeGreaterThan(20);
    expect(detail.stats?.tables).toBe(4); // 5 tabelas no Docling; uma quebrada entre páginas é fundida pelo normalizador
    expect(detail.chunkSetId).toMatch(/^[0-9a-f]{16}$/);

    // artefatos em DATA_DIR/parsed
    for (const p of [storage.parsedJsonPath(editalId), storage.parsedDocPath(editalId), storage.canonicalMdPath(editalId), storage.sectionsJsonPath(editalId)]) {
      expect(fs.existsSync(p), p).toBe(true);
    }
    expect(q.getDocPages(ctx.db, editalId)).toHaveLength(27);
  });

  it('GET /chunks lista o chunk_set vigente; o título do documento entra no contextPrefix', async () => {
    const body = await json<{ count: number; chunks: StoredChunk[] }>(await app.request(`/api/documents/${editalId}/chunks`));
    expect(body.count).toBe(body.chunks.length);
    expect(body.chunks.length).toBeGreaterThan(40);
    const kinds = new Set(body.chunks.map((c) => c.kind));
    expect(kinds.has('section')).toBe(true);
    expect(kinds.has('item')).toBe(true);
    expect(kinds.has('table')).toBe(true);
    expect(body.chunks[0]!.contextPrefix.startsWith('[Chamada Agricultura Familiar ICT 2026')).toBe(true);
    // pais grandes não são embedados; todos os demais têm vetor no vec0
    const embedded = body.chunks.filter((c) => c.embed);
    expect(embedded.length).toBeLessThan(body.chunks.length);
    // o embedder recebeu contextPrefix + "\n" + text, uma vez por contentHash distinto
    const firstBatch = embedCalls[0]!;
    expect(firstBatch.length).toBe(new Set(embedded.map((c) => c.contentHash)).size);
    const expectedTexts = new Set(embedded.map((c) => `${c.contextPrefix}\n${c.text}`));
    expect(firstBatch.every((t) => expectedTexts.has(t))).toBe(true);

    const canonical = await app.request(`/api/documents/${editalId}/canonical`);
    expect(canonical.headers.get('content-type')).toContain('text/markdown');
    // o bloco-título do canonical.md continua literal (texto do PDF); o título do documento entra só no contextPrefix
    expect(await canonical.text()).toMatch(/^# .+\{#sec-titulo p=1\}/);

    const file = await app.request(`/api/documents/${editalId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
  });

  it('dedupe por sha256 no workspace → 409; o mesmo PDF pode subir em outro workspace', async () => {
    const dup = await upload(app, workspace.id, 'copia.pdf');
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: { code: 'duplicate' } });

    const other = await json<Workspace>(await app.request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'outro' }), headers: { 'content-type': 'application/json' } }));
    const ok = await upload(app, other.id, 'Edital Subvenção Regional.pdf');
    expect(ok.status).toBe(202);
    const { document } = await json<{ document: { id: string } }>(ok);
    await waitForJob(app, document.id);
    // nome com acento: filename ASCII de fallback + filename* em UTF-8 (RFC 6266)
    const file = await app.request(`/api/documents/${document.id}/file`);
    expect(file.headers.get('content-disposition')).toBe(`inline; filename="Edital Subvencao Regional.pdf"; filename*=UTF-8''Edital%20Subven%C3%A7%C3%A3o%20Regional.pdf`);
    const del = await app.request(`/api/workspaces/${other.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(fs.existsSync(storage.uploadPath(document.id))).toBe(false);
    expect((await app.request(`/api/documents/${document.id}`)).status).toBe(404);
  });

  it('aviso de rerratificação (amendsDocumentId) fica com precedence 2 e o edital continua vigente', async () => {
    const res = await upload(app, workspace.id, 'aviso.pdf', { docKind: 'aviso_rerratificacao', amendsDocumentId: editalId, versionLabel: '1a_rerratificacao', title: 'Aviso de Rerratificação' },
      Buffer.concat([PDF_BYTES, Buffer.from('% aviso\n')]));
    expect(res.status).toBe(202);
    avisoId = (await json<{ document: { id: string } }>(res)).document.id;
    const done = await waitForJob(app, avisoId);
    expect(done.status, done.error ?? '').toBe('done');
    const aviso = q.getDocument(ctx.db, avisoId)!;
    expect(aviso.precedence).toBe(2);
    expect(aviso.amendsDocumentId).toBe(editalId);
    expect(q.getDocument(ctx.db, editalId)!.isCurrent).toBe(true);
    // segunda ingestão do mesmo conteúdo: tudo veio do cache de embeddings (nenhuma chamada nova ao embedder)
    const before = embedCalls.length;
    await ingestDocument(ctx, avisoId, { force: false });
    expect(embedCalls.length).toBe(before);
  });

  it('SSE /events envia o job atual e encerra quando já está done', async () => {
    const res = await app.request(`/api/documents/${editalId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: job');
    expect(text).toContain('"status":"done"');
  });

  it('reprocess sem force reutiliza o JSON congelado (não chama o Docling)', async () => {
    const before = convertCalls.length;
    const res = await app.request(`/api/documents/${editalId}/reprocess`, { method: 'POST', body: JSON.stringify({ force: false }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(202);
    const done = await waitForJob(app, editalId);
    expect(done.status).toBe('done');
    expect(done.message).toMatch(/^pronto: \d+ chunks/);
    expect(convertCalls.length).toBe(before);
  });

  it('SSE /events acompanha um reprocessamento forçado (parse → … → done) e encerra', async () => {
    doclingDelayMs = 60;
    try {
      const before = convertCalls.length;
      const res = await app.request(`/api/documents/${editalId}/reprocess`, { method: 'POST', body: JSON.stringify({ force: true }), headers: { 'content-type': 'application/json' } });
      expect(res.status).toBe(202);
      const events = await app.request(`/api/documents/${editalId}/events`);
      const text = await events.text();
      const jobs = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as IngestionJob);
      expect(jobs.length).toBeGreaterThan(3);
      expect(jobs[0]!.status).not.toBe('done');
      expect(new Set(jobs.map((j) => j.stage))).toEqual(new Set(['parse', 'normalize', 'chunk', 'embed', 'index', 'done']));
      expect(jobs.at(-1)!.status).toBe('done');
      expect(convertCalls.length).toBe(before + 1);
    } finally {
      doclingDelayMs = 0;
    }
  });

  it('reprocessamento que falha antes de tocar o índice mantém o documento ready (e no retrieval)', async () => {
    const before = await json<{ chunkCount: number; chunkSetId: string }>(await app.request(`/api/documents/${editalId}`));
    doclingUp = false;
    try {
      const res = await app.request(`/api/documents/${editalId}/reprocess`, { method: 'POST', body: JSON.stringify({ force: true }), headers: { 'content-type': 'application/json' } });
      expect(res.status).toBe(202);
      const job = await waitForJob(app, editalId);
      expect(job.status).toBe('failed');
      expect(job.stage).toBe('parse');
      const doc = await json<{ status: string; error: string; chunkCount: number; chunkSetId: string }>(await app.request(`/api/documents/${editalId}`));
      expect(doc.status).toBe('ready');
      expect(doc.error).toBe('parser_indisponivel');
      expect(doc.chunkCount).toBe(before.chunkCount);
      expect(doc.chunkSetId).toBe(before.chunkSetId);
      const search = await json<RetrievalResult>(await app.request(`/api/workspaces/${workspace.id}/search`, {
        method: 'POST', body: JSON.stringify({ query: 'prazo para envio da proposta', documentIds: [editalId] }), headers: { 'content-type': 'application/json' },
      }));
      expect(search.context.length).toBeGreaterThan(0);
    } finally {
      doclingUp = true;
    }
    // `force: "true"` (string) é erro de validação, não false silencioso
    const bad = await app.request(`/api/documents/${editalId}/reprocess`, { method: 'POST', body: JSON.stringify({ force: 'true' }), headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    const ok = await app.request(`/api/documents/${editalId}/reprocess`, { method: 'POST' });
    expect(ok.status).toBe(202);
    expect((await waitForJob(app, editalId)).status).toBe('done');
    expect((await json<{ error: string | null }>(await app.request(`/api/documents/${editalId}`))).error).toBeNull();
  });

  it('PATCH de settings que muda o índice reenfileira os documentos; o chunk_set anterior é removido e pipelineHash acompanha', async () => {
    const before = await json<{ chunkCount: number; chunkSetId: string; pipelineHash: string }>(await app.request(`/api/documents/${editalId}`));
    const res = await app.request(`/api/workspaces/${workspace.id}/settings`, {
      method: 'PATCH', body: JSON.stringify({ chunking: { maxChars: 900 } }), headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const patched = await json<Workspace & { reindexing: number }>(res);
    expect(patched.reindexing).toBe(2);
    for (const id of [editalId, avisoId]) expect((await waitForJob(app, id)).status).toBe('done');
    const after = await json<{ chunkCount: number; chunkSetId: string; pipelineHash: string }>(await app.request(`/api/documents/${editalId}`));
    expect(after.chunkSetId).not.toBe(before.chunkSetId);
    expect(after.chunkCount).toBeGreaterThan(before.chunkCount);
    expect(after.pipelineHash).toBe(configHash(patched.settings));
    // só o conjunto vigente sobrevive (chunks, FTS e vec0 do conjunto antigo saem)
    const sets = ctx.db.prepare('SELECT DISTINCT chunk_set_id AS id FROM chunks WHERE document_id = ?').all(editalId) as Array<{ id: string }>;
    expect(sets.map((s) => s.id)).toEqual([after.chunkSetId]);
    const orphanVec = ctx.db.prepare(`SELECT count(*) AS n FROM chunks_vec_e5_small_q8 WHERE chunk_rowid NOT IN (SELECT rowid FROM chunks)`).get() as { n: number };
    expect(orphanVec.n).toBe(0);
    // PATCH que não toca no índice (topK) não reenfileira
    const same = await json<{ reindexing: number }>(await app.request(`/api/workspaces/${workspace.id}/settings`, {
      method: 'PATCH', body: JSON.stringify({ retrieval: { topK: 5 } }), headers: { 'content-type': 'application/json' },
    }));
    expect(same.reindexing).toBe(0);
    // modelo de embedding inexistente é rejeitado na validação (não em runtime)
    const badModel = await app.request(`/api/workspaces/${workspace.id}/settings`, {
      method: 'PATCH', body: JSON.stringify({ embedModel: 'nao-existe' }), headers: { 'content-type': 'application/json' },
    });
    expect(badModel.status).toBe(400);
    expect((await json<{ error: { message: string } }>(badModel)).error.message).toMatch(/e5-small-q8/);
    const health = await json<{ embedModels: string[] }>(await app.request('/api/health'));
    expect(health.embedModels).toContain('e5-small-q8');
  });

  it('pipelineConfig parcial sobrescreve só o que foi enviado (não reseta as demais settings para os defaults)', async () => {
    await app.request(`/api/workspaces/${workspace.id}/settings`, {
      method: 'PATCH', body: JSON.stringify({ retrieval: { mode: 'bm25' } }), headers: { 'content-type': 'application/json' },
    });
    const search = (pipelineConfig?: object) => app.request(`/api/workspaces/${workspace.id}/search`, {
      method: 'POST', body: JSON.stringify({ query: 'prazo para envio da proposta', pipelineConfig }), headers: { 'content-type': 'application/json' },
    });
    const plain = await json<RetrievalResult>(await search());
    expect(plain.candidates.length).toBeGreaterThan(0);
    expect(plain.candidates.every((c) => c.denseRank === undefined)).toBe(true);
    // override de um campo só: o modo bm25 do workspace continua valendo
    const partial = await json<RetrievalResult>(await search({ retrieval: { candidates: 10, glossary: false } }));
    expect(partial.candidates.every((c) => c.denseRank === undefined)).toBe(true);
    expect(partial.candidates.length).toBeLessThanOrEqual(10);
    expect(partial.configHash).not.toBe(plain.configHash);
    const empty = await json<RetrievalResult>(await search({}));
    expect(empty.configHash).toBe(plain.configHash);
    // override inválido ainda é validado
    expect((await search({ retrieval: { topK: 0 } })).status).toBe(400);
    expect((await search({ embedModel: 'nao-existe' })).status).toBe(400);
    await app.request(`/api/workspaces/${workspace.id}/settings`, {
      method: 'PATCH', body: JSON.stringify({ retrieval: { mode: 'hybrid' } }), headers: { 'content-type': 'application/json' },
    });
  });

  it('POST /search devolve RetrievalResult com contexto do workspace (retificação antes do original)', async () => {
    const res = await app.request(`/api/workspaces/${workspace.id}/search`, {
      method: 'POST', body: JSON.stringify({ query: 'prazo para envio da proposta na Plataforma' }), headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const result = await json<RetrievalResult>(res);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.context.length).toBeLessThanOrEqual(5); // topK=5 (PATCH acima)
    const precedences = result.context.map((c) => c.precedence);
    expect([...precedences].sort((a, b) => b - a)).toEqual(precedences);
    expect(result.context.some((c) => c.documentId === avisoId)).toBe(true);
    expect(result.context.some((c) => c.documentId === editalId)).toBe(true);

    const scoped = await json<RetrievalResult>(await app.request(`/api/workspaces/${workspace.id}/search`, {
      method: 'POST', body: JSON.stringify({ query: 'prazo para envio da proposta', documentIds: [editalId], pipelineConfig: { retrieval: { mode: 'bm25', topK: 3 } } }), headers: { 'content-type': 'application/json' },
    }));
    expect(scoped.context.every((c) => c.documentId === editalId)).toBe(true);
    expect(scoped.context.length).toBeLessThanOrEqual(3);
    expect(scoped.candidates.every((c) => c.denseRank === undefined)).toBe(true);
  });

  it('POST /ask (mock) responde com citações válidas; full_context informa fitsInWindow; closed_book não cita', async () => {
    const ask = (body: object, headers: Record<string, string> = {}) =>
      app.request('/api/ask', { method: 'POST', body: JSON.stringify({ workspaceId: workspace.id, ...body }), headers: { 'content-type': 'application/json', ...headers } });

    const rag = await json<AnswerResult>(await ask({ question: 'Qual o prazo para envio da proposta?' }));
    expect(rag.mode).toBe('rag');
    expect(rag.provider).toBe('mock/mock-1');
    expect(rag.citations.length).toBeGreaterThan(0);
    expect(rag.invalidLabels).toEqual([]);
    expect(rag.retrieval?.context.length).toBeGreaterThan(0);
    for (const c of rag.citations) {
      expect(c.exists).toBe(true);
      expect(c.page).toBeGreaterThan(0);
      expect(rag.text).toContain(`[${c.label}]`);
    }

    const full = await json<AnswerResult>(await ask({ question: 'Qual o prazo para envio da proposta?', mode: 'full_context' }));
    expect(full.mode).toBe('full_context');
    expect(full.fitsInWindow).toBe(true);
    expect(full.promptVersion).toBe('baseline.v4');
    expect(full.citations.length).toBeGreaterThan(0);

    const closed = await json<AnswerResult>(await ask({ question: 'Qual o prazo?', mode: 'closed_book' }));
    expect(closed.mode).toBe('closed_book');
    expect(closed.citations).toEqual([]);

    // orçamento minúsculo → 413 com fitsInWindow=false (nunca trunca em silêncio)
    const tooLarge = await ask({ question: 'Qual o prazo?', mode: 'full_context', pipelineConfig: { retrieval: { contextBudgetChars: 1000 } } });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ fitsInWindow: false, error: { code: 'context_too_large' } });

    // headers X-LLM-* (BYOK) mudam o provedor; sem chave/modelo inválido → 400 de validação
    const byok = await json<AnswerResult>(await ask({ question: 'Qual o prazo?' }, { 'X-LLM-Provider': 'mock', 'X-LLM-Model': 'mock-lazy' }));
    expect(byok.model).toBe('mock-lazy');
    expect(byok.repaired).toBe(true);
    const badLlm = await ask({ question: 'Qual o prazo?' }, { 'X-LLM-Provider': 'anthropic' });
    expect(badLlm.status).toBe(400);

    // provedor que rejeita a chave (e a ecoa na resposta, como a OpenAI faz) → 502 llm_error com a chave redigida
    const upstream = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-SECRET123', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const port = (upstream.address() as { port: number }).port;
      const res = await ask({ question: 'Qual o prazo?' }, {
        'X-LLM-Provider': 'openai-compatible', 'X-LLM-Base-URL': `http://127.0.0.1:${port}/v1`, 'X-LLM-Model': 'gpt-x', 'X-LLM-Key': 'sk-SECRET123',
      });
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'llm_error' } });
      expect(text).not.toContain('SECRET123');
      expect(text).toContain('[redacted]');
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('harness: POST /eval/runs roda o padrão-ouro em segundo plano; GET lista/lê; DELETE apaga', async () => {
    fs.mkdirSync(config.evalDir, { recursive: true });
    fs.writeFileSync(path.join(config.evalDir, 'teste.csv'), [
      'id,workspace,topic,question,expected_item,expected_values,answerable',
      'e01,AGRIFAM-2026,prazos,Qual o prazo de execução dos projetos?,9,36,sim',
      `e02,${workspace.name},fora,Qual a taxa de juros do financiamento?,,,não`,
      'e03,,prazos,Qual o prazo para recurso?,13,10,sim',
    ].join('\n'), 'utf8');
    const files = await json<Array<{ file: string; count: number }>>(await app.request('/api/eval/questions'));
    expect(files).toContainEqual({ file: 'teste.csv', count: 3 });

    const post = (body: object) => app.request('/api/eval/runs', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await post({ workspaceId: workspace.id, questionsFile: 'nada.csv' })).status).toBe(404);
    expect((await post({ workspaceId: 'x', questionsFile: 'teste.csv' })).status).toBe(404);
    expect((await post({ workspaceId: workspace.id, questionsFile: '../teste.csv' })).status).toBe(400);
    expect((await post({ workspaceId: workspace.id, questionsFile: 'teste.csv', arms: ['rag_cosmico'] })).status).toBe(400);
    // sem workspace padrão, a pergunta e03 (coluna workspace vazia) não tem para onde ir
    expect(await json<{ error: { code: string } }>(await post({ questionsFile: 'teste.csv' }))).toMatchObject({ error: { code: 'workspace_required' } });
    fs.writeFileSync(path.join(config.evalDir, 'errado.csv'), ['id,workspace,question', 'x,Inexistente,Oi?'].join('\n'), 'utf8');
    expect((await post({ questionsFile: 'errado.csv' })).status).toBe(404);

    const arms = await json<Array<{ id: string; mode: string }>>(await app.request('/api/eval/arms'));
    expect(arms.map((a) => a.id)).toContain('rag_hybrid');

    // workspace padrão resolve e03 e filtra pelo edital (aqui só existe um, então entram as três); código e nome também resolvem
    const started = await post({ workspaceId: workspace.id, questionsFile: 'teste.csv', arms: ['rag_hybrid', 'rag_bm25', 'closed_book'], label: 'mock' });
    expect(started.status).toBe(202);
    const initial = await json<EvalRun>(started);
    expect(initial).toMatchObject({ status: 'running', label: 'mock', questionCount: 3, arms: ['rag_hybrid', 'rag_bm25', 'closed_book'], progress: { done: 0, total: 9 }, llm: { provider: 'mock/mock-1' }, workspaces: [{ id: workspace.id, name: workspace.name }] });
    expect(initial).not.toHaveProperty('grounding');

    let run = initial;
    for (let i = 0; i < 400 && run.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
      run = await json<EvalRun>(await app.request(`/api/eval/runs/${initial.id}`));
    }
    expect(run.status).toBe('done');
    expect(run.cases).toHaveLength(9);
    expect(run.progress).toEqual({ done: 9, total: 9 });
    const prazo = run.cases.find((c) => c.questionId === 'e01' && c.arm === 'rag_hybrid')!;
    expect(prazo).toMatchObject({ mode: 'rag', workspaceId: workspace.id, retrievalHit: true });
    expect(prazo.citations).toBeGreaterThan(0);
    expect(prazo.status).not.toBe('error');
    const bm25 = run.cases.find((c) => c.questionId === 'e01' && c.arm === 'rag_bm25')!;
    expect(bm25.status).not.toBe('error');
    const closed = run.cases.find((c) => c.questionId === 'e02' && c.arm === 'closed_book')!;
    expect(closed).toMatchObject({ mode: 'closed_book', retrievalHit: null, citedExpected: null, grounded: null });
    expect(run.summary.map((s) => s.arm)).toEqual(['rag_hybrid', 'rag_bm25', 'closed_book']);
    expect(run.summary[0]!.n).toBe(3);
    expect(run.byWorkspace).toHaveLength(1);
    expect(run.byWorkspace[0]).toMatchObject({ workspaceId: workspace.id, questions: 3 });
    expect(run.byWorkspace[0]!.summary[0]!.n).toBe(3);
    expect(fs.existsSync(path.join(config.evalRunsDir, `${run.id}.json`))).toBe(true);

    const list = await json<EvalRunSummary[]>(await app.request('/api/eval/runs'));
    expect(list.map((r) => r.id)).toContain(run.id);
    expect(list[0]).not.toHaveProperty('cases');

    // Retomada: simula uma execução interrompida (4 casos faltando, 1 com erro) e completa só o que falta, com o mesmo modelo.
    const file = path.join(config.evalRunsDir, `${run.id}.json`);
    const broken = { ...run, status: 'error', error: 'cota', cases: run.cases.slice(0, 5).map((c, i) => (i === 0 ? { ...c, status: 'error', correct: false } : c)) };
    fs.writeFileSync(file, JSON.stringify(broken));
    const mismatch = await app.request(`/api/eval/runs/${run.id}/resume`, { method: 'POST', headers: { 'x-llm-provider': 'mock', 'x-llm-model': 'mock-2' } });
    expect(mismatch.status).toBe(409);
    expect((await json<{ error: { code: string } }>(mismatch)).error.code).toBe('llm_mismatch');
    const resumed = await json<EvalRun>(await app.request(`/api/eval/runs/${run.id}/resume`, { method: 'POST' }));
    expect(resumed).toMatchObject({ id: run.id, status: 'running', progress: { done: 4, total: 9 } });
    run = resumed;
    for (let i = 0; i < 400 && run.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 25));
      run = await json<EvalRun>(await app.request(`/api/eval/runs/${run.id}`));
    }
    expect(run.status).toBe('done');
    expect(run.cases).toHaveLength(9);
    expect(run.cases.filter((c) => c.status === 'error')).toHaveLength(0);
    expect(run.cases.slice(0, 4).map((c) => c.questionId + c.arm)).toEqual(broken.cases.slice(1).map((c) => c.questionId + c.arm));
    expect((await app.request('/api/eval/runs/inexistente/resume', { method: 'POST' })).status).toBe(404);

    expect((await app.request(`/api/eval/runs/${run.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/eval/runs/${run.id}`)).status).toBe(404);
  });

  it('POST /chat cria a conversa, transmite o stream useChat e persiste user/assistant com citações', async () => {
    const res = await app.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Qual o prazo para envio da proposta?' }] }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const conversationId = res.headers.get('X-Conversation-Id');
    expect(conversationId).toBeTruthy();

    const text = await res.text();
    const parts = text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)) as { type: string; messageMetadata?: { conversationId?: string } });
    const types = parts.map((p) => p.type);
    expect(types[0]).toBe('start');
    // o useChat não lê headers: o id da conversa vai também no metadata do chunk start
    expect(parts[0]!.messageMetadata).toEqual({ conversationId });
    expect(types).toContain('text-delta');
    expect(types).toContain('data-retrieval');
    expect(types).toContain('data-citation');
    expect(types.at(-1)).toBe('finish');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);

    // a persistência acontece quando `result` resolve (logo após o fim do stream)
    await vi.waitFor(() => expect(q.listMessages(ctx.db, conversationId!)).toHaveLength(2), { timeout: 5000 });
    const conv = await json<{ id: string; title: string; messages: Array<{ role: string; content: string; citations: unknown[]; parts: unknown[] | null }> }>(
      await app.request(`/api/conversations/${conversationId}`),
    );
    expect(conv.title).toBe('Qual o prazo para envio da proposta?');
    expect(conv.messages[0]).toMatchObject({ role: 'user', content: 'Qual o prazo para envio da proposta?' });
    expect(conv.messages[1]!.role).toBe('assistant');
    expect(conv.messages[1]!.citations.length).toBeGreaterThan(0);
    expect(conv.messages[1]!.parts?.some((p) => (p as { type: string }).type === 'data-citation')).toBe(true);

    // segunda pergunta na mesma conversa (histórico via UIMessages anteriores)
    const follow = await app.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: workspace.id,
        conversationId,
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Qual o prazo para envio da proposta?' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: conv.messages[1]!.content }, { type: 'data-citation', data: { label: 'c_000000' } }] },
          { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'E a contrapartida?' }] },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(follow.status).toBe(200);
    expect(follow.headers.get('X-Conversation-Id')).toBe(conversationId);
    await follow.text();
    await vi.waitFor(() => expect(q.listMessages(ctx.db, conversationId!)).toHaveLength(4), { timeout: 5000 });

    // regenerate (DefaultChatTransport reenvia as mensagens sem a última resposta): a pergunta não é duplicada,
    // a resposta anterior é substituída e o histórico continua [Q, A, Q, A]
    const beforeRegen = q.listMessages(ctx.db, conversationId!);
    const regen = await app.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: workspace.id,
        conversationId,
        trigger: 'regenerate-message',
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Qual o prazo para envio da proposta?' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: conv.messages[1]!.content }] },
          { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'E a contrapartida?' }] },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(regen.status).toBe(200);
    await regen.text();
    await vi.waitFor(() => expect(q.listMessages(ctx.db, conversationId!).at(-1)!.id).not.toBe(beforeRegen.at(-1)!.id), { timeout: 5000 });
    const afterRegen = q.listMessages(ctx.db, conversationId!);
    expect(afterRegen.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(afterRegen[2]!.id).toBe(beforeRegen[2]!.id);

    // mensagem com role inválido → 400 (não 500)
    const badRole = await app.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, conversationId, messages: [{ id: 't', role: 'tool', parts: [] }, { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'oi' }] }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(badRole.status).toBe(400);
    // erro de preparação (documento integral grande demais) vira 413 como no /ask, antes de abrir o stream
    const tooLarge = await app.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, mode: 'full_context', pipelineConfig: { retrieval: { contextBudgetChars: 1000 } }, messages: [{ id: 'u9', role: 'user', parts: [{ type: 'text', text: 'Qual o prazo?' }] }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: 'context_too_large' } });
    expect(q.listMessages(ctx.db, conversationId!)).toHaveLength(4);

    const list = await json<Array<{ id: string }>>(await app.request(`/api/workspaces/${workspace.id}/conversations`));
    expect(list.map((c) => c.id)).toContain(conversationId);

    const wrongConv = await app.request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, conversationId: 'nao-existe', messages: [{ id: 'x', role: 'user', parts: [{ type: 'text', text: 'oi' }] }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(wrongConv.status).toBe(404);

    expect((await app.request(`/api/conversations/${conversationId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/conversations/${conversationId}`)).status).toBe(404);
  });

  it('/api/llm/defaults e /api/llm/test (mock)', async () => {
    const defaults = await json<{ kind: string; model: string; hasServerKey: boolean; claudeCli: { available: boolean } }>(await app.request('/api/llm/defaults'));
    expect(defaults).toMatchObject({ kind: 'mock', hasServerKey: false });
    expect(typeof defaults.claudeCli.available).toBe('boolean');
    expect(JSON.stringify(defaults)).not.toContain('apiKey');

    const viaBody = await json<{ ok: boolean; kind: string }>(await app.request('/api/llm/test', {
      method: 'POST', body: JSON.stringify({ config: { kind: 'mock', model: 'mock-1' } }), headers: { 'content-type': 'application/json' },
    }));
    expect(viaBody).toMatchObject({ ok: true, kind: 'mock' });

    const viaHeaders = await json<{ ok: boolean }>(await app.request('/api/llm/test', { method: 'POST', headers: { 'X-LLM-Provider': 'mock', 'X-LLM-Model': 'mock-1' } }));
    expect(viaHeaders.ok).toBe(true);

    const invalid = await app.request('/api/llm/test', { method: 'POST', body: JSON.stringify({ config: { kind: 'openai-compatible', model: 'x' } }), headers: { 'content-type': 'application/json' } });
    // sem baseURL o adaptador falha dentro do testConnection → ok=false (não é 500)
    expect(invalid.status).toBe(200);
    expect((await json<{ ok: boolean }>(invalid)).ok).toBe(false);
  });

  it('Docling fora do ar → documento failed com error parser_indisponivel e job failed com mensagem amigável', async () => {
    doclingUp = false;
    try {
      const res = await upload(app, workspace.id, 'novo.pdf', {}, Buffer.concat([PDF_BYTES, Buffer.from('% novo\n')]));
      expect(res.status).toBe(202);
      const id = (await json<{ document: { id: string } }>(res)).document.id;
      const job = await waitForJob(app, id);
      expect(job.status).toBe('failed');
      expect(job.stage).toBe('parse');
      expect(job.error).toContain('parser indisponível');
      const doc = q.getDocument(ctx.db, id)!;
      expect(doc.status).toBe('failed');
      expect(doc.error).toBe('parser_indisponivel');

      const health = await json<{ docling: boolean }>(await app.request('/api/health'));
      expect(health.docling).toBe(false);

      // reprocesso com o sidecar de volta
      doclingUp = true;
      const again = await app.request(`/api/documents/${id}/reprocess`, { method: 'POST' });
      expect(again.status).toBe(202);
      const done = await waitForJob(app, id);
      expect(done.status).toBe('done');

      const del = await app.request(`/api/documents/${id}`, { method: 'DELETE' });
      expect(del.status).toBe(204);
      expect(fs.existsSync(storage.uploadPath(id))).toBe(false);
      expect((await app.request(`/api/documents/${id}/status`)).status).toBe(404);
    } finally {
      doclingUp = true;
    }
  });

  it('apagar o workspace durante o parse não deixa artefatos órfãos nem job (a ingestão é abandonada em silêncio)', async () => {
    const ws = await json<Workspace>(await app.request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'efêmero' }), headers: { 'content-type': 'application/json' } }));
    doclingDelayMs = 150;
    try {
      const res = await upload(app, ws.id, 'efemero.pdf', {}, Buffer.concat([PDF_BYTES, Buffer.from('% efemero\n')]));
      const id = (await json<{ document: { id: string } }>(res)).document.id;
      // espera o parse começar (o Docling falso está "convertendo") e apaga tudo
      await vi.waitFor(() => expect(q.getJob(ctx.db, id)?.status).toBe('processing'), { timeout: 2000 });
      expect((await app.request(`/api/workspaces/${ws.id}`, { method: 'DELETE' })).status).toBe(204);
      // dá tempo de o Docling responder e o pipeline notar que o documento sumiu
      await new Promise((r) => setTimeout(r, 400));
      expect(fs.existsSync(storage.parsedJsonPath(id))).toBe(false);
      expect(fs.existsSync(storage.canonicalMdPath(id))).toBe(false);
      expect(q.getJob(ctx.db, id)).toBeNull();
      expect(ctx.db.prepare('select count(*) as n from chunks where document_id = ?').get(id)).toEqual({ n: 0 });
    } finally {
      doclingDelayMs = 0;
    }
  });

  it('DELETE do workspace remove documentos, embeddings e arquivos', async () => {
    const res = await app.request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(q.listWorkspaces(ctx.db).map((w) => w.id)).not.toContain(workspace.id);
    for (const id of [editalId, avisoId]) {
      expect(q.getDocument(ctx.db, id)).toBeNull();
      expect(fs.existsSync(storage.uploadPath(id))).toBe(false);
      expect(fs.existsSync(storage.canonicalMdPath(id))).toBe(false);
    }
    const vec = ctx.db.prepare('select count(*) as n from chunks_vec_e5_small_q8').get() as { n: number };
    expect(vec.n).toBe(0);
    expect(ctx.db.prepare('select count(*) as n from chunks').get()).toEqual({ n: 0 });
    expect((await app.request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
