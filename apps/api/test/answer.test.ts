import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { UIMessageChunk } from 'ai';
import type { DocumentSummary, LlmConfig, PipelineConfig } from '@editais/shared';
import { DEFAULT_PIPELINE_CONFIG, configHash } from '@editais/shared';
import type { Db } from '../src/db/sqlite.ts';
import { retrieve } from '../src/retrieval/hybrid.ts';
import { listRetrievableDocuments } from '../src/db/queries.ts';
import { storage } from '../src/storage.ts';
import type * as StorageModule from '../src/storage.ts';
import { answerOnce, answerStream, condenseQuestion, ContextTooLargeError, loadPrompt, parseSearchRequests, ragUserMessage, resolvePromptName } from '../src/llm/answer.ts';
import { UNSUPPORTED_FALLBACK } from '../src/llm/grounding.ts';
import { extractLabels } from '../src/llm/citations.ts';
import {
  CHUNK_PRAZO, CHUNK_RECURSO, CONTEXT, DOC_ID, DOC_TITLE, WORKSPACE_ID,
  MOCK_LLM, MOCK_LLM_LAZY, MOCK_LLM_NO_CITATION, fakeEmbedQuery, makeRetrieval,
} from './helpers/llm-fixtures.ts';

// retrieve() e listRetrievableDocuments() são de outras trilhas: aqui devolvem resultados fabricados.
vi.mock('../src/retrieval/hybrid.ts', () => ({ retrieve: vi.fn() }));
vi.mock('../src/db/queries.ts', () => ({ listRetrievableDocuments: vi.fn() }));
// storage aponta para uma pasta temporária (arquivos reais), sem tocar em data/.
vi.mock('../src/storage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  const os = await import('node:os');
  const path = await import('node:path');
  const nodeFs = await import('node:fs');
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'editais-llm-test-'));
  return {
    storage: {
      ...actual.storage,
      canonicalMdPath: (id: string) => path.join(dir, `${id}.canonical.md`),
      sectionsJsonPath: (id: string) => path.join(dir, `${id}.sections.json`),
    },
  };
});

const db = {} as unknown as Db;
const QUESTION = 'Qual é o prazo de execução da proposta?';

function withMode(mode: PipelineConfig['generation']['mode']): PipelineConfig {
  return { ...DEFAULT_PIPELINE_CONFIG, generation: { ...DEFAULT_PIPELINE_CONFIG.generation, mode } };
}

function baseInput(config: PipelineConfig = DEFAULT_PIPELINE_CONFIG) {
  return { db, workspaceId: WORKSPACE_ID, question: QUESTION, config, llm: MOCK_LLM, embedQuery: fakeEmbedQuery };
}

const DOC_SUMMARY: DocumentSummary = {
  id: DOC_ID, workspaceId: WORKSPACE_ID, docType: 'edital', docKind: 'edital_principal', title: DOC_TITLE,
  filename: 'agrifam_ict_2026.pdf', sizeBytes: 500_000, pageCount: 27, publishedAt: '2026-03-24', versionLabel: 'original',
  amendsDocumentId: null, precedence: 1, isCurrent: true, status: 'ready', error: null, parserVersion: 'docling 2.124.0',
  createdAt: '2026-09-13T00:00:00.000Z', indexedAt: '2026-09-13T00:01:00.000Z',
};

const CANONICAL_MD =
  '# Chamada Pública Desafios da Agricultura Familiar {#sec-titulo p=1}\n\n' +
  '## 9. PRAZO DE EXECUÇÃO {#sec-9 p=14}\n\n' +
  '9.1. O prazo de execução da proposta deverá ser de até 36 (trinta e seis) meses, prorrogável, justificadamente, a critério da Finep.\n\n' +
  '## 13. RECURSOS ADMINISTRATIVOS {#sec-13 p=20}\n\n' +
  '13.2. O prazo para interposição do recurso será de até 10 (dez) dias corridos a contar da data de divulgação do resultado preliminar.\n';

