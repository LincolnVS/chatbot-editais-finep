/**
 * Repositório SQL (db/queries.ts) sobre um banco ':memory:' com as migrações reais (FTS5 + vec0).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../src/db/sqlite.ts';
import * as q from '../src/db/queries.ts';
import { vecTableName } from '../src/embed/registry.ts';
import { DEFAULT_PIPELINE_CONFIG, chunkLabel, sha256, type ChunkDraft, type AnswerResult, type RetrievalResult } from '@editais/shared';

const MODEL = 'fake-4d';
const DIMS = 4;

function makeChunk(partial: Partial<ChunkDraft> & { documentId: string; workspaceId: string; chunkSetId: string; orderIndex: number; text: string }): ChunkDraft {
  const label = partial.label ?? chunkLabel(`${partial.documentId}:${partial.chunkSetId}:${partial.orderIndex}`);
  return {
    label,
    kind: 'item',
    level: 2,
    sectionPath: '',
    contextPrefix: '[Edital › seção]',
    charCount: partial.text.length,
    pageStart: 1,
    pageEnd: 1,
    bboxes: [{ page: 1, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2 }],
    charStart: 0,
    charEnd: partial.text.length,
    contentHash: sha256(partial.text),
    embed: true,
    ...partial,
  };
}

function vec(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

describe('db/queries', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  function seedWorkspace(name = 'W2 Subvenção Regional') {
    return q.createWorkspace(db, { name, callCode: 'MIB-R2-REG', settings: DEFAULT_PIPELINE_CONFIG });
  }

  function seedDocument(workspaceId: string, over: Partial<q.DocumentInsert> = {}) {
    return q.insertDocument(db, {
      workspaceId, docType: 'edital', docKind: 'edital_principal', title: 'Edital', filename: 'edital.pdf',
      sha256: sha256(over.title ?? 'edital'), sizeBytes: 1234, ...over,
    });
  }

  /** Documento pronto para retrieval com chunks já gravados. */
  function seedReadyDocument(workspaceId: string, chunks: Array<Partial<ChunkDraft> & { text: string }>, over: Partial<q.DocumentInsert> = {}) {
    const doc = seedDocument(workspaceId, over);
    const chunkSetId = `set-${doc.id.slice(-6)}`;
    const drafts = chunks.map((c, i) => makeChunk({ documentId: doc.id, workspaceId, chunkSetId, orderIndex: i, ...c }));
    const rowids = q.replaceChunks(db, doc.id, chunkSetId, drafts);
    q.updateDocument(db, doc.id, { status: 'ready', chunkSetId, indexedAt: new Date().toISOString() });
    return { doc, chunkSetId, drafts, rowids };
  }

  describe('workspaces', () => {
    it('cria, lista (com documentCount), lê, atualiza settings e apaga em cascata', () => {
      const ws = seedWorkspace();
      expect(ws.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(ws.agency).toBe('FINEP');
      expect(ws.callCode).toBe('MIB-R2-REG');
      expect(ws.settings).toEqual(DEFAULT_PIPELINE_CONFIG);
      expect(ws.documentCount).toBe(0);

      seedDocument(ws.id);
      expect(q.listWorkspaces(db)[0]?.documentCount).toBe(1);
      expect(q.getWorkspace(db, ws.id)?.documentCount).toBe(1);

      const settings = { ...DEFAULT_PIPELINE_CONFIG, retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, topK: 3 } };
      q.updateWorkspaceSettings(db, ws.id, settings);
      expect(q.getWorkspace(db, ws.id)?.settings.retrieval.topK).toBe(3);

      q.deleteWorkspace(db, ws.id);
      expect(q.getWorkspace(db, ws.id)).toBeNull();
      expect(q.listDocuments(db, ws.id)).toEqual([]);
    });

    it('getWorkspace devolve null para id inexistente', () => {
      expect(q.getWorkspace(db, 'nope')).toBeNull();
    });
  });

  describe('documents', () => {
    it('insere com defaults, aplica patch parcial e lista na ordem de criação', () => {
      const ws = seedWorkspace();
      const a = seedDocument(ws.id, { title: 'Regulamento' });
      const b = seedDocument(ws.id, { title: 'Aviso de rerratificação', docKind: 'aviso_rerratificacao', amendsDocumentId: a.id, versionLabel: '1a_rerratificacao' });

      expect(a.status).toBe('uploaded');
      expect(a.isCurrent).toBe(true);
      expect(a.precedence).toBe(1);
      expect(a.pageCount).toBeNull();
      expect(a.chunkCount).toBe(0);
      expect(b.precedence).toBe(2); // retificação prevalece
      expect(b.amendsDocumentId).toBe(a.id);
      expect(b.versionLabel).toBe('1a_rerratificacao');

      q.updateDocument(db, a.id, { status: 'processing', pageCount: 27, parserVersion: '2.126.0', isCurrent: false, error: null });
      q.updateDocument(db, a.id, {}); // no-op
      const a2 = q.getDocument(db, a.id)!;
      expect(a2.status).toBe('processing');
      expect(a2.pageCount).toBe(27);
      expect(a2.parserVersion).toBe('2.126.0');
      expect(a2.isCurrent).toBe(false);

      expect(q.listDocuments(db, ws.id).map((d) => d.title)).toEqual(['Regulamento', 'Aviso de rerratificação']);
      expect(q.getDocument(db, 'nope')).toBeNull();
    });

    it('listRetrievableDocuments filtra ready + is_current e por ids; lista vazia = todos', () => {
      const ws = seedWorkspace();
      const ready = seedReadyDocument(ws.id, [{ text: 'a' }]).doc;
      const ready2 = seedReadyDocument(ws.id, [{ text: 'b' }], { title: 'Anexo' }).doc;
      const processing = seedDocument(ws.id, { title: 'Processando' });
      const old = seedReadyDocument(ws.id, [{ text: 'c' }], { title: 'Antigo' }).doc;
      q.updateDocument(db, old.id, { isCurrent: false });

      const ids = (docs: { id: string }[]) => docs.map((d) => d.id).sort();
      expect(ids(q.listRetrievableDocuments(db, ws.id))).toEqual([ready.id, ready2.id].sort());
      expect(ids(q.listRetrievableDocuments(db, ws.id, []))).toEqual([ready.id, ready2.id].sort());
      expect(ids(q.listRetrievableDocuments(db, ws.id, [ready2.id, processing.id, old.id]))).toEqual([ready2.id]);
      expect(q.listRetrievableDocuments(db, 'outro-ws')).toEqual([]);

      const scope = q.getSearchScope(db, ws.id, [ready.id]);
      expect(scope.documentIds).toEqual([ready.id]);
      expect(scope.chunkSets).toEqual([{ documentId: ready.id, chunkSetId: expect.stringMatching(/^set-/) }]);
    });

    it('deleteDocument apaga chunks, FTS e embeddings', () => {
      const ws = seedWorkspace();
      const { doc, rowids, chunkSetId } = seedReadyDocument(ws.id, [{ text: 'contrapartida financeira' }]);
      const rowid = [...rowids.values()][0]!;
      q.upsertEmbeddings(db, MODEL, DIMS, [{ rowid, workspaceId: ws.id, vector: vec(1, 0, 0, 0) }]);
      expect(q.countChunks(db, doc.id, chunkSetId)).toBe(1);

      q.deleteDocument(db, doc.id);
      expect(q.getDocument(db, doc.id)).toBeNull();
      expect(q.countChunks(db, doc.id, chunkSetId)).toBe(0);
      expect(db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'contrapartida'`).get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT count(*) AS n FROM ${vecTableName(MODEL)}`).get()).toEqual({ n: 0 });
    });

    it('deleteDocument de um edital retificado: o aviso continua (precedence 2) e perde só a referência', () => {
      const ws = seedWorkspace();
      const edital = seedDocument(ws.id);
      const aviso = seedDocument(ws.id, { title: 'Aviso', docKind: 'aviso_rerratificacao', amendsDocumentId: edital.id });
      expect(aviso.precedence).toBe(2);
      expect(() => q.deleteDocument(db, edital.id)).not.toThrow();
      expect(q.getDocument(db, edital.id)).toBeNull();
      expect(q.getDocument(db, aviso.id)).toMatchObject({ amendsDocumentId: null, precedence: 2 });
    });

    it('índice único (workspace_id, sha256): o mesmo PDF não entra duas vezes no workspace, mas entra em outro', () => {
      const ws = seedWorkspace();
      const other = seedWorkspace('outro');
      seedDocument(ws.id, { sha256: 'abc' });
      expect(() => seedDocument(ws.id, { title: 'cópia', sha256: 'abc' })).toThrow(/UNIQUE/);
      expect(() => seedDocument(other.id, { sha256: 'abc' })).not.toThrow();
    });
  });

  describe('pages', () => {
    it('substitui e lê páginas ordenadas', () => {
      const ws = seedWorkspace();
      const doc = seedDocument(ws.id);
      q.replaceDocPages(db, doc.id, [{ page: 2, width: 595, height: 842, charCount: 10 }, { page: 1, width: 595, height: 842, charCount: 20 }]);
      expect(q.getDocPages(db, doc.id).map((p) => p.page)).toEqual([1, 2]);
      q.replaceDocPages(db, doc.id, [{ page: 1, width: 600, height: 800, charCount: 5 }]);
      expect(q.getDocPages(db, doc.id)).toEqual([{ page: 1, width: 600, height: 800, charCount: 5 }]);
    });
  });

  describe('chunks', () => {
    it('replaceChunks grava, mapeia label→rowid, sincroniza FTS por trigger e substitui o conjunto anterior', () => {
      const ws = seedWorkspace();
      const { doc, chunkSetId, drafts, rowids } = seedReadyDocument(ws.id, [
        { text: '6. DESPESAS APOIÁVEIS', kind: 'section', level: 1, itemNumber: '6', label: 'c_sec006', embed: false },
        { text: '6.5.5 Pagamento de pessoal: vedado o pagamento de salários.', itemNumber: '6.5.5', parentLabel: 'c_sec006', sectionPath: '6. DESPESAS APOIÁVEIS › 6.5' },
        { text: 'A submissão de propostas ocorre pela plataforma.', parentLabel: 'c_sec006' },
      ]);
      expect(rowids.size).toBe(3);
      expect([...rowids.keys()]).toEqual(drafts.map((d) => d.label));
      expect(q.countChunks(db, doc.id, chunkSetId)).toBe(3);

      const stored = q.listDocumentChunks(db, doc.id);
      expect(stored.map((c) => c.orderIndex)).toEqual([0, 1, 2]);
      const item = stored[1]!;
      expect(item).toMatchObject({
        rowid: rowids.get(item.label), label: drafts[1]!.label, documentId: doc.id, workspaceId: ws.id, chunkSetId,
        parentLabel: 'c_sec006', kind: 'item', itemNumber: '6.5.5', sectionPath: '6. DESPESAS APOIÁVEIS › 6.5',
        documentTitle: 'Edital', docType: 'edital', precedence: 1, embed: true,
        bboxes: [{ page: 1, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2 }],
      });
      expect(item.versionLabel).toBeUndefined();
      expect(item.heading).toBeUndefined();
      expect(stored[0]!.embed).toBe(false);
      expect(stored[0]!.parentLabel).toBeUndefined();

      expect(q.getChunkChildren(db, doc.id, chunkSetId, 'c_sec006').map((c) => c.orderIndex)).toEqual([1, 2]);
      expect(q.getChunksByRowids(db, [rowids.get(item.label)!, 999999]).map((c) => c.label)).toEqual([item.label]);
      expect(q.getChunksByLabels(db, ws.id, [item.label, 'c_nope']).map((c) => c.label)).toEqual([item.label]);
      expect(q.findChunkByItemNumber(db, doc.id, chunkSetId, '6.5.5')?.label).toBe(item.label);
      expect(q.findChunkByItemNumber(db, doc.id, chunkSetId, '9.9')).toBeNull();
      expect(q.listDocumentChunks(db, doc.id, 'outro-set')).toEqual([]);

      // FTS sincronizado por trigger
      const scope = q.getSearchScope(db, ws.id);
      expect(q.bm25Search(db, scope, 'submissão', 10).map((r) => r.rowid)).toEqual([rowids.get(drafts[2]!.label)]);

      // substituição do conjunto: rowids antigos somem, FTS acompanha
      const rowids2 = q.replaceChunks(db, doc.id, chunkSetId, [makeChunk({ documentId: doc.id, workspaceId: ws.id, chunkSetId, orderIndex: 0, text: 'Novo conteúdo sobre elegibilidade.' })]);
      expect(rowids2.size).toBe(1);
      expect(q.countChunks(db, doc.id, chunkSetId)).toBe(1);
      expect(q.listDocumentChunks(db, doc.id).map((c) => c.label)).toEqual([...rowids2.keys()]);
      expect(q.getChunksByLabels(db, ws.id, drafts.map((d) => d.label))).toEqual([]);
      expect(q.bm25Search(db, scope, 'submissão', 10)).toEqual([]);
      expect(q.bm25Search(db, scope, 'elegibilidade', 10)).toHaveLength(1);
    });

    it('getChunksByLabels só devolve o chunk_set vigente de documentos vigentes', () => {
      const ws = seedWorkspace();
      const { doc, drafts } = seedReadyDocument(ws.id, [{ text: 'vigente' }]);
      // outro chunk_set do mesmo documento (reindexação experimental) não é o vigente
      q.replaceChunks(db, doc.id, 'set-experimental', [makeChunk({ documentId: doc.id, workspaceId: ws.id, chunkSetId: 'set-experimental', orderIndex: 0, text: 'experimental', label: 'c_exp001' })]);
      expect(q.getChunksByLabels(db, ws.id, [drafts[0]!.label, 'c_exp001']).map((c) => c.label)).toEqual([drafts[0]!.label]);
      q.updateDocument(db, doc.id, { isCurrent: false });
      expect(q.getChunksByLabels(db, ws.id, [drafts[0]!.label])).toEqual([]);
    });
  });

  describe('embeddings + knnSearch', () => {
    it('ensureVecTable cria a tabela vec0 e registra em embedding_indexes (idempotente; dims divergentes falham)', () => {
      const table = q.ensureVecTable(db, MODEL, DIMS);
      expect(table).toBe(vecTableName(MODEL));
      expect(q.ensureVecTable(db, MODEL, DIMS)).toBe(table);
      expect(db.prepare(`SELECT model_id, table_name, dims FROM embedding_indexes`).all()).toEqual([{ model_id: MODEL, table_name: table, dims: DIMS }]);
      expect(() => q.ensureVecTable(db, MODEL, 8)).toThrow(/dims/);
    });

    it('upsertEmbeddings + knnSearch com pré-filtro por documento e embed=1; upsert sobrescreve; delete remove', () => {
      const ws = seedWorkspace();
      const a = seedReadyDocument(ws.id, [
        { text: 'prazo de envio', label: 'c_a00001' },
        { text: 'pai grande não embedado', label: 'c_a00002', embed: false, kind: 'section' },
      ], { title: 'Doc A' });
      const b = seedReadyDocument(ws.id, [{ text: 'contrapartida', label: 'c_b00001' }], { title: 'Doc B' });
      const ra1 = a.rowids.get('c_a00001')!;
      const ra2 = a.rowids.get('c_a00002')!;
      const rb1 = b.rowids.get('c_b00001')!;

      q.upsertEmbeddings(db, MODEL, DIMS, [
        { rowid: ra1, workspaceId: ws.id, vector: vec(1, 0, 0, 0) },
        { rowid: ra2, workspaceId: ws.id, vector: vec(1, 0, 0, 0) }, // embed=0 no chunks → nunca sai na busca
        { rowid: rb1, workspaceId: ws.id, vector: vec(0.9, 0.1, 0, 0) },
      ]);

      const all = q.knnSearch(db, MODEL, q.getSearchScope(db, ws.id), vec(1, 0, 0, 0), 10);
      expect(all.map((r) => r.rowid)).toEqual([ra1, rb1]);
      expect(all[0]!.distance).toBeCloseTo(0, 5);
      expect(all[1]!.distance).toBeGreaterThan(0);

      const onlyB = q.knnSearch(db, MODEL, q.getSearchScope(db, ws.id, [b.doc.id]), vec(1, 0, 0, 0), 10);
      expect(onlyB.map((r) => r.rowid)).toEqual([rb1]);

      // k limita
      expect(q.knnSearch(db, MODEL, q.getSearchScope(db, ws.id), vec(1, 0, 0, 0), 1).map((r) => r.rowid)).toEqual([ra1]);

      // upsert sobrescreve o vetor
      q.upsertEmbeddings(db, MODEL, DIMS, [{ rowid: rb1, workspaceId: ws.id, vector: vec(0, 0, 0, 1) }]);
      expect(q.knnSearch(db, MODEL, q.getSearchScope(db, ws.id), vec(0, 0, 0, 1), 1).map((r) => r.rowid)).toEqual([rb1]);
      expect(db.prepare(`SELECT count(*) AS n FROM ${vecTableName(MODEL)}`).get()).toEqual({ n: 3 });

      q.deleteEmbeddingsForRowids(db, MODEL, [rb1]);
      expect(q.knnSearch(db, MODEL, q.getSearchScope(db, ws.id), vec(0, 0, 0, 1), 10).map((r) => r.rowid)).toEqual([ra1]);

      // outro workspace (partition key) não enxerga
      const ws2 = seedWorkspace('outro');
      seedReadyDocument(ws2.id, [{ text: 'x' }]);
      expect(q.knnSearch(db, MODEL, q.getSearchScope(db, ws2.id), vec(1, 0, 0, 0), 10)).toEqual([]);

      // modelo sem índice → vazio; dims erradas → erro
      expect(q.knnSearch(db, 'sem-indice', q.getSearchScope(db, ws.id), vec(1, 0, 0, 0), 10)).toEqual([]);
      expect(() => q.knnSearch(db, MODEL, q.getSearchScope(db, ws.id), vec(1, 0), 10)).toThrow(/dims/);
      expect(() => q.upsertEmbeddings(db, MODEL, DIMS, [{ rowid: ra1, workspaceId: ws.id, vector: vec(1) }])).toThrow(/dims/);
    });

    it('deleteOtherChunkSets remove os conjuntos que não são o vigente (chunks, FTS e vec0)', () => {
      const ws = seedWorkspace();
      const { doc, chunkSetId, rowids } = seedReadyDocument(ws.id, [{ text: 'conjunto antigo' }]);
      q.upsertEmbeddings(db, MODEL, DIMS, [{ rowid: [...rowids.values()][0]!, workspaceId: ws.id, vector: vec(1, 0, 0, 0) }]);
      const rowids2 = q.replaceChunks(db, doc.id, 'set-novo', [makeChunk({ documentId: doc.id, workspaceId: ws.id, chunkSetId: 'set-novo', orderIndex: 0, text: 'conjunto novo' })]);
      q.upsertEmbeddings(db, MODEL, DIMS, [{ rowid: [...rowids2.values()][0]!, workspaceId: ws.id, vector: vec(0, 1, 0, 0) }]);
      q.updateDocument(db, doc.id, { chunkSetId: 'set-novo' });
      expect(q.deleteOtherChunkSets(db, doc.id, 'set-novo')).toBe(1);
      expect(q.countChunks(db, doc.id, chunkSetId)).toBe(0);
      expect(q.countChunks(db, doc.id, 'set-novo')).toBe(1);
      expect(db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'antigo'`).get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT count(*) AS n FROM ${vecTableName(MODEL)}`).get()).toEqual({ n: 1 });
      expect(q.deleteOtherChunkSets(db, doc.id, 'set-novo')).toBe(0);
    });

    it('replaceChunks limpa embeddings órfãos (rowid pode ser reutilizado pelo SQLite)', () => {
      const ws = seedWorkspace();
      const { doc, chunkSetId, rowids } = seedReadyDocument(ws.id, [{ text: 'antigo' }]);
      const oldRowid = [...rowids.values()][0]!;
      q.upsertEmbeddings(db, MODEL, DIMS, [{ rowid: oldRowid, workspaceId: ws.id, vector: vec(1, 0, 0, 0) }]);
      const rowids2 = q.replaceChunks(db, doc.id, chunkSetId, [makeChunk({ documentId: doc.id, workspaceId: ws.id, chunkSetId, orderIndex: 0, text: 'novo' })]);
      // o SQLite reutiliza o último rowid liberado → o vetor antigo NÃO pode sobreviver
      expect([...rowids2.values()][0]).toBe(oldRowid);
      expect(db.prepare(`SELECT count(*) AS n FROM ${vecTableName(MODEL)}`).get()).toEqual({ n: 0 });
      expect(() => q.upsertEmbeddings(db, MODEL, DIMS, [{ rowid: oldRowid, workspaceId: ws.id, vector: vec(0, 1, 0, 0) }])).not.toThrow();
    });

    it('cache de embeddings por (content_hash, model)', () => {
      q.putCachedEmbeddings(db, MODEL, DIMS, [{ contentHash: 'h1', vector: vec(1, 2, 3, 4) }, { contentHash: 'h2', vector: vec(0, 0, 0, 1) }]);
      q.putCachedEmbeddings(db, MODEL, DIMS, [{ contentHash: 'h1', vector: vec(9, 9, 9, 9) }]); // replace
      q.putCachedEmbeddings(db, 'outro-modelo', DIMS, [{ contentHash: 'h3', vector: vec(1, 1, 1, 1) }]);
      const got = q.getCachedEmbeddings(db, MODEL, ['h1', 'h2', 'h3', 'h4']);
      expect([...got.keys()].sort()).toEqual(['h1', 'h2']);
      expect(Array.from(got.get('h1')!)).toEqual([9, 9, 9, 9]);
      expect(got.get('h1')).toBeInstanceOf(Float32Array);
      expect(q.getCachedEmbeddings(db, MODEL, []).size).toBe(0);
    });
  });

  describe('bm25Search', () => {
    it('ignora acentos, casa identificadores como frase exata, neutraliza operadores e respeita o escopo', () => {
      const ws = seedWorkspace();
      const a = seedReadyDocument(ws.id, [
        { text: '6.5.5 Pagamento de pessoal: é vedado o pagamento de salários a servidores.', itemNumber: '6.5.5' },
        { text: 'A submissão da proposta deve ocorrer até 07/04/2026 pela plataforma.' },
        { text: '6.5.5.1 Excetuam-se as bolsas previstas no item 6.5.7.' },
        { text: 'Texto sem relação: base legal e disposições finais.' },
      ], { title: 'Doc A' });
      const b = seedReadyDocument(ws.id, [{ text: 'Outro documento fala de submissão e de prazos.' }], { title: 'Doc B' });
      const scope = q.getSearchScope(db, ws.id);
      const row = (r: { rowid: number }) => r.rowid;

      const comAcento = q.bm25Search(db, scope, 'submissão', 10).map(row);
      const semAcento = q.bm25Search(db, scope, 'SUBMISSAO', 10).map(row);
      expect(comAcento).toHaveLength(2);
      expect(semAcento).toEqual(comAcento);

      // identificador "6.5.5" → frase exata (sequência 6 5 5): casa o item 6.5.5 e o 6.5.5.1, nunca o 6.5.7 nem texto sem relação
      // (a preferência pelo identificador exato é do boost no retrieval híbrido, não do BM25)
      const ident = q.bm25Search(db, scope, 'o que diz o item 6.5.5?', 10);
      expect(ident.map(row).sort()).toEqual([a.rowids.get(a.drafts[0]!.label), a.rowids.get(a.drafts[2]!.label)].sort());
      expect(ident[0]!.score).toBeGreaterThan(ident[1]!.score); // score = -bm25: maior = melhor
      expect(q.bm25Search(db, scope, '6.5.7', 10).map(row)).toEqual([a.rowids.get(a.drafts[2]!.label)]);
      expect(q.bm25Search(db, scope, '5.5.6', 10)).toEqual([]);

      // data como frase; "prazos" (Doc B) também casa "prazo" pela variante de número
      const prazo = q.bm25Search(db, scope, 'prazo 07/04/2026', 10).map(row);
      expect(prazo).toContain(a.rowids.get(a.drafts[1]!.label));
      expect(prazo).toContain([...b.rowids.values()][0]);
      expect(q.bm25Search(db, scope, '07/04/2026', 10).map(row)).toEqual([a.rowids.get(a.drafts[1]!.label)]);

      // operadores/sintaxe FTS não quebram
      expect(() => q.bm25Search(db, scope, 'prazo AND OR NOT ( " * ^ : NEAR', 10)).not.toThrow();
      expect(q.bm25Search(db, scope, '"', 10)).toEqual([]);
      expect(q.bm25Search(db, scope, 'de o a', 10).length).toBeGreaterThanOrEqual(0); // só stopwords: ainda consulta

      // escopo por documento e k
      expect(q.bm25Search(db, q.getSearchScope(db, ws.id, [b.doc.id]), 'submissão', 10).map(row)).toEqual([[...b.rowids.values()][0]]);
      expect(q.bm25Search(db, scope, 'submissão', 1)).toHaveLength(1);
      expect(q.bm25Search(db, { workspaceId: ws.id, documentIds: [], chunkSets: [] }, 'submissão', 10)).toEqual([]);
    });

    it('toFtsQuery produz expressões seguras (com variantes singular/plural dos termos de conteúdo)', () => {
      expect(q.toFtsQuery('qual o prazo de submissão?')).toBe('"prazo" OR "prazos" OR "submissão" OR "submissões" OR "submissãos"');
      expect(q.toFtsQuery('item 6.5.5 e R$ 1.000,00 em 07/04/2026 da FINEP')).toBe('"6.5.5" OR "R$ 1.000,00" OR "07/04/2026" OR "item" OR "itens" OR "finep" OR "fineps"');
      expect(q.toFtsQuery('de o a')).toBe('"de"');
      expect(q.toFtsQuery('   ')).toBeNull();
      expect(q.toFtsQuery('AND OR NOT')).toBe('"and" OR "ands" OR "or" OR "not" OR "nots"');
    });

    it('numberVariants: singular ↔ plural em pt-BR (o FTS5 não faz stemming)', () => {
      expect(q.numberVariants('documentos')).toEqual(['documentos', 'documento']);
      expect(q.numberVariants('critério')).toEqual(['critério', 'critérios']);
      expect(q.numberVariants('editais')).toEqual(['editais', 'edital']);
      expect(q.numberVariants('itens')).toEqual(['itens', 'item']);
      expect(q.numberVariants('avaliação')).toEqual(['avaliação', 'avaliações', 'avaliaçãos']);
      expect(q.numberVariants('valores')).toEqual(['valores', 'valor', 'valore']);
      expect(q.numberVariants('de')).toEqual(['de']);
    });
  });

  describe('ingestion jobs', () => {
    it('upsertJob cria/atualiza preservando campos, getJob e listPendingJobs', () => {
      const ws = seedWorkspace();
      const doc = seedDocument(ws.id);
      const doc2 = seedDocument(ws.id, { title: 'outro' });
      expect(q.getJob(db, doc.id)).toBeNull();

      const created = q.upsertJob(db, doc.id, { stage: 'parse', status: 'queued' });
      expect(created).toMatchObject({ documentId: doc.id, stage: 'parse', status: 'queued', progress: 0, message: null, error: null, stageTimingsMs: {} });
      expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const processing = q.upsertJob(db, doc.id, { status: 'processing', progress: 0.3, message: 'Extraindo', pipelineHash: 'abc' });
      expect(processing).toMatchObject({ stage: 'parse', status: 'processing', progress: 0.3, message: 'Extraindo' });
      expect(db.prepare('SELECT attempts, pipeline_hash, started_at FROM ingestion_jobs WHERE document_id = ?').get(doc.id))
        .toMatchObject({ attempts: 1, pipeline_hash: 'abc', started_at: expect.any(String) });

      q.upsertJob(db, doc2.id, { status: 'processing' });
      expect(q.listPendingJobs(db).map((j) => j.documentId).sort()).toEqual([doc.id, doc2.id].sort());

      const done = q.upsertJob(db, doc.id, { stage: 'done', status: 'done', progress: 1, stageTimingsMs: { parse: 1200, embed: 800 } });
      expect(done.stageTimingsMs).toEqual({ parse: 1200, embed: 800 });
      expect(q.getJob(db, doc.id)).toEqual(done);
      expect(q.listPendingJobs(db).map((j) => j.documentId)).toEqual([doc2.id]);

      const failed = q.upsertJob(db, doc2.id, { status: 'failed', error: 'parser_indisponivel' });
      expect(failed.error).toBe('parser_indisponivel');
      expect(q.listPendingJobs(db)).toEqual([]);

      // cascade ao apagar o documento
      q.deleteDocument(db, doc.id);
      expect(q.getJob(db, doc.id)).toBeNull();
    });
  });

  describe('conversas, mensagens e citações', () => {
    it('persiste user/assistant com retrieval_run e citations numa transação', () => {
      const ws = seedWorkspace();
      const { doc, drafts, rowids } = seedReadyDocument(ws.id, [{ text: 'O prazo final é 07/04/2026.', itemNumber: '15.1', sectionPath: '15. CRONOGRAMA' }], { title: 'Edital W2', versionLabel: 'original' });
      const label = drafts[0]!.label;
      const rowid = rowids.get(label)!;

      const conv = q.createConversation(db, { workspaceId: ws.id, scope: { documentIds: [doc.id] }, providerLabel: 'mock', model: 'mock-1', pipelineConfig: DEFAULT_PIPELINE_CONFIG });
      expect(conv).toMatchObject({ workspaceId: ws.id, title: null, scope: { documentIds: [doc.id] }, mode: 'rag', providerLabel: 'mock', model: 'mock-1' });
      expect(conv.configHash).toMatch(/^[0-9a-f]{64}$/);
      expect(q.getConversation(db, conv.id)).toEqual(conv);
      expect(q.listConversations(db, ws.id)).toEqual([conv]);

      const user = q.insertUserMessage(db, conv.id, 'Qual o prazo final?', [{ type: 'text', text: 'Qual o prazo final?' }]);
      expect(user).toMatchObject({ conversationId: conv.id, role: 'user', content: 'Qual o prazo final?', parts: [{ type: 'text', text: 'Qual o prazo final?' }], citations: [], repaired: false, invalidLabels: [] });
      expect(q.getConversation(db, conv.id)?.title).toBe('Qual o prazo final?');

      const retrieval: RetrievalResult = {
        query: 'Qual o prazo final?', configHash: conv.configHash!,
        candidates: [{ label, chunkRowid: rowid, bm25Rank: 1, denseRank: 1, rrfScore: 0.03, selected: true }],
        context: q.getChunksByRowids(db, [rowid]), contextChars: 27, latencyMs: 12.4,
      };
      const result: AnswerResult = {
        mode: 'rag', status: 'partial', text: 'O prazo final é 07/04/2026 [c_abc123].', rawText: 'O prazo final é 07/04/2026 [c_abc123]. Sem referência.',
        grounding: { policy: 'strict', blocks: 2, cited: 1, removed: 1, unsupportedValues: [], issues: [{ kind: 'uncited', text: 'Sem referência.' }] },
        warnings: [{ code: 'blocks_removed', message: '1 trecho da resposta foi omitido por não ter referência nos documentos.' }],
        citations: [{
          ordinal: 1, label, chunkRowid: rowid, documentId: doc.id, documentTitle: 'Edital W2', docType: 'edital', versionLabel: 'original',
          page: 1, bboxes: [{ page: 1, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2 }], sectionPath: '15. CRONOGRAMA', itemNumber: '15.1',
          quote: 'O prazo final é 07/04/2026.', exists: true, hasSection: true,
        }],
        invalidLabels: ['c_zzz999'], repaired: true, retrieval, provider: 'mock', model: 'mock-1',
        usage: { inputTokens: 100, outputTokens: 20 }, latencyMs: 250.6, timings: { retrievalMs: 12, generationMs: 200, totalMs: 251 }, configHash: conv.configHash!, promptVersion: 'qa.v1',
      };
      const assistant = q.insertAssistantMessage(db, conv.id, result, [{ type: 'text', text: result.text }]);
      expect(assistant).toMatchObject({
        role: 'assistant', content: result.text, provider: 'mock', model: 'mock-1', mode: 'rag', usage: { inputTokens: 100, outputTokens: 20 },
        latencyMs: 251, fitsInWindow: null, repaired: true, invalidLabels: ['c_zzz999'], status: 'partial', rawContent: result.rawText,
        grounding: { policy: 'strict', blocks: 2, cited: 1, removed: 1 },
      });
      expect(assistant.retrievalRunId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(assistant.citations).toEqual(result.citations);

      const run = db.prepare('SELECT * FROM retrieval_runs WHERE id = ?').get(assistant.retrievalRunId) as Record<string, unknown>;
      expect(run).toMatchObject({ workspace_id: ws.id, query: 'Qual o prazo final?', config_hash: conv.configHash, context_chars: 27, latency_ms: 12 });
      expect(JSON.parse(run.scope_json as string)).toEqual({ documentIds: [doc.id] });
      expect(JSON.parse(run.candidates_json as string)).toEqual(retrieval.candidates);

      const messages = q.listMessages(db, conv.id);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(messages[1]!.citations).toEqual(result.citations);

      // baseline sem retrieval: retrievalRunId null, fitsInWindow gravado
      const baseline = q.insertAssistantMessage(db, conv.id, { ...result, mode: 'full_context', retrieval: undefined, citations: [], fitsInWindow: true });
      expect(baseline.retrievalRunId).toBeNull();
      expect(baseline.fitsInWindow).toBe(true);
      expect(baseline.citations).toEqual([]);

      expect(q.listConversations(db, ws.id)[0]!.updatedAt >= conv.updatedAt).toBe(true);
      expect(() => q.insertAssistantMessage(db, 'nope', result)).toThrow(/Conversa/);

      // id escolhido pelo chamador (o stream anuncia o id antes de gravar) e avaliação do usuário guardada com a mensagem
      const withId = q.insertAssistantMessage(db, conv.id, result, undefined, '01JXXXXXXXXXXXXXXXXXXXXXXX');
      expect(withId.id).toBe('01JXXXXXXXXXXXXXXXXXXXXXXX');
      expect(withId.feedback).toBeNull();
      expect(q.setMessageFeedback(db, conv.id, withId.id, 'up')).toBe(true);
      expect(q.listMessages(db, conv.id).find((m) => m.id === withId.id)?.feedback).toBe('up');
      expect(q.setMessageFeedback(db, conv.id, withId.id, null)).toBe(true);
      expect(q.listMessages(db, conv.id).find((m) => m.id === withId.id)?.feedback).toBeNull();
      expect(q.setMessageFeedback(db, conv.id, user.id, 'down')).toBe(false);
      expect(q.setMessageFeedback(db, 'outra', withId.id, 'down')).toBe(false);

      q.deleteConversation(db, conv.id);
      expect(q.getConversation(db, conv.id)).toBeNull();
      expect(q.listMessages(db, conv.id)).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM citations').get()).toEqual({ n: 0 });
    });
  });

  describe('settings', () => {
    it('get/set JSON', () => {
      expect(q.getSetting(db, 'demo')).toBeNull();
      q.setSetting(db, 'demo', { quota: 10, enabled: true });
      expect(q.getSetting<{ quota: number }>(db, 'demo')).toEqual({ quota: 10, enabled: true });
      q.setSetting(db, 'demo', 5);
      expect(q.getSetting(db, 'demo')).toBe(5);
    });
  });
});
