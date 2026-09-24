/** Repositório: todo acesso SQL passa por aqui. */
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type { Db } from './sqlite.ts';
import { vecToBlob, blobToVec } from './sqlite.ts';
import { vecTableName } from '../embed/registry.ts';
import { mergeGlossary } from '../ingest/glossary-extract.ts';
import type { GlossaryEntry } from '../ingest/glossary-extract.ts';
import { PipelineConfig, configHash } from '@editais/shared';
import type {
  ChunkDraft, StoredChunk, DocumentSummary, DocKind, DocType, IngestionJob, IngestionStage,
  PageInfo, ParsedDocument, Workspace, RetrievalResult, AnswerResult, AnswerStatus, Citation, GroundingReport, MessageFeedback } from '@editais/shared';

/* ---------- infra ---------- */

/** ULIDs monotônicos dentro do processo: ids gerados no mesmo milissegundo continuam ordenáveis. */
const ulid = monotonicFactory();

const stmtCache = new WeakMap<Db, Map<string, Database.Statement>>();

/** Prepared statement cacheado por conexão (chave = SQL). */
function stmt(db: Db, sql: string): Database.Statement {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

/** Tamanho de lote para listas `IN (...)` (SQLITE_MAX_VARIABLE_NUMBER = 32766 no better-sqlite3; 500 mantém o cache de statements pequeno). */
const IN_BATCH = 500;

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function now(): string {
  return new Date().toISOString();
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/* ---------- workspaces ---------- */
export type WorkspaceInsert = { name: string; agency?: string; callCode?: string; settings: PipelineConfig };

type WorkspaceRow = {
  id: string; name: string; agency: string; call_code: string | null; settings_json: string;
  created_at: string; updated_at: string; document_count?: number;
};

const WORKSPACE_SELECT = `
  SELECT w.*, (SELECT count(*) FROM documents d WHERE d.workspace_id = w.id) AS document_count
  FROM workspaces w`;

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    agency: row.agency,
    callCode: row.call_code,
    // parse com zod garante defaults para settings gravadas por versões anteriores do schema
    settings: PipelineConfig.parse(parseJson(row.settings_json, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    documentCount: row.document_count ?? 0,
  };
}

export function createWorkspace(db: Db, input: WorkspaceInsert): Workspace {
  const id = ulid();
  const ts = now();
  stmt(db, `INSERT INTO workspaces (id, name, agency, call_code, settings_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.name, input.agency ?? 'FINEP', input.callCode ?? null, JSON.stringify(input.settings), ts, ts);
  return getWorkspace(db, id)!;
}

export function listWorkspaces(db: Db): Workspace[] {
  return (stmt(db, `${WORKSPACE_SELECT} ORDER BY w.created_at DESC, w.id DESC`).all() as WorkspaceRow[]).map(rowToWorkspace);
}

export function getWorkspace(db: Db, id: string): Workspace | null {
  const row = stmt(db, `${WORKSPACE_SELECT} WHERE w.id = ?`).get(id) as WorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function updateWorkspaceSettings(db: Db, id: string, settings: PipelineConfig): void {
  stmt(db, `UPDATE workspaces SET settings_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(settings), now(), id);
}

export function deleteWorkspace(db: Db, id: string): void {
  db.transaction(() => {
    // vec0 não participa das FKs: limpar embeddings dos chunks do workspace antes do cascade.
    deleteVecRowsWhere(db, `SELECT rowid FROM chunks WHERE workspace_id = ?`, [id]);
    stmt(db, `DELETE FROM workspaces WHERE id = ?`).run(id);
  })();
}

/* ---------- documents ---------- */
export type DocumentInsert = {
  workspaceId: string; docType: DocType; docKind: DocKind; title: string; filename: string; mime?: string;
  sha256: string; sizeBytes: number; publishedAt?: string; versionLabel?: string; amendsDocumentId?: string;
};
export type DocumentPatch = Partial<{
  status: DocumentSummary['status']; error: string | null; pageCount: number; parser: string; parserVersion: string;
  parseHash: string; canonicalSha256: string; chunkSetId: string; pipelineHash: string; statsJson: string;
  indexedAt: string; isCurrent: boolean; precedence: number; title: string;
}>;

type DocumentRow = {
  id: string; workspace_id: string; doc_type: DocType; doc_kind: DocKind; title: string; filename: string; mime: string;
  sha256: string; size_bytes: number; page_count: number | null; published_at: string | null; version_label: string | null;
  amends_document_id: string | null; precedence: number; is_current: number; status: DocumentSummary['status'];
  error: string | null; parser: string | null; parser_version: string | null; parse_hash: string | null;
  canonical_sha256: string | null; chunk_set_id: string | null; pipeline_hash: string | null; stats_json: string | null;
  created_at: string; indexed_at: string | null; chunk_count?: number;
};

const DOCUMENT_SELECT = `
  SELECT d.*, (SELECT count(*) FROM chunks c WHERE c.document_id = d.id AND c.chunk_set_id = d.chunk_set_id) AS chunk_count
  FROM documents d`;

function rowToDocument(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    docType: row.doc_type,
    docKind: row.doc_kind,
    title: row.title,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    pageCount: row.page_count,
    publishedAt: row.published_at,
    versionLabel: row.version_label,
    amendsDocumentId: row.amends_document_id,
    precedence: row.precedence,
    isCurrent: row.is_current === 1,
    status: row.status,
    error: row.error,
    parserVersion: row.parser_version,
    chunkCount: row.chunk_count ?? 0,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
  };
}

export function insertDocument(db: Db, input: DocumentInsert): DocumentSummary {
  const id = ulid();
  stmt(db, `INSERT INTO documents (id, workspace_id, doc_type, doc_kind, title, filename, mime, sha256, size_bytes,
              published_at, version_label, amends_document_id, precedence, is_current, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'uploaded', ?)`)
    .run(
      id, input.workspaceId, input.docType, input.docKind, input.title, input.filename, input.mime ?? 'application/pdf',
      input.sha256, input.sizeBytes, input.publishedAt ?? null, input.versionLabel ?? null, input.amendsDocumentId ?? null,
      // retificação prevalece no contexto (precedence 2); o documento retificado continua vigente
      input.amendsDocumentId ? 2 : 1, now(),
    );
  return getDocument(db, id)!;
}

export function listDocuments(db: Db, workspaceId: string): DocumentSummary[] {
  return (stmt(db, `${DOCUMENT_SELECT} WHERE d.workspace_id = ? ORDER BY d.created_at ASC, d.id ASC`).all(workspaceId) as DocumentRow[])
    .map(rowToDocument);
}

export function getDocument(db: Db, id: string): DocumentSummary | null {
  const row = stmt(db, `${DOCUMENT_SELECT} WHERE d.id = ?`).get(id) as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

/** Documento com o mesmo conteúdo (sha256) dentro do workspace — dedupe do upload (409). */
export function findDocumentBySha256(db: Db, workspaceId: string, sha256: string): DocumentSummary | null {
  const row = stmt(db, `${DOCUMENT_SELECT} WHERE d.workspace_id = ? AND d.sha256 = ? ORDER BY d.created_at ASC, d.id ASC LIMIT 1`)
    .get(workspaceId, sha256) as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

/** Colunas internas que o DocumentSummary não expõe (pipeline e painel de detalhes/Transparência). */
export type DocumentInternals = {
  sha256: string; parseHash: string | null; canonicalSha256: string | null; chunkSetId: string | null; pipelineHash: string | null;
  stats: ParsedDocument['stats'] | null;
};

export function getDocumentInternals(db: Db, id: string): DocumentInternals | null {
  const row = stmt(db, `SELECT sha256, parse_hash, canonical_sha256, chunk_set_id, pipeline_hash, stats_json FROM documents WHERE id = ?`)
    .get(id) as Pick<DocumentRow, 'sha256' | 'parse_hash' | 'canonical_sha256' | 'chunk_set_id' | 'pipeline_hash' | 'stats_json'> | undefined;
  if (!row) return null;
  return {
    sha256: row.sha256,
    parseHash: row.parse_hash,
    canonicalSha256: row.canonical_sha256,
    chunkSetId: row.chunk_set_id,
    pipelineHash: row.pipeline_hash,
    stats: parseJson<ParsedDocument['stats'] | null>(row.stats_json, null),
  };
}

/** Mapa camelCase → coluna, para o UPDATE dinâmico. */
const DOCUMENT_PATCH_COLUMNS: Record<keyof DocumentPatch, string> = {
  status: 'status', error: 'error', pageCount: 'page_count', parser: 'parser', parserVersion: 'parser_version',
  parseHash: 'parse_hash', canonicalSha256: 'canonical_sha256', chunkSetId: 'chunk_set_id', pipelineHash: 'pipeline_hash',
  statsJson: 'stats_json', indexedAt: 'indexed_at', isCurrent: 'is_current', precedence: 'precedence', title: 'title',
};

export function updateDocument(db: Db, id: string, patch: DocumentPatch): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of Object.keys(patch) as Array<keyof DocumentPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${DOCUMENT_PATCH_COLUMNS[key]} = ?`);
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (sets.length === 0) return;
  params.push(id);
  stmt(db, `UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteDocument(db: Db, id: string): void {
  db.transaction(() => {
    deleteVecRowsWhere(db, `SELECT rowid FROM chunks WHERE document_id = ?`, [id]);
    // um aviso que retifica este documento continua existindo (e com precedence 2); só perde a referência (FK sem ON DELETE)
    stmt(db, `UPDATE documents SET amends_document_id = NULL WHERE amends_document_id = ?`).run(id);
    // chunks (e FTS via trigger), doc_pages e ingestion_jobs caem por ON DELETE CASCADE
    stmt(db, `DELETE FROM documents WHERE id = ?`).run(id);
  })();
}

/** Documentos elegíveis para retrieval: status=ready, is_current=1, filtrados por ids quando informado (lista vazia = todos). */
export function listRetrievableDocuments(db: Db, workspaceId: string, documentIds?: string[]): DocumentSummary[] {
  if (!documentIds || documentIds.length === 0) {
    return (stmt(db, `${DOCUMENT_SELECT} WHERE d.workspace_id = ? AND d.status = 'ready' AND d.is_current = 1
                      ORDER BY d.precedence DESC, d.created_at ASC, d.id ASC`).all(workspaceId) as DocumentRow[]).map(rowToDocument);
  }
  const out: DocumentSummary[] = [];
  for (const batch of chunked(documentIds, IN_BATCH)) {
    const rows = stmt(db, `${DOCUMENT_SELECT} WHERE d.workspace_id = ? AND d.status = 'ready' AND d.is_current = 1
                           AND d.id IN (${placeholders(batch.length)}) ORDER BY d.precedence DESC, d.created_at ASC, d.id ASC`)
      .all(workspaceId, ...batch) as DocumentRow[];
    out.push(...rows.map(rowToDocument));
  }
  return out;
}

/** Escopo de busca pronto para bm25Search/knnSearch: documentos elegíveis + chunk_set vigente de cada um. */
export function getSearchScope(db: Db, workspaceId: string, documentIds?: string[]): SearchScope {
  const docs = listRetrievableDocuments(db, workspaceId, documentIds);
  const chunkSets: SearchScope['chunkSets'] = [];
  for (const batch of chunked(docs.map((d) => d.id), IN_BATCH)) {
    const rows = stmt(db, `SELECT id, chunk_set_id FROM documents WHERE chunk_set_id IS NOT NULL AND id IN (${placeholders(batch.length)})`)
      .all(...batch) as Array<{ id: string; chunk_set_id: string }>;
    for (const r of rows) chunkSets.push({ documentId: r.id, chunkSetId: r.chunk_set_id });
  }
  return { workspaceId, documentIds: docs.map((d) => d.id), chunkSets };
}

/* ---------- pages ---------- */
export function replaceDocPages(db: Db, documentId: string, pages: PageInfo[]): void {
  db.transaction(() => {
    stmt(db, `DELETE FROM doc_pages WHERE document_id = ?`).run(documentId);
    const ins = stmt(db, `INSERT INTO doc_pages (document_id, page_number, width, height, char_count) VALUES (?, ?, ?, ?, ?)`);
    for (const p of pages) ins.run(documentId, p.page, p.width, p.height, p.charCount ?? 0);
  })();
}

export function getDocPages(db: Db, documentId: string): PageInfo[] {
  const rows = stmt(db, `SELECT page_number, width, height, char_count FROM doc_pages WHERE document_id = ? ORDER BY page_number`)
    .all(documentId) as Array<{ page_number: number; width: number; height: number; char_count: number }>;
  return rows.map((r) => ({ page: r.page_number, width: r.width, height: r.height, charCount: r.char_count }));
}

/* ---------- chunks ---------- */

type ChunkRow = {
  rowid: number; label: string; document_id: string; workspace_id: string; chunk_set_id: string; parent_label: string | null;
  kind: StoredChunk['kind']; level: number; order_index: number; item_number: string | null; section_path: string;
  heading: string | null; text: string; context_prefix: string; char_count: number; page_start: number; page_end: number;
  bboxes_json: string; char_start: number; char_end: number; content_hash: string; embed: number;
  document_title: string; doc_type: DocType; version_label: string | null; precedence: number;
};

const CHUNK_SELECT = `
  SELECT c.rowid AS rowid, c.*, d.title AS document_title, d.doc_type AS doc_type, d.version_label AS version_label, d.precedence AS precedence
  FROM chunks c JOIN documents d ON d.id = c.document_id`;

function rowToChunk(row: ChunkRow): StoredChunk {
  const chunk: StoredChunk = {
    rowid: row.rowid,
    label: row.label,
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    chunkSetId: row.chunk_set_id,
    kind: row.kind,
    level: row.level,
    orderIndex: row.order_index,
    sectionPath: row.section_path,
    text: row.text,
    contextPrefix: row.context_prefix,
    charCount: row.char_count,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    bboxes: parseJson(row.bboxes_json, []),
    charStart: row.char_start,
    charEnd: row.char_end,
    contentHash: row.content_hash,
    embed: row.embed === 1,
    documentTitle: row.document_title,
    docType: row.doc_type,
    precedence: row.precedence,
  };
  if (row.parent_label !== null) chunk.parentLabel = row.parent_label;
  if (row.item_number !== null) chunk.itemNumber = row.item_number;
  if (row.heading !== null) chunk.heading = row.heading;
  if (row.version_label !== null) chunk.versionLabel = row.version_label;
  return chunk;
}

/** Apaga chunks anteriores do mesmo (documento, chunkSetId) e insere os novos numa transação. Retorna rowid por label. */
export function replaceChunks(db: Db, documentId: string, chunkSetId: string, chunks: ChunkDraft[]): Map<string, number> {
  return db.transaction(() => {
    // rowids de chunks apagados podem ser reutilizados pelo SQLite → limpar embeddings órfãos antes.
    deleteVecRowsWhere(db, `SELECT rowid FROM chunks WHERE document_id = ? AND chunk_set_id = ?`, [documentId, chunkSetId]);
    stmt(db, `DELETE FROM chunks WHERE document_id = ? AND chunk_set_id = ?`).run(documentId, chunkSetId);
    const ins = stmt(db, `INSERT INTO chunks (label, document_id, workspace_id, chunk_set_id, parent_label, kind, level, order_index,
        item_number, section_path, heading, text, context_prefix, char_count, page_start, page_end, bboxes_json, char_start, char_end,
        content_hash, embed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const map = new Map<string, number>();
    for (const c of chunks) {
      const info = ins.run(
        c.label, documentId, c.workspaceId, chunkSetId, c.parentLabel ?? null, c.kind, c.level, c.orderIndex,
        c.itemNumber ?? null, c.sectionPath, c.heading ?? null, c.text, c.contextPrefix, c.charCount, c.pageStart, c.pageEnd,
        JSON.stringify(c.bboxes ?? []), c.charStart, c.charEnd, c.contentHash, c.embed ? 1 : 0,
      );
      map.set(c.label, Number(info.lastInsertRowid));
    }
    return map;
  })();
}

/** Remove os conjuntos de chunks do documento que não são o vigente (reindexação com outra config; FTS e vec0 acompanham). */
export function deleteOtherChunkSets(db: Db, documentId: string, keepChunkSetId: string): number {
  return db.transaction(() => {
    deleteVecRowsWhere(db, `SELECT rowid FROM chunks WHERE document_id = ? AND chunk_set_id <> ?`, [documentId, keepChunkSetId]);
    return stmt(db, `DELETE FROM chunks WHERE document_id = ? AND chunk_set_id <> ?`).run(documentId, keepChunkSetId).changes;
  })();
}

export function getChunksByRowids(db: Db, rowids: number[]): StoredChunk[] {
  const out: StoredChunk[] = [];
  for (const batch of chunked(rowids, IN_BATCH)) {
    const rows = stmt(db, `${CHUNK_SELECT} WHERE c.rowid IN (${placeholders(batch.length)})`).all(...batch) as ChunkRow[];
    out.push(...rows.map(rowToChunk));
  }
  return out;
}

/** Busca por rótulo dentro do workspace (só chunk_set vigente de documentos vigentes). */
export function getChunksByLabels(db: Db, workspaceId: string, labels: string[]): StoredChunk[] {
  const out: StoredChunk[] = [];
  for (const batch of chunked(labels, IN_BATCH)) {
    const rows = stmt(db, `${CHUNK_SELECT} WHERE c.workspace_id = ? AND d.is_current = 1 AND d.chunk_set_id = c.chunk_set_id
                           AND c.label IN (${placeholders(batch.length)}) ORDER BY c.document_id, c.order_index`)
      .all(workspaceId, ...batch) as ChunkRow[];
    out.push(...rows.map(rowToChunk));
  }
  return out;
}

export function listDocumentChunks(db: Db, documentId: string, chunkSetId?: string): StoredChunk[] {
  if (chunkSetId === undefined) {
    // chunk_set vigente do documento
    return (stmt(db, `${CHUNK_SELECT} WHERE c.document_id = ? AND c.chunk_set_id = d.chunk_set_id ORDER BY c.order_index`)
      .all(documentId) as ChunkRow[]).map(rowToChunk);
  }
  return (stmt(db, `${CHUNK_SELECT} WHERE c.document_id = ? AND c.chunk_set_id = ? ORDER BY c.order_index`)
    .all(documentId, chunkSetId) as ChunkRow[]).map(rowToChunk);
}

/** Filhos diretos de um chunk-pai (para expansão folha→pai e para T2b). */
export function getChunkChildren(db: Db, documentId: string, chunkSetId: string, parentLabel: string): StoredChunk[] {
  return (stmt(db, `${CHUNK_SELECT} WHERE c.document_id = ? AND c.chunk_set_id = ? AND c.parent_label = ? ORDER BY c.order_index`)
    .all(documentId, chunkSetId, parentLabel) as ChunkRow[]).map(rowToChunk);
}

export function countChunks(db: Db, documentId: string, chunkSetId: string): number {
  const row = stmt(db, `SELECT count(*) AS n FROM chunks WHERE document_id = ? AND chunk_set_id = ?`).get(documentId, chunkSetId) as { n: number };
  return row.n;
}

/* ---------- embeddings ---------- */

type EmbeddingIndexRow = { model_id: string; table_name: string; dims: number };

function getEmbeddingIndex(db: Db, modelId: string): EmbeddingIndexRow | null {
  return (stmt(db, `SELECT model_id, table_name, dims FROM embedding_indexes WHERE model_id = ?`).get(modelId) as EmbeddingIndexRow | undefined) ?? null;
}

/** Apaga, em TODAS as tabelas vec0 registradas, as linhas cujos chunk_rowid saem do subselect. */
function deleteVecRowsWhere(db: Db, subselect: string, params: unknown[]): void {
  const indexes = stmt(db, `SELECT model_id, table_name, dims FROM embedding_indexes`).all() as EmbeddingIndexRow[];
  for (const idx of indexes) {
    stmt(db, `DELETE FROM ${idx.table_name} WHERE chunk_rowid IN (${subselect})`).run(...params);
  }
}

/** Garante a tabela vec0 `chunks_vec_<modelId normalizado>` (`chunk_rowid INTEGER PRIMARY KEY, workspace_id TEXT PARTITION KEY, embedding FLOAT[dims]`). */
export function ensureVecTable(db: Db, modelId: string, dims: number): string {
  const existing = getEmbeddingIndex(db, modelId);
  if (existing) {
    if (existing.dims !== dims) {
      throw new Error(`Tabela vec0 de ${modelId} já existe com ${existing.dims} dims (pedido: ${dims})`);
    }
    return existing.table_name;
  }
  const table = vecTableName(modelId);
  db.transaction(() => {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
      chunk_rowid INTEGER PRIMARY KEY,
      workspace_id TEXT PARTITION KEY,
      embedding FLOAT[${dims}]
    )`);
    stmt(db, `INSERT OR IGNORE INTO embedding_indexes (model_id, table_name, dims, created_at) VALUES (?, ?, ?, ?)`)
      .run(modelId, table, dims, now());
  })();
  return table;
}

export function upsertEmbeddings(db: Db, modelId: string, dims: number, rows: Array<{ rowid: number; workspaceId: string; vector: Float32Array }>): void {
  if (rows.length === 0) return;
  const table = ensureVecTable(db, modelId, dims);
  db.transaction(() => {
    // vec0 não aceita INSERT OR REPLACE: upsert = DELETE + INSERT (chaves primárias como BigInt).
    const del = stmt(db, `DELETE FROM ${table} WHERE chunk_rowid = ?`);
    const ins = stmt(db, `INSERT INTO ${table} (chunk_rowid, workspace_id, embedding) VALUES (?, ?, ?)`);
    for (const r of rows) {
      if (r.vector.length !== dims) throw new Error(`Vetor do chunk ${r.rowid} tem ${r.vector.length} dims (esperado ${dims})`);
      del.run(BigInt(r.rowid));
      ins.run(BigInt(r.rowid), r.workspaceId, vecToBlob(r.vector));
    }
  })();
}

export function deleteEmbeddingsForRowids(db: Db, modelId: string, rowids: number[]): void {
  const idx = getEmbeddingIndex(db, modelId);
  if (!idx || rowids.length === 0) return;
  db.transaction(() => {
    for (const batch of chunked(rowids, IN_BATCH)) {
      stmt(db, `DELETE FROM ${idx.table_name} WHERE chunk_rowid IN (${placeholders(batch.length)})`).run(...batch.map((r) => BigInt(r)));
    }
  })();
}

export function getCachedEmbeddings(db: Db, modelId: string, contentHashes: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (const batch of chunked(contentHashes, IN_BATCH)) {
    const rows = stmt(db, `SELECT content_hash, vector FROM embedding_cache WHERE model_id = ? AND content_hash IN (${placeholders(batch.length)})`)
      .all(modelId, ...batch) as Array<{ content_hash: string; vector: Buffer }>;
    for (const r of rows) out.set(r.content_hash, blobToVec(r.vector));
  }
  return out;
}

export function putCachedEmbeddings(db: Db, modelId: string, dims: number, entries: Array<{ contentHash: string; vector: Float32Array }>): void {
  if (entries.length === 0) return;
  db.transaction(() => {
    const ins = stmt(db, `INSERT OR REPLACE INTO embedding_cache (content_hash, model_id, dims, vector, created_at) VALUES (?, ?, ?, ?, ?)`);
    const ts = now();
    for (const e of entries) ins.run(e.contentHash, modelId, dims, vecToBlob(e.vector), ts);
  })();
}

/* ---------- busca ---------- */
export type SearchScope = {
  workspaceId: string;
  /** Documentos elegíveis (já resolvidos por listRetrievableDocuments). */
  documentIds: string[];
  /** Pares (documentId → chunkSetId vigente). */
  chunkSets: Array<{ documentId: string; chunkSetId: string }>;
};

/** Subselect de rowids do escopo, agrupado por chunkSetId: `SELECT rowid FROM chunks WHERE (document_id IN (…) AND chunk_set_id = ?) OR (…)`. */
function scopeSubselect(scope: SearchScope, extraWhere = ''): { sql: string; params: unknown[] } | null {
  const bySet = new Map<string, string[]>();
  for (const pair of scope.chunkSets) {
    const list = bySet.get(pair.chunkSetId) ?? [];
    list.push(pair.documentId);
    bySet.set(pair.chunkSetId, list);
  }
  if (bySet.size === 0) return null;
  const groups: string[] = [];
  const params: unknown[] = [];
  for (const [chunkSetId, docIds] of bySet) {
    groups.push(`(document_id IN (${placeholders(docIds.length)}) AND chunk_set_id = ?)`);
    params.push(...docIds, chunkSetId);
  }
  return { sql: `SELECT rowid FROM chunks WHERE (${groups.join(' OR ')})${extraWhere}`, params };
}

/** KNN no vec0 com pré-filtro `chunk_rowid IN (subselect)` (vec0 NÃO aceita IN em colunas de metadados). Só chunks com embed=1. */
export function knnSearch(db: Db, modelId: string, scope: SearchScope, query: Float32Array, k: number): Array<{ rowid: number; distance: number }> {
  const idx = getEmbeddingIndex(db, modelId);
  const sub = scopeSubselect(scope, ' AND embed = 1');
  if (!idx || !sub || k <= 0) return [];
  if (query.length !== idx.dims) throw new Error(`Vetor de consulta tem ${query.length} dims; índice ${modelId} tem ${idx.dims}`);
  const rows = stmt(db, `SELECT chunk_rowid AS rowid, distance FROM ${idx.table_name}
                         WHERE embedding MATCH ? AND k = ? AND workspace_id = ? AND chunk_rowid IN (${sub.sql})
                         ORDER BY distance`)
    .all(vecToBlob(query), k, scope.workspaceId, ...sub.params) as Array<{ rowid: number | bigint; distance: number }>;
  return rows.map((r) => ({ rowid: Number(r.rowid), distance: r.distance }));
}

/** Padrões de identificador exato: valor ("R$ 1.000,00"), data ("07/04/2026"), item numerado ("6.5.5") e sigla (≥ 3 maiúsculas). */
export const IDENTIFIER_RE = /R\$\s?\d[\d.]*(?:,\d+)?|\d{1,2}\/\d{1,2}\/\d{2,4}|\d+(?:\.\d+)+|\b[A-ZÀ-Ü]{3,}\b/g;

/** Stopwords curtas do pt-BR: removidas da consulta BM25 quando sobra algum termo de conteúdo. */
const STOPWORDS = new Set([
  'a', 'o', 'e', 'é', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'uns', 'umas',
  'que', 'qual', 'quais', 'quem', 'como', 'quando', 'onde', 'por', 'para', 'pra', 'com', 'sem', 'se', 'ao', 'à', 'aos', 'às',
  'ou', 'mas', 'sobre', 'entre', 'ser', 'são', 'foi', 'está', 'estão', 'há', 'tem', 'têm', 'pelo', 'pela', 'pelos', 'pelas',
  'esse', 'essa', 'este', 'esta', 'isso', 'isto', 'aquele', 'aquela', 'me', 'meu', 'minha', 'seu', 'sua', 'ele', 'ela', 'eu',
]);

/** Variantes de número (singular ↔ plural) de um termo em pt-BR — o unicode61 não faz stemming e "documento" não casa "documentos". */
export function numberVariants(term: string): string[] {
  const out = new Set<string>([term]);
  const t = term;
  if (t.length < 3) return [...out];
  if (t.endsWith('ões') || t.endsWith('ãos')) out.add(`${t.slice(0, -3)}ão`);
  else if (t.endsWith('is') && t.length > 4) out.add(`${t.slice(0, -2)}l`);
  else if (t.endsWith('ns')) out.add(`${t.slice(0, -2)}m`);
  else if (t.endsWith('res') || t.endsWith('zes') || t.endsWith('ses')) {
    out.add(t.slice(0, -2));
    out.add(t.slice(0, -1));
  } else if (t.endsWith('s')) out.add(t.slice(0, -1));
  else if (t.endsWith('ão')) {
    out.add(`${t.slice(0, -2)}ões`);
    out.add(`${t.slice(0, -2)}ãos`);
  } else if (t.endsWith('l')) out.add(`${t.slice(0, -1)}is`);
  else if (t.endsWith('m')) out.add(`${t.slice(0, -1)}ns`);
  else if (t.endsWith('r') || t.endsWith('z')) out.add(`${t}es`);
  else out.add(`${t}s`);
  return [...out];
}

/** Converte texto livre numa expressão FTS5 segura (identificadores viram frases exatas). */
export function toFtsQuery(query: string): string | null {
  const phrases: string[] = [];
  const rest = query.replace(IDENTIFIER_RE, (m) => {
    // siglas são token único (ficam como termo comum); itens/datas/valores viram vários tokens no unicode61 → frase
    if (/^[A-ZÀ-Ü]{3,}$/.test(m)) return ` ${m} `;
    phrases.push(`"${m.replace(/"/g, '')}"`);
    return ' ';
  });
  const tokens = rest
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  const content = tokens.filter((t) => !STOPWORDS.has(t));
  const terms = (content.length > 0 ? content : tokens).flatMap((t) => (/^\p{N}+$/u.test(t) ? [t] : numberVariants(t))).map((t) => `"${t}"`);
  const all = [...new Set([...phrases, ...terms])];
  return all.length > 0 ? all.join(' OR ') : null;
}

/** Termo como frase exata para o índice léxico (o tokenizador já dobra acento e caixa). */
function ftsPhrase(termo: string): string | null {
  const tokens = termo.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  return tokens.length > 0 ? `"${tokens.join(' ')}"` : null;
}

/**
 * Dos termos oferecidos, os que aparecem literalmente nos documentos em escopo. É o que deixa o glossário do acervo ser
 * seguro: um edital pode ensinar que dois termos são irmãos, mas a expansão só entra se a palavra existir no documento
 * que está sendo buscado — senão é consulta com palavra que o texto não tem.
 */
export function attestedTerms(db: Db, scope: SearchScope, terms: string[]): Set<string> {
  const out = new Set<string>();
  const sub = scopeSubselect(scope);
  if (!sub) return out;
  const q = stmt(db, `SELECT 1 FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid IN (${sub.sql}) LIMIT 1`);
  for (const t of terms) {
    const frase = ftsPhrase(t);
    if (frase && q.get(frase, ...sub.params)) out.add(t);
  }
  return out;
}

/** BM25 via FTS5 sobre text+context_prefix. */
export function bm25Search(db: Db, scope: SearchScope, query: string, k: number): Array<{ rowid: number; score: number }> {
  const fts = toFtsQuery(query);
  const sub = scopeSubselect(scope);
  if (!fts || !sub || k <= 0) return [];
  const rows = stmt(db, `SELECT rowid, bm25(chunks_fts, 1.0, 0.5) AS s FROM chunks_fts
                         WHERE chunks_fts MATCH ? AND rowid IN (${sub.sql})
                         ORDER BY bm25(chunks_fts, 1.0, 0.5), rowid LIMIT ?`)
    .all(fts, ...sub.params, k) as Array<{ rowid: number; s: number }>;
  return rows.map((r) => ({ rowid: r.rowid, score: -r.s }));
}

/** Chunk cujo item_number bate exatamente (remissões "conforme item 6.10"). Prefere a folha ao chunk-seção. */
export function findChunkByItemNumber(db: Db, documentId: string, chunkSetId: string, itemNumber: string): StoredChunk | null {
  const row = stmt(db, `${CHUNK_SELECT} WHERE c.document_id = ? AND c.chunk_set_id = ? AND c.item_number = ?
                        ORDER BY (c.kind = 'section') ASC, c.order_index ASC LIMIT 1`)
    .get(documentId, chunkSetId, itemNumber) as ChunkRow | undefined;
  return row ? rowToChunk(row) : null;
}

/* ---------- ingestion jobs ---------- */
export type JobPatch = Partial<Pick<IngestionJob, 'stage' | 'status' | 'progress' | 'message' | 'error' | 'stageTimingsMs'>> & { pipelineHash?: string };

type JobRow = {
  document_id: string; stage: IngestionStage; status: IngestionJob['status']; progress: number; message: string | null;
  error: string | null; attempts: number; pipeline_hash: string | null; stage_timings_json: string; started_at: string | null;
  finished_at: string | null; updated_at: string;
};

function rowToJob(row: JobRow): IngestionJob {
  return {
    documentId: row.document_id,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    message: row.message,
    error: row.error,
    stageTimingsMs: parseJson(row.stage_timings_json, {}),
    updatedAt: row.updated_at,
  };
}

function getJobRow(db: Db, documentId: string): JobRow | null {
  return (stmt(db, `SELECT * FROM ingestion_jobs WHERE document_id = ?`).get(documentId) as JobRow | undefined) ?? null;
}

/** Cria ou atualiza o job do documento (campos ausentes no patch são preservados; stageTimingsMs é substituído inteiro). */
export function upsertJob(db: Db, documentId: string, patch: JobPatch): IngestionJob {
  return db.transaction(() => {
    const prev = getJobRow(db, documentId);
    const ts = now();
    const status = patch.status ?? prev?.status ?? 'queued';
    const startedProcessing = status === 'processing' && prev?.status !== 'processing';
    const finished = status === 'done' || status === 'failed';
    const row: JobRow = {
      document_id: documentId,
      stage: patch.stage ?? prev?.stage ?? 'parse',
      status,
      progress: patch.progress ?? prev?.progress ?? 0,
      message: patch.message !== undefined ? patch.message : (prev?.message ?? null),
      error: patch.error !== undefined ? patch.error : (prev?.error ?? null),
      attempts: (prev?.attempts ?? 0) + (startedProcessing ? 1 : 0),
      pipeline_hash: patch.pipelineHash ?? prev?.pipeline_hash ?? null,
      stage_timings_json: patch.stageTimingsMs ? JSON.stringify(patch.stageTimingsMs) : (prev?.stage_timings_json ?? '{}'),
      started_at: startedProcessing ? ts : (prev?.started_at ?? null),
      finished_at: finished ? ts : (prev?.finished_at ?? null),
      updated_at: ts,
    };
    stmt(db, `INSERT OR REPLACE INTO ingestion_jobs (document_id, stage, status, progress, message, error, attempts, pipeline_hash,
                stage_timings_json, started_at, finished_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.document_id, row.stage, row.status, row.progress, row.message, row.error, row.attempts, row.pipeline_hash,
        row.stage_timings_json, row.started_at, row.finished_at, row.updated_at);
    return rowToJob(row);
  })();
}

export function getJob(db: Db, documentId: string): IngestionJob | null {
  const row = getJobRow(db, documentId);
  return row ? rowToJob(row) : null;
}

/** Jobs `queued`/`processing` (para reenfileirar no boot). */
export function listPendingJobs(db: Db): IngestionJob[] {
  return (stmt(db, `SELECT * FROM ingestion_jobs WHERE status IN ('queued', 'processing') ORDER BY updated_at ASC`).all() as JobRow[])
    .map(rowToJob);
}

/* ---------- conversas ---------- */
export type ConversationRow = { id: string; workspaceId: string; title: string | null; scope: { documentIds?: string[] }; mode: string; providerLabel: string | null; model: string | null; configHash: string | null; createdAt: string; updatedAt: string };

type ConversationDbRow = {
  id: string; workspace_id: string; title: string | null; scope_json: string; mode: string; provider_label: string | null;
  model: string | null; pipeline_config_json: string | null; config_hash: string | null; created_at: string; updated_at: string;
};

function rowToConversation(row: ConversationDbRow): ConversationRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    scope: parseJson(row.scope_json, {}),
    mode: row.mode,
    providerLabel: row.provider_label,
    model: row.model,
    configHash: row.config_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createConversation(db: Db, input: { workspaceId: string; title?: string; scope?: { documentIds?: string[] }; mode?: string; providerLabel?: string; model?: string; pipelineConfig?: PipelineConfig }): ConversationRow {
  const id = ulid();
  const ts = now();
  stmt(db, `INSERT INTO conversations (id, workspace_id, title, scope_json, mode, provider_label, model, pipeline_config_json, config_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, input.workspaceId, input.title ?? null, JSON.stringify(input.scope ?? {}), input.mode ?? 'rag',
      input.providerLabel ?? null, input.model ?? null,
      input.pipelineConfig ? JSON.stringify(input.pipelineConfig) : null,
      input.pipelineConfig ? configHash(input.pipelineConfig) : null,
      ts, ts,
    );
  return getConversation(db, id)!;
}

export function getConversation(db: Db, id: string): ConversationRow | null {
  const row = stmt(db, `SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationDbRow | undefined;
  return row ? rowToConversation(row) : null;
}

export function listConversations(db: Db, workspaceId: string): ConversationRow[] {
  return (stmt(db, `SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC`).all(workspaceId) as ConversationDbRow[])
    .map(rowToConversation);
}

export function deleteConversation(db: Db, id: string): void {
  // messages e citations caem por ON DELETE CASCADE
  stmt(db, `DELETE FROM conversations WHERE id = ?`).run(id);
}

export type MessageRow = {
  id: string; conversationId: string; role: 'user' | 'assistant' | 'system'; content: string; parts: unknown[] | null; provider: string | null;
  model: string | null; mode: string | null; usage: unknown; latencyMs: number | null; retrievalRunId: string | null; fitsInWindow: boolean | null;
  repaired: boolean; invalidLabels: string[]; status: AnswerStatus | null; grounding: GroundingReport | null; rawContent: string | null;
  feedback: MessageFeedback; citations: Citation[]; createdAt: string;
};

type MessageDbRow = {
  id: string; conversation_id: string; role: MessageRow['role']; content: string; parts_json: string | null; provider: string | null;
  model: string | null; mode: string | null; usage_json: string | null; latency_ms: number | null; retrieval_run_id: string | null;
  fits_in_window: number | null; repaired: number; invalid_labels_json: string; status: string | null; grounding_json: string | null;
  raw_content: string | null; feedback: string | null; created_at: string;
};

type CitationDbRow = {
  id: string; message_id: string; ordinal: number; label: string; chunk_rowid: number; document_id: string; page: number;
  section_path: string; item_number: string | null; quote: string; bboxes_json: string; has_section: number;
  document_title: string | null; doc_type: DocType | null; version_label: string | null;
};

/** Citações com título/tipo/versão do documento (LEFT JOIN: o documento pode ter sido apagado depois). */
const CITATION_SELECT = `
  SELECT ct.*, d.title AS document_title, d.doc_type AS doc_type, d.version_label AS version_label
  FROM citations ct LEFT JOIN documents d ON d.id = ct.document_id`;

function rowToCitation(row: CitationDbRow): Citation {
  const citation: Citation = {
    ordinal: row.ordinal,
    label: row.label,
    chunkRowid: row.chunk_rowid,
    documentId: row.document_id,
    documentTitle: row.document_title ?? '',
    docType: row.doc_type ?? 'edital',
    page: row.page,
    bboxes: parseJson(row.bboxes_json, []),
    sectionPath: row.section_path,
    quote: row.quote,
    exists: true,
    hasSection: row.has_section === 1,
  };
  if (row.item_number !== null) citation.itemNumber = row.item_number;
  if (row.version_label !== null) citation.versionLabel = row.version_label;
  return citation;
}

function rowToMessage(row: MessageDbRow, citations: Citation[]): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    parts: parseJson<unknown[] | null>(row.parts_json, null),
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    usage: parseJson<unknown>(row.usage_json, null),
    latencyMs: row.latency_ms,
    retrievalRunId: row.retrieval_run_id,
    fitsInWindow: row.fits_in_window === null ? null : row.fits_in_window === 1,
    repaired: row.repaired === 1,
    invalidLabels: parseJson(row.invalid_labels_json, []),
    status: (row.status as AnswerStatus | null) ?? null,
    grounding: parseJson<GroundingReport | null>(row.grounding_json, null),
    rawContent: row.raw_content,
    feedback: row.feedback === 'up' || row.feedback === 'down' ? row.feedback : null,
    citations,
    createdAt: row.created_at,
  };
}

export function insertUserMessage(db: Db, conversationId: string, content: string, parts?: unknown[]): MessageRow {
  return db.transaction(() => {
    const id = ulid();
    const ts = now();
    stmt(db, `INSERT INTO messages (id, conversation_id, role, content, parts_json, created_at) VALUES (?, ?, 'user', ?, ?, ?)`)
      .run(id, conversationId, content, parts ? JSON.stringify(parts) : null, ts);
    // título da conversa = primeira pergunta (quando ainda não há título)
    stmt(db, `UPDATE conversations SET title = COALESCE(title, ?), updated_at = ? WHERE id = ?`)
      .run(content.trim().slice(0, 80), ts, conversationId);
    return getMessage(db, id)!;
  })();
}

/** Persiste resposta + retrieval_run + citations numa transação. */
export function insertAssistantMessage(db: Db, conversationId: string, result: AnswerResult, parts?: unknown[], id: string = ulid()): MessageRow {
  return db.transaction(() => {
    const conv = getConversation(db, conversationId);
    if (!conv) throw new Error(`Conversa não encontrada: ${conversationId}`);
    const ts = now();
    const retrievalRunId = result.retrieval ? insertRetrievalRun(db, conv.workspaceId, result.retrieval, conv.scope) : null;
    stmt(db, `INSERT INTO messages (id, conversation_id, role, content, parts_json, provider, model, mode, usage_json, latency_ms,
                retrieval_run_id, fits_in_window, repaired, invalid_labels_json, status, grounding_json, raw_content, created_at)
              VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, conversationId, result.text, parts ? JSON.stringify(parts) : null, result.provider, result.model, result.mode,
        JSON.stringify(result.usage ?? {}), Math.round(result.latencyMs), retrievalRunId,
        result.fitsInWindow === undefined ? null : (result.fitsInWindow ? 1 : 0),
        result.repaired ? 1 : 0, JSON.stringify(result.invalidLabels ?? []),
        result.status ?? null, result.grounding ? JSON.stringify(result.grounding) : null, result.rawText ?? null, ts,
      );
    const ins = stmt(db, `INSERT INTO citations (id, message_id, ordinal, label, chunk_rowid, document_id, page, section_path, item_number,
                            quote, bboxes_json, has_section, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of result.citations) {
      ins.run(ulid(), id, c.ordinal, c.label, c.chunkRowid, c.documentId, c.page, c.sectionPath, c.itemNumber ?? null,
        c.quote, JSON.stringify(c.bboxes ?? []), c.hasSection ? 1 : 0, ts);
    }
    stmt(db, `UPDATE conversations SET updated_at = ? WHERE id = ?`).run(ts, conversationId);
    return getMessage(db, id)!;
  })();
}

/** Apaga uma mensagem (citações caem por ON DELETE CASCADE) — usado ao regenerar a última resposta. */
/** Guarda a avaliação do usuário numa resposta (null limpa). Devolve false se a mensagem não existe na conversa. */
export function setMessageFeedback(db: Db, conversationId: string, messageId: string, feedback: MessageFeedback): boolean {
  const info = stmt(db, `UPDATE messages SET feedback = ? WHERE id = ? AND conversation_id = ? AND role = 'assistant'`).run(feedback, messageId, conversationId);
  return info.changes > 0;
}

export function deleteMessage(db: Db, id: string): void {
  stmt(db, `DELETE FROM messages WHERE id = ?`).run(id);
}

function getMessage(db: Db, id: string): MessageRow | null {
  const row = stmt(db, `SELECT * FROM messages WHERE id = ?`).get(id) as MessageDbRow | undefined;
  if (!row) return null;
  const citations = (stmt(db, `${CITATION_SELECT} WHERE ct.message_id = ? ORDER BY ct.ordinal`).all(id) as CitationDbRow[]).map(rowToCitation);
  return rowToMessage(row, citations);
}

export function listMessages(db: Db, conversationId: string): MessageRow[] {
  const rows = stmt(db, `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`).all(conversationId) as MessageDbRow[];
  const citationRows = stmt(db, `${CITATION_SELECT} JOIN messages m ON m.id = ct.message_id WHERE m.conversation_id = ? ORDER BY ct.ordinal`)
    .all(conversationId) as CitationDbRow[];
  const byMessage = new Map<string, Citation[]>();
  for (const c of citationRows) {
    const list = byMessage.get(c.message_id) ?? [];
    list.push(rowToCitation(c));
    byMessage.set(c.message_id, list);
  }
  return rows.map((r) => rowToMessage(r, byMessage.get(r.id) ?? []));
}

export function insertRetrievalRun(db: Db, workspaceId: string, result: RetrievalResult, scope: { documentIds?: string[] }): string {
  const id = ulid();
  stmt(db, `INSERT INTO retrieval_runs (id, workspace_id, query, scope_json, config_hash, candidates_json, context_chars, latency_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, result.query, JSON.stringify(scope ?? {}), result.configHash, JSON.stringify(result.candidates),
      result.contextChars, Math.round(result.latencyMs), now());
  return id;
}

/* ---------- settings ---------- */
export function getSetting<T>(db: Db, key: string): T | null {
  const row = stmt(db, `SELECT value_json FROM settings WHERE key = ?`).get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as T) : null;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  stmt(db, `INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)`).run(key, JSON.stringify(value));
}

/* ---------- glossário derivado do documento ---------- */

/** Substitui o glossário de um documento (roda no fim da ingestão, junto com o chunk_set vigente). */
export function replaceGlossary(db: Db, documentId: string, workspaceId: string, chunkSetId: string, entries: GlossaryEntry[]): void {
  db.transaction(() => {
    stmt(db, `DELETE FROM glossary_entries WHERE document_id = ?`).run(documentId);
    const ins = stmt(db, `INSERT INTO glossary_entries (document_id, workspace_id, chunk_set_id, term, aliases_json, kind, label)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const e of entries) ins.run(documentId, workspaceId, chunkSetId, e.term, JSON.stringify(e.aliases), e.kind, e.label);
  })();
}

/**
 * Glossário de todo o acervo já ingerido, menos os documentos passados (que entram pela carga normal). Editais da mesma
 * instituição repetem a terminologia, então o que um define serve de mapa para outro que usa a palavra sem definir —
 * é o caso do edital sem seção de definições. Só vale junto com `attestedTerms`.
 */
export function getCorpusGlossary(db: Db, exceptDocumentIds: string[], kinds?: GlossaryEntry['kind'][]): GlossaryEntry[] {
  if (kinds?.length === 0) return [];
  const rows = stmt(db, `SELECT g.document_id, g.term, g.aliases_json, g.kind, g.label FROM glossary_entries g
                         JOIN documents d ON d.id = g.document_id AND d.chunk_set_id = g.chunk_set_id
                         WHERE d.status = 'ready' AND d.is_current = 1
                         ${kinds ? `AND g.kind IN (${placeholders(kinds.length)})` : ''}`)
    .all(...(kinds ?? [])) as Array<{ document_id: string; term: string; aliases_json: string; kind: string; label: string | null }>;
  const fora = new Set(exceptDocumentIds);
  const out: GlossaryEntry[] = [];
  for (const r of rows) {
    if (fora.has(r.document_id)) continue;
    out.push({ term: r.term, aliases: JSON.parse(r.aliases_json) as string[], kind: r.kind as GlossaryEntry['kind'], label: r.label });
  }
  return mergeGlossary(out);
}

/** Glossário vigente dos documentos em escopo. */
export function getGlossary(db: Db, workspaceId: string, documentIds?: string[], kinds?: GlossaryEntry['kind'][]): GlossaryEntry[] {
  const docs = listRetrievableDocuments(db, workspaceId, documentIds).map((d) => d.id);
  if (docs.length === 0 || kinds?.length === 0) return [];
  const out: GlossaryEntry[] = [];
  for (const batch of chunked(docs, IN_BATCH)) {
    const rows = stmt(db, `SELECT g.term, g.aliases_json, g.kind, g.label FROM glossary_entries g
                           JOIN documents d ON d.id = g.document_id AND d.chunk_set_id = g.chunk_set_id
                           WHERE g.document_id IN (${placeholders(batch.length)})
                           ${kinds ? `AND g.kind IN (${placeholders(kinds.length)})` : ''}`)
      .all(...batch, ...(kinds ?? [])) as Array<{ term: string; aliases_json: string; kind: string; label: string | null }>;
    for (const r of rows) out.push({ term: r.term, aliases: JSON.parse(r.aliases_json) as string[], kind: r.kind as GlossaryEntry['kind'], label: r.label });
  }
  return out;
}
