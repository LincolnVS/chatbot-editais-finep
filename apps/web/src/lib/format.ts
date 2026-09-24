import type { DocKind, DocumentStatus, IngestionStage } from '@editais/shared';

export const DOC_KIND_LABELS: Record<DocKind, string> = {
  edital_principal: 'Edital / Chamada',
  regulamento: 'Regulamento',
  anexo: 'Anexo',
  faq: 'FAQ / Perguntas frequentes',
  aviso_rerratificacao: 'Aviso de rerratificação',
  edital_rerratificado: 'Edital rerratificado (consolidado)',
  cronograma_atualizado: 'Cronograma atualizado',
  comunicado: 'Comunicado',
  resultado: 'Resultado',
  guia: 'Guia / Manual',
  apoio_proposta: 'Apoio: proposta / projeto',
  apoio_empresa: 'Apoio: documentos da empresa',
  outro: 'Outro',
};

export const EDITAL_KINDS: DocKind[] = ['edital_principal', 'regulamento', 'anexo', 'faq', 'aviso_rerratificacao', 'edital_rerratificado', 'cronograma_atualizado', 'comunicado', 'resultado', 'guia', 'outro'];
export const APOIO_KINDS: DocKind[] = ['apoio_proposta', 'apoio_empresa', 'outro'];

/** Tipos que retificam/atualizam outro documento (pedem `amendsDocumentId` e ganham precedência maior). */
export const AMENDING_KINDS: DocKind[] = ['aviso_rerratificacao', 'edital_rerratificado', 'cronograma_atualizado', 'comunicado'];

export const STATUS_LABELS: Record<DocumentStatus, string> = { uploaded: 'na fila', processing: 'processando', ready: 'pronto', failed: 'falhou' };
export const STAGE_LABELS: Record<IngestionStage, string> = { parse: 'extraindo (Docling)', normalize: 'normalizando', chunk: 'segmentando', embed: 'embeddings', index: 'indexando', done: 'concluído' };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function truncate(s: string, n = 120): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}
