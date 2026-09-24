/** Pipeline de ingestão de um documento: parse → normalize → chunk → embed → index. */
import fs from 'node:fs';
import type { AppContext } from '../context.ts';
import type { ChunkDraft, DocumentSummary, IngestionJob, IngestionStage, PipelineConfig } from '@editais/shared';
import { chunkSetId as makeChunkSetId, configHash, sha256 } from '@editais/shared';
import * as q from '../db/queries.ts';
import { storage } from '../storage.ts';
import { DoclingUnavailableError, type DoclingDocumentJson } from './docling.ts';
import { buildCanonical, normalizeDocling } from './normalize.ts';
import { chunkDocument } from './chunker.ts';
import { extractGlossary } from './glossary-extract.ts';

export type IngestOptions = { force?: boolean; config?: PipelineConfig };

const PROGRESS = { parseReused: 0.3, normalize: 0.4, chunk: 0.5, embedStart: 0.5, embedEnd: 0.9, index: 0.95 } as const;
const UNKNOWN_PARSER_VERSION = 'docling@desconhecido';
const MAX_ERROR_CHARS = 500;

type ParseOutput = { json: DoclingDocumentJson; parseHash: string; parserVersion: string; reused: boolean };

/** O documento foi apagado enquanto um estágio assíncrono (Docling/embeddings) rodava. */
class DocumentRemovedError extends Error {
  constructor(documentId: string) {
    super(`Documento ${documentId} apagado durante a ingestão`);
    this.name = 'DocumentRemovedError';
  }
}

function assertStillExists(ctx: AppContext, documentId: string): void {
  if (!q.getDocument(ctx.db, documentId)) throw new DocumentRemovedError(documentId);
}