function writeCanonical(md: string = CANONICAL_MD): void {
  const sec9 = md.indexOf('## 9.');
  const sec13 = md.indexOf('## 13.');
  storage.writeText(storage.canonicalMdPath(DOC_ID), md);
  storage.writeText(
    storage.sectionsJsonPath(DOC_ID),
    JSON.stringify([
      { anchor: 'sec-titulo', heading: 'Chamada Pública Desafios da Agricultura Familiar', page: 1, charStart: 0, charEnd: sec9 },
      { anchor: 'sec-9', itemNumber: '9', heading: '9. PRAZO DE EXECUÇÃO', page: 14, charStart: sec9, charEnd: sec13 },
      { anchor: 'sec-13', itemNumber: '13', heading: '13. RECURSOS ADMINISTRATIVOS', page: 20, charStart: sec13, charEnd: md.length },
    ]),
  );
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

beforeEach(() => {
  vi.mocked(retrieve).mockReset();
  vi.mocked(retrieve).mockImplementation(async (input) => makeRetrieval(input.query, CONTEXT, input.config));
  vi.mocked(listRetrievableDocuments).mockReset();
  vi.mocked(listRetrievableDocuments).mockReturnValue([DOC_SUMMARY]);
});

afterAll(() => {
  const dir = storage.canonicalMdPath('x').replace(/[\\/][^\\/]+$/, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadPrompt / resolvePromptName', () => {
  it('carrega os três prompts e mapeia a família qa.vN por modo', () => {
    expect(loadPrompt('qa.v1')).toContain('<chunk>');
    expect(loadPrompt('baseline.v1')).toContain('{#sec-X p=N}');
    expect(loadPrompt('closed_book.v1')).toContain('NENHUM documento');
    expect(() => loadPrompt('inexistente.v9')).toThrow(/Prompt não encontrado/);
    // v4 = v3 + regra de revisão final das referências, nos dois modos com citação
    expect(loadPrompt('qa.v4')).toContain('REVISE');
    expect(loadPrompt('baseline.v4')).toContain('REVISE');
    expect(loadPrompt('closed_book.v4')).toBe(loadPrompt('closed_book.v3'));
    expect(resolvePromptName('rag', 'qa.v1')).toBe('qa.v1');
    expect(resolvePromptName('full_context', 'qa.v1')).toBe('baseline.v1');
    expect(resolvePromptName('closed_book', 'qa.v1')).toBe('closed_book.v1');
    expect(resolvePromptName('full_context', 'meu-prompt')).toBe('meu-prompt');
  });
});

describe('answerOnce — rag', () => {
  it('responde com o mock citando rótulos válidos do contexto recuperado', async () => {
    const result = await answerOnce(baseInput());

    expect(vi.mocked(retrieve)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(retrieve).mock.calls[0]![0]).toMatchObject({ workspaceId: WORKSPACE_ID, query: QUESTION, embedQuery: fakeEmbedQuery });

    expect(result.mode).toBe('rag');
    expect(result.repaired).toBe(false);
    expect(result.invalidLabels).toEqual([]);
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.citations.map((c) => c.label)).toEqual([CHUNK_PRAZO.label, CHUNK_RECURSO.label]);
    expect(result.citations[0]).toMatchObject({ ordinal: 1, page: 14, itemNumber: '9.1', documentTitle: DOC_TITLE, exists: true, hasSection: true });
    // O mock copia a primeira sentença do chunk entre aspas → o quote é exatamente ela.
    expect(result.citations[0]!.quote).toBe(CHUNK_PRAZO.text);
    expect(extractLabels(result.text)).toEqual([CHUNK_PRAZO.label, CHUNK_RECURSO.label]);
    expect(result.text.startsWith('Resposta simulada (modelo mock):')).toBe(true);

    expect(result.provider).toBe('mock/mock-1');
    expect(result.model).toBe('mock-1');
    expect(result.promptVersion).toBe('qa.v4');
    expect(result.status).toBe('answered');
    expect(result.grounding).toMatchObject({ policy: 'strict', removed: 0, unsupportedValues: [] });
    expect(result.warnings).toEqual([]);
    expect(result.configHash).toBe(configHash(DEFAULT_PIPELINE_CONFIG));
    expect(result.retrieval?.context).toHaveLength(CONTEXT.length);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.fitsInWindow).toBeUndefined();
  });

  it('modo dense não recebe o aviso de recuperação fraca (a busca léxica nem roda ali)', async () => {
    // Sem BM25 nenhum candidato tem bm25Rank; o aviso sairia em 100% das perguntas e o braço vetorial
    // rodaria com um prompt diferente dos demais.
    const semBm25 = (context: typeof CONTEXT) => ({
      ...makeRetrieval(QUESTION, context),
      candidates: context.map((c, i) => ({ label: c.label, chunkRowid: c.rowid, denseRank: i + 1, rrfScore: 1 / (60 + i + 1), selected: true })),
    });

    vi.mocked(retrieve).mockImplementation(async () => semBm25(CONTEXT));
    const dense = await answerOnce(baseInput({ ...DEFAULT_PIPELINE_CONFIG, retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, mode: 'dense' } }));
    expect(dense.warnings).toEqual([]);

    const hibrido = await answerOnce(baseInput());
    expect(hibrido.warnings.map((w) => w.code)).toEqual(['weak_retrieval']);
  });
  it('inclui o histórico antes da pergunta (o mock ainda encontra o contexto na última mensagem)', async () => {
    const result = await answerOnce({
      ...baseInput(),
      history: [
        { role: 'user', content: 'Olá' },
        { role: 'assistant', content: 'Olá! Como posso ajudar com o edital?' },
      ],
    });
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
  });

  it('modelo que não cita na primeira tentativa → reparo com sucesso (repaired=true, citações válidas)', async () => {
    const result = await answerOnce({ ...baseInput(), llm: MOCK_LLM_LAZY });
    expect(result.repaired).toBe(true);
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.invalidLabels).toEqual([]);
    expect(result.provider).toBe('mock/mock-lazy');
    // Duas chamadas ao modelo → uso acumulado maior que o de uma só.
    const single = await answerOnce(baseInput());
    expect(result.usage.inputTokens!).toBeGreaterThan(single.usage.inputTokens!);
  });

  it('reparo que também falha → nada citável: texto padrão de orientação e original preservado em rawText', async () => {
    const result = await answerOnce({ ...baseInput(), llm: MOCK_LLM_NO_CITATION });
    expect(result.repaired).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.status).toBe('unsupported');
    expect(result.text).toBe(UNSUPPORTED_FALLBACK);
    expect(result.rawText).toContain('não indica os trechos de origem');
  });

  it('contexto vazio → sem reparo e sem citações', async () => {
    vi.mocked(retrieve).mockImplementation(async (input) => makeRetrieval(input.query, []));
    const result = await answerOnce(baseInput());
    expect(result.repaired).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.retrieval?.context).toEqual([]);
  });
});

