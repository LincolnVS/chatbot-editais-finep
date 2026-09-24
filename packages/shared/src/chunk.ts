import type { BBox } from './parsed-document.ts';

export type ChunkKind = 'section' | 'item' | 'alinea' | 'paragraph' | 'table' | 'table_row' | 'footnote' | 'fixed';

/** Chunk pronto para indexação (saída do chunker; ainda sem rowid do banco). */
export type ChunkDraft = {
  /** Rótulo estável `c_xxxxxx` = chunkLabel(documentId + chunkSetId + orderIndex). É o que o LLM cita. */
  label: string;
  documentId: string;
  workspaceId: string;
  chunkSetId: string;
  /** Rótulo do chunk-pai (seção inteira), quando existir. Pais têm `kind: 'section'` e podem não ser embedados se forem grandes. */
  parentLabel?: string;
  kind: ChunkKind;
  level: number;
  orderIndex: number;
  itemNumber?: string;
  sectionPath: string;
  heading?: string;
  /** Texto literal do chunk (o que é mostrado ao usuário e enviado ao LLM). */
  text: string;
  /** Prefixo de contexto determinístico: "[<título do doc> › <sectionPath>]" — concatenado ao texto no embedding e no BM25. */
  contextPrefix: string;
  charCount: number;
  pageStart: number;
  pageEnd: number;
  bboxes: BBox[];
  /** Offsets no `canonical.md` do documento. */
  charStart: number;
  charEnd: number;
  /** sha256(text) — chave do cache de embeddings. */
  contentHash: string;
  /** Pais grandes (> maxChars × 1,25 ≈ limite de 512 tokens do e5) ou com uma única folha não são embedados; continuam disponíveis para expansão folha→pai e para o BM25. */
  embed: boolean;
};

/** Chunk como sai do banco (com rowid) — usado no retrieval, no prompt e nas citações. */
export type StoredChunk = ChunkDraft & {
  rowid: number;
  documentTitle: string;
  docType: 'edital' | 'apoio';
  versionLabel?: string;
  precedence: number;
};
