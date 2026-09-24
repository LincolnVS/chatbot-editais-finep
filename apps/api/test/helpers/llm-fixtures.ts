/** Chunks realistas (trechos do edital FINEP "Desafios da Agricultura Familiar — ICT 2026") para os testes da camada de LLM. */
import type { StoredChunk, RetrievalResult, PipelineConfig, LlmConfig } from '@editais/shared';
import { DEFAULT_PIPELINE_CONFIG, configHash, chunkLabel } from '@editais/shared';

export const DOC_ID = '01JAGRIFAM0000000000000001';
export const DOC_TITLE = 'Chamada Pública Desafios da Agricultura Familiar — ICT 2026';
export const WORKSPACE_ID = '01JWORKSPACE000000000000001';

type ChunkSeed = {
  orderIndex: number;
  itemNumber?: string;
  sectionPath: string;
  heading?: string;
  text: string;
  page: number;
  kind?: StoredChunk['kind'];
  docType?: 'edital' | 'apoio';
  versionLabel?: string;
  precedence?: number;
  documentId?: string;
  documentTitle?: string;
};

export function makeChunk(seed: ChunkSeed): StoredChunk {
  const documentId = seed.documentId ?? DOC_ID;
  const chunkSetId = 'cs_agrifam_2026';
  const label = chunkLabel(`${documentId}:${chunkSetId}:${seed.orderIndex}`);
  return {
    label,
    documentId,
    workspaceId: WORKSPACE_ID,
    chunkSetId,
    kind: seed.kind ?? 'item',
    level: seed.itemNumber ? 1 + (seed.itemNumber.split('.').length - 1) : 1,
    orderIndex: seed.orderIndex,
    ...(seed.itemNumber !== undefined ? { itemNumber: seed.itemNumber } : {}),
    sectionPath: seed.sectionPath,
    ...(seed.heading !== undefined ? { heading: seed.heading } : {}),
    text: seed.text,
    contextPrefix: `[${seed.documentTitle ?? DOC_TITLE} › ${seed.sectionPath}]`,
    charCount: seed.text.length,
    pageStart: seed.page,
    pageEnd: seed.page,
    bboxes: [{ page: seed.page, x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.3 }],
    charStart: seed.orderIndex * 1000,
    charEnd: seed.orderIndex * 1000 + seed.text.length,
    contentHash: `hash_${seed.orderIndex}`,
    embed: true,
    rowid: 100 + seed.orderIndex,
    documentTitle: seed.documentTitle ?? DOC_TITLE,
    docType: seed.docType ?? 'edital',
    ...(seed.versionLabel !== undefined ? { versionLabel: seed.versionLabel } : {}),
    precedence: seed.precedence ?? 1,
  };
}

export const CHUNK_PRAZO = makeChunk({
  orderIndex: 41,
  itemNumber: '9.1',
  sectionPath: '9. PRAZO DE EXECUÇÃO',
  heading: '9. PRAZO DE EXECUÇÃO',
  page: 14,
  text: '9.1. O prazo de execução da proposta deverá ser de até 36 (trinta e seis) meses, prorrogável, justificadamente, a critério da Finep.',
});

export const CHUNK_RECURSO = makeChunk({
  orderIndex: 58,
  itemNumber: '13.2',
  sectionPath: '13. RECURSOS ADMINISTRATIVOS',
  heading: '13. RECURSOS ADMINISTRATIVOS',
  page: 20,
  text:
    '13.2. O prazo para interposição do recurso será de até 10 (dez) dias corridos a contar da data de divulgação do resultado preliminar de cada etapa no Portal da Finep na internet;\n' +
    '13.3. Considera-se prorrogado o prazo até o primeiro dia útil seguinte se o vencimento cair em dia em que não houver expediente ou este for encerrado antes da hora normal;',
});

export const CHUNK_CONTRAPARTIDA = makeChunk({
  orderIndex: 37,
  itemNumber: '8.5',
  sectionPath: '8. CONTRAPARTIDA',
  heading: '8. CONTRAPARTIDA',
  page: 14,
  text: '8.5. As propostas apresentadas por ICT federal ou instituição privada sem fins lucrativos, na qualidade de convenente, são isentas de contrapartida.',
});

export const CHUNK_CRONOGRAMA = makeChunk({
  orderIndex: 70,
  kind: 'table',
  sectionPath: '15. CRONOGRAMA',
  heading: 'Cronograma',
  page: 21,
  text:
    '| Fase | Data |\n' +
    '| --- | --- |\n' +
    '| Lançamento da Chamada | A partir de 24/03/2026 |\n' +
    '| Término do prazo para envio do Cadastro na Plataforma de Apoio e Financiamento | 19/06/2026 |\n' +
    '| Término do prazo para envio da proposta na Plataforma de Apoio e Financiamento | 26/06/2026 |\n' +
    '| Divulgação do Resultado Preliminar da Habilitação | A partir de 20/07/2026 |',
});

/** Parágrafo sem item nem seção (hasSection = false). */
export const CHUNK_SEM_SECAO = makeChunk({
  orderIndex: 2,
  kind: 'paragraph',
  sectionPath: '',
  page: 1,
  text: 'A Finep torna pública a presente Chamada Pública e convida as instituições interessadas a apresentarem propostas nos termos aqui estabelecidos.',
});

export const CONTEXT: StoredChunk[] = [CHUNK_PRAZO, CHUNK_RECURSO, CHUNK_CONTRAPARTIDA, CHUNK_CRONOGRAMA];

export function makeRetrieval(query: string, context: StoredChunk[], config: PipelineConfig = DEFAULT_PIPELINE_CONFIG): RetrievalResult {
  return {
    query,
    configHash: configHash(config),
    candidates: context.map((c, i) => ({ label: c.label, chunkRowid: c.rowid, bm25Rank: i + 1, denseRank: i + 1, rrfScore: 2 / (60 + i + 1), selected: true })),
    context,
    contextChars: context.reduce((sum, c) => sum + c.text.length, 0),
    latencyMs: 12,
  };
}

export const MOCK_LLM: LlmConfig = { kind: 'mock', model: 'mock-1' };
export const MOCK_LLM_LAZY: LlmConfig = { kind: 'mock', model: 'mock-lazy' };
export const MOCK_LLM_NO_CITATION: LlmConfig = { kind: 'mock', model: 'mock-no-citation' };

export async function fakeEmbedQuery(_text: string): Promise<Float32Array> {
  return new Float32Array(384).fill(0.05);
}