describe('busca extra dirigida pelo modelo', () => {
  const SEARCHER: LlmConfig = { kind: 'mock', model: 'mock-searcher' };
  const withSearch = { ...DEFAULT_PIPELINE_CONFIG, generation: { ...DEFAULT_PIPELINE_CONFIG.generation, extraSearch: true } };

  it('parseSearchRequests: só aceita a resposta que é apenas pedidos de busca (até 3, sem repetir)', () => {
    expect(parseSearchRequests('<buscar>prazo</buscar>\n<buscar>contrapartida</buscar>\n<buscar>prazo</buscar>')).toEqual(['prazo', 'contrapartida']);
    expect(parseSearchRequests('<buscar>anexo I</buscar><buscar>anexo II</buscar><buscar>anexo III</buscar><buscar>anexo IV</buscar>')).toEqual(['anexo I', 'anexo II', 'anexo III']);
    expect(parseSearchRequests('O prazo é de 36 meses [c_1]. Ver também <buscar>prorrogação</buscar> e o resto do texto longo que na verdade já é uma resposta ao usuário.')).toEqual([]);
    expect(parseSearchRequests('Resposta sem pedido.')).toEqual([]);
  });

  it('parseSearchRequests: depois da cobrança, a etiqueta vale mesmo com justificativa junto', () => {
    const comTexto = 'Vou procurar pelos termos que o edital usaria para tempo de constituição da empresa proponente: <buscar>registro na Junta Comercial</buscar>';
    expect(parseSearchRequests(comTexto)).toEqual([]);
    expect(parseSearchRequests(comTexto, false)).toEqual(['registro na Junta Comercial']);
  });

  it('ragUserMessage: a instrução de busca só aparece com extraSearch, e some depois de 2 rodadas', () => {
    expect(ragUserMessage(CONTEXT, QUESTION)).not.toContain('BUSCA EXTRA');
    expect(ragUserMessage(CONTEXT, QUESTION, false, { extraSearch: true })).toContain('<buscar>');
    const second = ragUserMessage(CONTEXT, QUESTION, false, { extraSearch: true, searched: ['prazo'] });
    expect(second).toContain('já realizada por: "prazo"');
    expect(second).toContain('<buscar>');
    const last = ragUserMessage(CONTEXT, QUESTION, false, { extraSearch: true, searched: ['prazo', 'anexo'] });
    expect(last).not.toContain('<buscar>');
    expect(last).toContain('Não há mais buscas');
  });

  it('o modelo pede buscas, elas rodam sem expansão, os trechos novos entram no contexto e a resposta sai citando', async () => {
    const extra = { ...CHUNK_RECURSO, label: 'c_ee0a01', rowid: 999, itemNumber: '9.2', text: '9.2. A prorrogação depende de justificativa aceita pela Finep.' };
    vi.mocked(retrieve).mockImplementation(async (input) => makeRetrieval(input.query, input.config.retrieval.queryExpansion === 0 ? [CHUNK_PRAZO, extra] : [CHUNK_PRAZO], input.config));
    const answer = await answerOnce({ ...baseInput(withSearch), llm: SEARCHER });
    const calls = vi.mocked(retrieve).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({ query: 'prazo de execução da proposta', variants: [] });
    expect(calls[1]!.config.retrieval).toMatchObject({ queryExpansion: 0, topK: 6 });
    expect(answer.extraSearches).toEqual(['prazo de execução da proposta', 'prorrogação do prazo']);
    expect(answer.retrieval?.context.map((c) => c.label)).toEqual([CHUNK_PRAZO.label, 'c_ee0a01']);
    expect(answer.retrieval?.candidates.filter((c) => c.selected)).toHaveLength(2);
    expect(answer.status).toBe('answered');
    expect(answer.text).not.toContain('<buscar>');
    expect(answer.citations.map((c) => c.label)).toEqual([CHUNK_PRAZO.label, 'c_ee0a01']);
    expect(answer.timings.searchMs).toBeGreaterThanOrEqual(0);
  });

  it('abstenção sem busca: o modelo é cobrado, pede busca e responde com o trecho novo', async () => {
    const extra = { ...CHUNK_RECURSO, label: 'c_ee0a01', rowid: 999, itemNumber: '9.2', text: '9.2. A prorrogação depende de justificativa aceita pela Finep.' };
    vi.mocked(retrieve).mockImplementation(async (input) => makeRetrieval(input.query, input.config.retrieval.queryExpansion === 0 ? [CHUNK_PRAZO, extra] : [CHUNK_PRAZO], input.config));
    const answer = await answerOnce({ ...baseInput(withSearch), llm: { kind: 'mock', model: 'mock-abstainer' } });
    expect(answer.extraSearches).toEqual(['prazo de execução da proposta', 'prorrogação do prazo']);
    expect(answer.status).toBe('answered');
    expect(answer.text).not.toMatch(/Não consta nos documentos/);
    expect(answer.citations.map((c) => c.label)).toContain('c_ee0a01');
  });

  it('abstenção sem busca, sem extraSearch: fica como está (nenhuma cobrança)', async () => {
    const answer = await answerOnce({ ...baseInput(), llm: { kind: 'mock', model: 'mock-abstainer' } });
    expect(vi.mocked(retrieve)).toHaveBeenCalledTimes(1);
    expect(answer.extraSearches).toBeUndefined();
    expect(answer.status).toBe('not_found');
  });

  it('sem extraSearch o mesmo modelo responde direto (a instrução não é oferecida)', async () => {
    const answer = await answerOnce({ ...baseInput(), llm: SEARCHER });
    expect(vi.mocked(retrieve)).toHaveBeenCalledTimes(1);
    expect(answer.extraSearches).toBeUndefined();
    expect(answer.status).toBe('answered');
  });

  it('no stream: data-stage marca a busca, o texto do pedido é descartado (reset-step) e o retrieval é reenviado', async () => {
    const { stream, result } = answerStream({ ...baseInput(withSearch), llm: SEARCHER });
    const chunks = await collect(stream);
    const stages = chunks.filter((c) => c.type === 'data-stage').map((c) => (c as { data: { stage: string; queries?: string[] } }).data);
    expect(stages.map((s) => s.stage)).toEqual(['generation', 'search', 'generation']);
    expect(stages[1]!.queries).toEqual(['prazo de execução da proposta', 'prorrogação do prazo']);
    expect(chunks.filter((c) => c.type === 'reset-step')).toHaveLength(1);
    expect(chunks.filter((c) => c.type === 'data-retrieval')).toHaveLength(2);
    const answer = await result;
    expect(answer.extraSearches).toHaveLength(2);
    expect(answer.text).not.toContain('<buscar>');
  });
});