/** Estágio 1: JSON congelado do Docling (reutilizado quando já existe e não há `force`). */
async function parseStage(ctx: AppContext, doc: DocumentSummary, force: boolean): Promise<ParseOutput> {
  const jsonPath = storage.parsedJsonPath(doc.id);
  const existing = force ? null : storage.readText(jsonPath);
  if (existing !== null) {
    let parserVersion = doc.parserVersion;
    if (!parserVersion) {
      try {
        parserVersion = await ctx.docling.version();
      } catch (err) {
        if (!(err instanceof DoclingUnavailableError)) throw err;
        parserVersion = UNKNOWN_PARSER_VERSION;
      }
    }
    return { json: JSON.parse(existing) as DoclingDocumentJson, parseHash: sha256(existing), parserVersion, reused: true };
  }

  const pdfPath = storage.uploadPath(doc.id);
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF não encontrado em ${pdfPath}; envie o arquivo novamente.`);
  const parserVersion = await ctx.docling.version();
  const response = await ctx.docling.convertPdf(fs.readFileSync(pdfPath), doc.filename);
  assertStillExists(ctx, doc.id);
  const frozen = JSON.stringify(response.document.json_content);
  storage.writeText(jsonPath, frozen);
  return { json: JSON.parse(frozen) as DoclingDocumentJson, parseHash: sha256(frozen), parserVersion, reused: false };
}

type Embedder = ReturnType<AppContext['embedder']>;

/** Vetores dos chunks (cache por contentHash; textos idênticos são embedados uma vez só). */
async function embedStage(ctx: AppContext, documentId: string, embedder: Embedder, toEmbed: ChunkDraft[], onProgress: (done: number, total: number) => void): Promise<Map<string, Float32Array>> {
  const { db } = ctx;
  const log = ctx.log.child({ documentId });
  const modelId = embedder.spec.id;
  const vectors = q.getCachedEmbeddings(db, modelId, toEmbed.map((c) => c.contentHash));
  const cacheHits = vectors.size;
  const missing = new Map<string, string>();
  for (const c of toEmbed) if (!vectors.has(c.contentHash) && !missing.has(c.contentHash)) missing.set(c.contentHash, `${c.contextPrefix}\n${c.text}`);
  if (missing.size > 0) {
    const hashes = [...missing.keys()];
    const fresh = await embedder.embedPassages([...missing.values()], onProgress);
    assertStillExists(ctx, documentId);
    const entries = fresh.map((vector, i) => ({ contentHash: hashes[i]!, vector }));
    q.putCachedEmbeddings(db, modelId, embedder.spec.dims, entries);
    for (const e of entries) vectors.set(e.contentHash, e.vector);
    // Textos acima do limite do modelo são truncados pelo tokenizer: registrar quantos (estatística para a monografia).
    if (embedder.countTokens) {
      const tokens = await embedder.countTokens([...missing.values()]);
      const truncated = tokens.filter((t) => t > embedder.spec.maxTokens).length;
      if (truncated > 0) log.warn({ truncated, maxTokens: embedder.spec.maxTokens, maxSeen: Math.max(...tokens), modelId }, 'chunks acima do limite de tokens do modelo (truncados no embedding)');
    }
  }
  log.info({ embedded: missing.size, cacheHits, modelId, modelLoadMs: embedder.loadTimeMs() }, 'embeddings prontos');
  return vectors;
}

export async function ingestDocument(ctx: AppContext, documentId: string, opts: IngestOptions = {}): Promise<void> {
  const { db } = ctx;
  const log = ctx.log.child({ documentId });
  const doc = q.getDocument(db, documentId);
  if (!doc) throw new Error(`Documento não encontrado: ${documentId}`);
  const workspace = q.getWorkspace(db, doc.workspaceId);
  if (!workspace) throw new Error(`Workspace não encontrado: ${doc.workspaceId}`);
  const cfg = opts.config ?? workspace.settings;
  const pipelineHash = configHash(cfg);
  /** Conjunto de chunks vigente (documento já indexado): continua servindo o retrieval até ser substituído. */
  const currentChunkSetId = doc.status === 'ready' ? (q.getDocumentInternals(db, documentId)?.chunkSetId ?? null) : null;
  /** O chunk_set vigente foi apagado/reinserido nesta execução — a partir daí um erro deixa o índice inconsistente. */
  let indexTouched = false;

  const timings: Record<string, number> = {};
  const startedAt = performance.now();
  let stage: IngestionStage = 'parse';
  let stageStartedAt = startedAt;

  const publish = (patch: q.JobPatch): IngestionJob => {
    const job = q.upsertJob(db, documentId, { ...patch, stageTimingsMs: { ...timings }, pipelineHash });
    ctx.jobEvents.emit(`job:${documentId}`, job);
    return job;
  };
  /** Fecha o cronômetro do estágio corrente e abre o próximo. */
  const enter = (next: IngestionStage, progress: number, message: string): void => {
    timings[stage] = Math.round(performance.now() - stageStartedAt);
    stageStartedAt = performance.now();
    stage = next;
    publish({ stage: next, status: 'processing', progress, message });
  };

  // Documento já indexado continua 'ready' (o índice anterior segue no ar); o progresso é acompanhado pelo job.
  q.updateDocument(db, documentId, currentChunkSetId ? { error: null } : { status: 'processing', error: null });
  publish({ stage: 'parse', status: 'processing', progress: 0, message: 'extraindo texto e estrutura (Docling)', error: null });
  log.info({ force: opts.force === true, pipelineHash }, 'ingestão iniciada');

  try {
    // 1. parse
    const parse = await parseStage(ctx, doc, opts.force === true);
    const pageCount = Object.keys(parse.json.pages ?? {}).length;
    q.updateDocument(db, documentId, { parser: 'docling', parserVersion: parse.parserVersion, parseHash: parse.parseHash, pageCount });
    if (parse.reused) publish({ progress: PROGRESS.parseReused, message: 'parse reutilizado (JSON congelado)' });
    log.info({ reused: parse.reused, parserVersion: parse.parserVersion, pageCount }, 'parse concluído');

    // 2. normalize
    enter('normalize', PROGRESS.normalize, 'normalizando estrutura (seções, itens, tabelas)');
    const parsed = normalizeDocling(parse.json, { removeHeaderFooter: cfg.removeHeaderFooter, parserVersion: parse.parserVersion, fallbackTitle: doc.title });
    if (parsed.title !== doc.title) log.debug({ extractedTitle: parsed.title }, 'título extraído substituído pelo título do documento');
    parsed.title = doc.title;
    const canonical = buildCanonical(parsed);
    storage.writeText(storage.parsedDocPath(documentId), JSON.stringify(parsed));
    storage.writeText(storage.canonicalMdPath(documentId), canonical.markdown);
    storage.writeText(storage.sectionsJsonPath(documentId), JSON.stringify(canonical.sections));
    q.replaceDocPages(db, documentId, parsed.pages);
    q.updateDocument(db, documentId, { canonicalSha256: sha256(canonical.markdown), statsJson: JSON.stringify(parsed.stats), pageCount: parsed.pages.length });
    log.info({ ...parsed.stats, blocks: parsed.blocks.length }, 'normalização concluída');

    // 3. chunk
    enter('chunk', PROGRESS.chunk, 'gerando chunks');
    const chunkSetId = makeChunkSetId(parse.parseHash, cfg.chunking, cfg.removeHeaderFooter);
    const chunks = chunkDocument({ parsed, canonical, documentId, workspaceId: doc.workspaceId, chunkSetId, config: cfg.chunking });
    if (chunks.length === 0) throw new Error('O documento não produziu nenhum chunk (PDF sem texto extraível?)');
    if (chunkSetId === currentChunkSetId) indexTouched = true;
    const rowids = q.replaceChunks(db, documentId, chunkSetId, chunks);
    log.info({ chunkSetId, chunks: chunks.length, strategy: cfg.chunking.strategy }, 'chunks gravados');

    // 3b. glossário do documento: definições, siglas e "entende-se por" extraídos do próprio edital
    const glossario = extractGlossary(chunks.filter((c) => c.embed).map((c) => c.text).join('\n'));
    q.replaceGlossary(db, documentId, doc.workspaceId, chunkSetId, glossario);
    log.info({ termos: glossario.length }, 'glossário do documento extraído');

    // 4. embed
    const toEmbed = chunks.filter((c) => c.embed);
    enter('embed', PROGRESS.embedStart, `gerando embeddings (0/${toEmbed.length})`);
    const embedder = ctx.embedder(cfg.embedModel);
    const modelId = embedder.spec.id;
    const vectors = await embedStage(ctx, documentId, embedder, toEmbed, (done, total) => {
      const span = PROGRESS.embedEnd - PROGRESS.embedStart;
      publish({ progress: PROGRESS.embedStart + span * (done / total), message: `gerando embeddings (${done}/${total})` });
    });

    // 5. index
    enter('index', PROGRESS.index, 'indexando (vec0 + FTS5)');
    const rows = toEmbed.map((c) => ({ rowid: rowids.get(c.label)!, workspaceId: c.workspaceId, vector: vectors.get(c.contentHash)! }));
    const removedChunks = db.transaction(() => {
      q.upsertEmbeddings(db, modelId, embedder.spec.dims, rows);
      q.updateDocument(db, documentId, {
        status: 'ready', error: null, chunkSetId, pipelineHash, indexedAt: new Date().toISOString(),
        // retificação prevalece no contexto; o documento retificado continua vigente (só o rótulo muda)
        precedence: doc.amendsDocumentId ? 2 : 1,
      });
      // conjuntos de configs anteriores não são mais alcançáveis (e enviesariam as estatísticas globais do bm25)
      return q.deleteOtherChunkSets(db, documentId, chunkSetId);
    })();
    if (removedChunks > 0) log.info({ removedChunks }, 'chunk_sets de configs anteriores removidos');
    timings[stage] = Math.round(performance.now() - stageStartedAt);
    timings.total = Math.round(performance.now() - startedAt);
    publish({ stage: 'done', status: 'done', progress: 1, message: `pronto: ${chunks.length} chunks, ${toEmbed.length} embedados`, error: null });
    log.info({ totalMs: timings.total, timings }, 'ingestão concluída');
  } catch (err) {
    timings[stage] = Math.round(performance.now() - stageStartedAt);
    timings.total = Math.round(performance.now() - startedAt);
    if (err instanceof DocumentRemovedError || !q.getDocument(db, documentId)) {
      log.info({ stage }, 'documento apagado durante a ingestão; estágio abandonado');
      return;
    }
    const unavailable = err instanceof DoclingUnavailableError;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
    log.error({ err, stage }, `ingestão falhou no estágio ${stage}`);
    // Índice anterior intacto → o documento continua 'ready' (só registra o erro do reprocessamento).
    const keepReady = currentChunkSetId !== null && !indexTouched;
    q.updateDocument(db, documentId, { status: keepReady ? 'ready' : 'failed', error: unavailable ? 'parser_indisponivel' : message });
    publish({ stage, status: 'failed', progress: 0, message: null, error: message });
  }
}

/** Reindexa com outra configuração reaproveitando o JSON congelado do Docling (estágios 2–5). */
export function reindexDocument(ctx: AppContext, documentId: string, config: PipelineConfig): Promise<void> {
  return ingestDocument(ctx, documentId, { force: false, config });
}