describe('answerOnce — closed_book', () => {
  it('não recupera nada, usa closed_book.v1 e devolve texto sem citações', async () => {
    const result = await answerOnce(baseInput(withMode('closed_book')));
    expect(vi.mocked(retrieve)).not.toHaveBeenCalled();
    expect(result.mode).toBe('closed_book');
    expect(result.promptVersion).toBe('closed_book.v4');
    expect(result.retrieval).toBeUndefined();
    expect(result.citations).toEqual([]);
    expect(result.repaired).toBe(false);
    expect(result.text).toContain('Não há documentos no contexto');
  });
});

describe('answerOnce — full_context (baseline)', () => {
  it('envia o canonical.md e valida citações [sec-…] contra sections.json', async () => {
    writeCanonical();
    const result = await answerOnce(baseInput(withMode('full_context')));

    expect(vi.mocked(retrieve)).not.toHaveBeenCalled();
    expect(vi.mocked(listRetrievableDocuments)).toHaveBeenCalledWith(db, WORKSPACE_ID, undefined);
    expect(result.mode).toBe('full_context');
    expect(result.promptVersion).toBe('baseline.v4');
    expect(result.fitsInWindow).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.invalidLabels).toEqual([]);
    expect(result.citations.map((c) => c.label)).toEqual(['sec-titulo', 'sec-9']);
    expect(result.citations[1]).toMatchObject({ ordinal: 2, page: 14, itemNumber: '9', sectionPath: '9. PRAZO DE EXECUÇÃO', documentId: DOC_ID, hasSection: true, chunkRowid: 0 });
    expect(result.citations[1]!.quote).toMatch(/^9\.1\. O prazo de execução/);
    expect(result.text).toContain('[sec-9]');
  });

  it('documento maior que o orçamento → ContextTooLargeError (nunca trunca em silêncio)', async () => {
    writeCanonical();
    const config = withMode('full_context');
    config.retrieval = { ...config.retrieval, contextBudgetChars: 1000 };
    storage.writeText(storage.canonicalMdPath(DOC_ID), `${CANONICAL_MD}\n${'x'.repeat(13_000)}`);
    await expect(answerOnce(baseInput(config))).rejects.toBeInstanceOf(ContextTooLargeError);
    await expect(answerOnce(baseInput(config))).rejects.toMatchObject({ code: 'context_too_large', fitsInWindow: false, budget: 12_000 });
  });

  it('sem documentos prontos no escopo → erro explícito', async () => {
    vi.mocked(listRetrievableDocuments).mockReturnValue([]);
    await expect(answerOnce(baseInput(withMode('full_context')))).rejects.toThrow(/Nenhum documento pronto/);
  });
});

describe('answerStream', () => {
  it('transmite o texto em deltas e fecha com data-citation, data-retrieval e finish; result resolve', async () => {
    const { stream, result } = answerStream(baseInput());
    const chunks = await collect(stream);
    const types = chunks.map((c) => c.type);

    expect(types[0]).toBe('start');
    expect(types[1]).toBe('data-retrieval');
    expect(types.at(-1)).toBe('finish');
    expect(types).not.toContain('error');
    expect(types.filter((t) => t === 'text-delta').length).toBeGreaterThan(3);

    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta).join('');
    const citations = chunks.filter((c) => c.type === 'data-citation').map((c) => (c as { data: { label: string; ordinal: number } }).data);
    expect(citations.map((c) => c.label)).toEqual([CHUNK_PRAZO.label, CHUNK_RECURSO.label]);
    expect(citations[0]!.ordinal).toBe(1);

    const retrievalPart = chunks.find((c) => c.type === 'data-retrieval') as { data: Record<string, unknown> };
    expect(retrievalPart.data).toMatchObject({ configHash: configHash(DEFAULT_PIPELINE_CONFIG), latencyMs: 12 });
    expect(Array.isArray(retrievalPart.data.candidates)).toBe(true);
    expect(retrievalPart.data).not.toHaveProperty('context');

    const answer = await result;
    expect(answer.text).toBe(text);
    expect(answer.citations).toEqual(citations);
    expect(answer.repaired).toBe(false);
    expect(types).not.toContain('data-warning');
  });

  it('reparo no streaming: reset-step substitui o texto e as citações vêm do texto reparado', async () => {
    const { stream, result } = answerStream({ ...baseInput(), llm: MOCK_LLM_LAZY });
    const chunks = await collect(stream);
    const types = chunks.map((c) => c.type);

    const resetIndex = types.indexOf('reset-step');
    expect(resetIndex).toBeGreaterThan(0);
    const repairedText = chunks.slice(resetIndex).filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta).join('');
    expect(extractLabels(repairedText)).toEqual([CHUNK_PRAZO.label, CHUNK_RECURSO.label]);
    expect(types.filter((t) => t === 'data-citation')).toHaveLength(2);

    const answer = await result;
    expect(answer.repaired).toBe(true);
    expect(answer.text).toBe(repairedText);
  });

  it('sem citação após o reparo → gate strict troca o texto pela orientação padrão e avisa', async () => {
    const { stream, result } = answerStream({ ...baseInput(), llm: MOCK_LLM_NO_CITATION });
    const chunks = await collect(stream);
    const warning = chunks.find((c) => c.type === 'data-warning') as { data: { code: string } } | undefined;
    expect(warning?.data.code).toBe('blocks_removed');
    expect(chunks.map((c) => c.type)).toContain('reset-step');
    const status = chunks.find((c) => c.type === 'data-status') as { data: { status: string } } | undefined;
    expect(status?.data.status).toBe('unsupported');
    const answer = await result;
    expect(answer.citations).toEqual([]);
    expect(answer.repaired).toBe(true);
    expect(answer.text).toBe(UNSUPPORTED_FALLBACK);
    expect(answer.rawText).toContain('Resposta simulada');
  });

  it('expansão de consulta: as variantes do modelo vão ao retrieval e o uso da chamada extra soma ao total', async () => {
    const answer = await answerOnce(baseInput());
    const call = vi.mocked(retrieve).mock.calls[0]![0];
    expect(call.variants).toHaveLength(DEFAULT_PIPELINE_CONFIG.retrieval.queryExpansion);
    expect(call.variants![0]).toMatch(/^Reformulação simulada 1/);
    expect(answer.status).toBe('answered');
    expect(answer.warnings.map((w) => w.code)).not.toContain('expansion_failed');
    // com a expansão desligada o retrieval recebe lista vazia e não há chamada extra
    const semExpansao = { ...DEFAULT_PIPELINE_CONFIG, retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, queryExpansion: 0 } };
    const sem = await answerOnce(baseInput(semExpansao));
    expect(vi.mocked(retrieve).mock.calls[1]![0].variants).toEqual([]);
    expect(answer.usage.inputTokens!).toBeGreaterThan(sem.usage.inputTokens!);
  });

  it('política warn mantém o texto sem citação e só avisa', async () => {
    const config = { ...DEFAULT_PIPELINE_CONFIG, generation: { ...DEFAULT_PIPELINE_CONFIG.generation, grounding: 'warn' as const } };
    const answer = await answerOnce({ ...baseInput(config), llm: MOCK_LLM_NO_CITATION });
    expect(answer.status).toBe('unsupported');
    expect(answer.text).toContain('Resposta simulada');
    expect(answer.warnings.map((w) => w.code)).toEqual(['no_citation']);
  });

  it('retrieval vazio → resposta imediata de "não consta" sem chamar o modelo', async () => {
    vi.mocked(retrieve).mockResolvedValue(makeRetrieval(QUESTION, []));
    const semExpansao = { ...DEFAULT_PIPELINE_CONFIG, retrieval: { ...DEFAULT_PIPELINE_CONFIG.retrieval, queryExpansion: 0 } };
    const { stream, result } = answerStream(baseInput(semExpansao));
    const chunks = await collect(stream);
    const answer = await result;
    expect(answer.status).toBe('not_found');
    expect(answer.text).toMatch(/^Não consta nos documentos selecionados/);
    expect(answer.usage).toEqual({});
    expect(chunks.map((c) => c.type)).toEqual(['start', 'data-retrieval', 'text-start', 'text-delta', 'text-end', 'data-status', 'finish']);
  });

  it('follow-up curto herda a pergunta anterior na consulta de retrieval', async () => {
    const history = [{ role: 'user' as const, content: 'Qual é o prazo de execução da proposta?' }, { role: 'assistant' as const, content: '36 meses.' }];
    await answerOnce({ ...baseInput(), question: 'E o de recurso?', history });
    expect(vi.mocked(retrieve).mock.calls.at(-1)![0].query).toBe('Qual é o prazo de execução da proposta? E o de recurso?');
    expect(condenseQuestion('Quais documentos devem acompanhar a proposta?', history)).toEqual({ query: 'Quais documentos devem acompanhar a proposta?' });
    expect(condenseQuestion('Isso vale para ICT privada?', history).condensedFrom).toBe('Isso vale para ICT privada?');
  });

  it('provedor principal indisponível → provedor reserva responde e a resposta avisa', async () => {
    const failing: LlmConfig = { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:9', model: 'x' };
    const answer = await answerOnce({ ...baseInput(), llm: failing, llmFallback: MOCK_LLM });
    expect(answer.provider).toBe('mock/mock-1');
    expect(answer.fallbackFrom).toBe('openai-compatible(127.0.0.1:9)/x');
    expect(answer.warnings.map((w) => w.code)).toContain('fallback_provider');
    expect(answer.status).toBe('answered');
    // O SDK tenta o provedor que falha algumas vezes antes de cair no reserva; 5 s não bastam quando o arquivo roda sozinho.
  }, 20_000);

  it('erro na preparação → part error no stream e result rejeita', async () => {
    vi.mocked(retrieve).mockRejectedValue(new Error('índice indisponível'));
    const { stream, result } = answerStream(baseInput());
    const chunks = await collect(stream);
    const error = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    expect(error?.errorText).toContain('índice indisponível');
    await expect(result).rejects.toThrow('índice indisponível');
  });
});
