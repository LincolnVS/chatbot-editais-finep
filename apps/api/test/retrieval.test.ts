/** Retrieval híbrido em banco em memória com um embedder fake determinístico. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../src/db/sqlite.ts';
import * as q from '../src/db/queries.ts';
import { retrieve, extractIdentifiers } from '../src/retrieval/hybrid.ts';
import { glossaryTerms, glossaryVariants } from '../src/retrieval/glossary.ts';
import { DEFAULT_PIPELINE_CONFIG, PipelineConfig, sha256, configHash, type ChunkDraft } from '@editais/shared';

const MODEL = 'fake-32d';
const DIMS = 32;

/** Embedder falso: cada palavra (sem acento, minúscula) incrementa a posição hash(palavra) mod DIMS; vetor normalizado. */
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  const words = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const w of words) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] = (v[h % DIMS] ?? 0) + 1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIMS; i++) v[i] = v[i]! / n;
  return v;
}

const embedQuery = async (text: string) => fakeEmbed(text);

type Seed = Partial<ChunkDraft> & { text: string; label: string };

describe('retrieval/hybrid', () => {
  let db: Db;
  let ws: string;
  let config: PipelineConfig;

  /** Insere documento pronto + chunks + embeddings falsos; devolve rowids por label. */
  function seedDoc(seeds: Seed[], over: Partial<q.DocumentInsert> = {}) {
    const doc = q.insertDocument(db, {
      workspaceId: ws, docType: 'edital', docKind: 'edital_principal', title: over.title ?? 'Edital', filename: 'e.pdf',
      sha256: sha256(over.title ?? 'edital'), sizeBytes: 1, ...over,
    });
    const chunkSetId = 'set1';
    const drafts: ChunkDraft[] = seeds.map((s, i) => ({
      documentId: doc.id, workspaceId: ws, chunkSetId, kind: 'item', level: 2, orderIndex: i, sectionPath: '', contextPrefix: '',
      charCount: s.text.length, pageStart: 1, pageEnd: 1, bboxes: [], charStart: 0, charEnd: s.text.length, contentHash: sha256(s.text),
      embed: true, ...s,
    }));
    const rowids = q.replaceChunks(db, doc.id, chunkSetId, drafts);
    q.upsertEmbeddings(db, MODEL, DIMS, drafts.filter((d) => d.embed).map((d) => ({ rowid: rowids.get(d.label)!, workspaceId: ws, vector: fakeEmbed(d.text) })));
    q.updateDocument(db, doc.id, { status: 'ready', chunkSetId });
    return { doc, rowids };
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    ws = q.createWorkspace(db, { name: 'W', settings: DEFAULT_PIPELINE_CONFIG }).id;
    // glossário desligado no cenário base: os testes de fusão contam listas e escores exatos
    config = PipelineConfig.parse({ embedModel: MODEL, retrieval: { candidates: 10, topK: 4, contextBudgetChars: 10_000, glossary: false } });
  });
  afterEach(() => db.close());

  it('devolve vazio (sem erro) quando não há documentos elegíveis', async () => {
    const r = await retrieve({ db, workspaceId: ws, query: 'prazo', config, embedQuery });
    expect(r).toMatchObject({ query: 'prazo', configHash: configHash(config), candidates: [], context: [], contextChars: 0 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('híbrido: funde BM25 e KNN por RRF, marca ranks e seleciona top-k', async () => {
    const { rowids } = seedDoc([
      { label: 'c_prazo1', text: 'O prazo final para envio de propostas é 07/04/2026.' },
      { label: 'c_prazo2', text: 'Prazo de execução dos projetos: até 36 meses.' },
      { label: 'c_contra', text: 'Contrapartida financeira mínima de 5%.' },
      { label: 'c_bolsa1', text: 'Bolsas: modalidades e valores conforme tabela.' },
      { label: 'c_bolsa2', text: 'Diárias e passagens: limites da Finep.' },
      { label: 'c_bolsa3', text: 'Base legal e disposições finais.' },
    ]);
    const r = await retrieve({ db, workspaceId: ws, query: 'prazo para envio de propostas', config, embedQuery });

    expect(r.configHash).toBe(configHash(config));
    expect(r.candidates.length).toBeGreaterThan(0);
    // candidatos ordenados por RRF desc; todos os rrfScore > 0
    const scores = r.candidates.map((c) => c.rrfScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores.every((s) => s > 0)).toBe(true);

    const top = r.candidates[0]!;
    expect(top.label).toBe('c_prazo1');
    expect(top.chunkRowid).toBe(rowids.get('c_prazo1'));
    expect(top.bm25Rank).toBe(1);
    expect(top.denseRank).toBe(1);
    // RRF do topo = 1/(k+1) + 1/(k+1) com k = 1
    expect(top.rrfScore).toBeCloseTo(2 / (config.retrieval.rrfK + 1), 6);

    expect(r.candidates.filter((c) => c.selected)).toHaveLength(Math.min(4, r.candidates.length));
    expect(r.context.map((c) => c.label)[0]).toBe('c_prazo1');
    expect(r.context.length).toBe(r.candidates.filter((c) => c.selected).length);
    expect(r.contextChars).toBe(r.context.reduce((a, c) => a + c.charCount, 0));
    // StoredChunk completo no contexto
    expect(r.context[0]).toMatchObject({ rowid: rowids.get('c_prazo1'), documentTitle: 'Edital', docType: 'edital', precedence: 1 });
  });

  it('modo bm25 só tem bm25Rank; modo dense só tem denseRank e não chama o BM25', async () => {
    seedDoc([{ label: 'c_a', text: 'prazo final de envio' }, { label: 'c_b', text: 'contrapartida financeira' }]);
    const bm = await retrieve({ db, workspaceId: ws, query: 'prazo', config: { ...config, retrieval: { ...config.retrieval, mode: 'bm25' } }, embedQuery: async () => { throw new Error('não deve embedar'); } });
    expect(bm.candidates.map((c) => c.label)).toEqual(['c_a']);
    expect(bm.candidates[0]!.bm25Rank).toBe(1);
    expect(bm.candidates[0]!.denseRank).toBeUndefined();

    const dense = await retrieve({ db, workspaceId: ws, query: 'prazo', config: { ...config, retrieval: { ...config.retrieval, mode: 'dense' } }, embedQuery });
    expect(dense.candidates.every((c) => c.bm25Rank === undefined && c.denseRank !== undefined)).toBe(true);
    expect(dense.candidates[0]!.label).toBe('c_a');
  });

  it('boost por identificador exato: o item 6.5.5 vence o 6.5.5.1 mesmo com BM25 pior', async () => {
    seedDoc([
      { label: 'c_6551', text: '6.5.5.1 Excetuam-se as bolsas previstas no item 6.5.7 deste edital.', itemNumber: '6.5.5.1' },
      { label: 'c_655', text: '6.5.5 Pagamento de pessoal: é vedado o pagamento de salários a servidores públicos do quadro permanente.', itemNumber: '6.5.5' },
      { label: 'c_x', text: 'Outro item sem número relevante.' },
    ]);
    const query = 'o que diz o item 6.5.5?';
    expect(extractIdentifiers(query)).toEqual(['6.5.5']);
    const r = await retrieve({ db, workspaceId: ws, query, config, embedQuery });
    expect(r.candidates[0]!.label).toBe('c_655');
    const c655 = r.candidates.find((c) => c.label === 'c_655')!;
    const c6551 = r.candidates.find((c) => c.label === 'c_6551')!;
    expect(c655.rrfScore).toBeGreaterThan(c6551.rrfScore);
    // sem o boost (modo bm25), o 6.5.5.1 (mais curto, também casa "item") ganharia
    const bm = await retrieve({ db, workspaceId: ws, query, config: { ...config, retrieval: { ...config.retrieval, mode: 'bm25' } }, embedQuery });
    expect(bm.candidates[0]!.label).toBe('c_6551');

    // siglas e datas também contam como identificador
    expect(extractIdentifiers('prazo FINEP em 07/04/2026 e R$ 1.000,00')).toEqual(['FINEP', '07/04/2026', 'R$ 1.000,00']);
  });

  it('glossário: variantes determinísticas com os termos irmãos do conceito, e a busca acha o item sem palavra em comum', async () => {
    expect(glossaryVariants('Há exigência de tempo de constituição do proponente?')[0]).toMatch(/funcionamento regular/);
    expect(glossaryVariants('Há exigência de tempo de constituição do proponente?')[0]).toMatch(/junta comercial/i);
    expect(glossaryVariants('qual a cor do logotipo?')).toEqual([]);
    // gatilhos por palavra inteira: "rob" não dispara em "problema", "recurso" (administrativo) não dispara em "recursos financeiros"
    expect(glossaryTerms('qual o problema a resolver?')).toEqual([]);
    expect(glossaryTerms('qual o valor total de recursos previsto?').flat()).not.toContain('impugnação');
    expect(glossaryTerms('cabe recurso contra a inabilitação?').flat()).toContain('pedido de reconsideração');
    // termos que a pergunta já tem não entram na variante; plural é aceito
    expect(glossaryTerms('quais documentos devem ser enviados?').flat()).not.toContain('documentos');
    expect(glossaryTerms('quais documentos devem ser enviados?').flat()).toContain('habilitação');
    seedDoc([
      { label: 'c_36', text: '3.6 As ICTs privadas sem fins lucrativos deverão ter funcionamento regular nos últimos três anos.', itemNumber: '3.6' },
      { label: 'c_a', text: 'Outro assunto: cronograma de desembolso das parcelas.' },
      { label: 'c_b', text: 'Outro assunto: critérios de avaliação e pontuação.' },
    ]);
    const query = 'Há exigência de tempo de constituição do proponente?';
    const withGloss = await retrieve({ db, workspaceId: ws, query, config: { ...config, retrieval: { ...config.retrieval, glossary: true } }, embedQuery });
    expect(withGloss.variants?.some((v) => /funcionamento regular/.test(v))).toBe(true);
    const c36 = withGloss.candidates.find((c) => c.label === 'c_36');
    expect(c36?.selected).toBe(true);
  });

  it('bônus de seção: os filhos da seção mais bem rankeada sobem; reranker reordena os candidatos que passaram por ele', async () => {
    seedDoc([
      { label: 'c_sec3', text: '3. CRITÉRIOS DE ELEGIBILIDADE. Quem pode apresentar proposta: instituições elegíveis.', kind: 'section', level: 1, itemNumber: '3', heading: '3. CRITÉRIOS DE ELEGIBILIDADE' },
      { label: 'c_36', text: '3.6 As ICTs privadas deverão ter funcionamento regular nos últimos três anos.', itemNumber: '3.6', parentLabel: 'c_sec3', sectionPath: '3. CRITÉRIOS DE ELEGIBILIDADE' },
      { label: 'c_x', text: 'Elegibilidade das despesas: proposta de gastos elegíveis com material.', itemNumber: '6.1', sectionPath: '6. DESPESAS' },
      { label: 'c_y', text: 'Proposta de cronograma: apresentar plano de trabalho.', itemNumber: '7.1', sectionPath: '7. CRONOGRAMA' },
    ]);
    const query = 'quem pode apresentar proposta (elegibilidade)?';
    const cfg = { ...config, retrieval: { ...config.retrieval, topK: 2, expandToParent: false } };
    const plain = await retrieve({ db, workspaceId: ws, query, config: cfg, embedQuery });
    const boosted = await retrieve({ db, workspaceId: ws, query, config: { ...cfg, retrieval: { ...cfg.retrieval, sectionBoost: true } }, embedQuery });
    const score = (r: typeof plain, label: string) => r.candidates.find((c) => c.label === label)!.rrfScore;
    expect(score(boosted, 'c_36')).toBeGreaterThan(score(plain, 'c_36'));
    expect(score(boosted, 'c_x')).toBe(score(plain, 'c_x'));

    // reranker: função injetada dá nota máxima ao c_y; ele passa a ser o primeiro
    const rerank = async (_q: string, texts: string[]) => texts.map((t) => (t.includes('cronograma') ? 5 : -1));
    const reranked = await retrieve({ db, workspaceId: ws, query, config: { ...cfg, retrieval: { ...cfg.retrieval, rerank: 'bge-m3', rerankCandidates: 10 } }, embedQuery, rerank });
    expect(reranked.candidates[0]!.label).toBe('c_y');
    expect(reranked.context.map((c) => c.label)).toContain('c_y');
    await expect(retrieve({ db, workspaceId: ws, query, config: { ...cfg, retrieval: { ...cfg.retrieval, rerank: 'bge-m3' } }, embedQuery })).rejects.toThrow(/rerank/);
  });

  it('roteamento por documento: o edital nomeado na pergunta (e seu anexo) ganha bônus; sem nome, cota por edital principal', async () => {
    const A = seedDoc([{ label: 'c_a1', text: '8.1 O valor máximo solicitado por proposta é R$ 5.000.000,00.', itemNumber: '8.1' }, { label: 'c_a2', text: '8.2 O valor mínimo é R$ 2.000.000,00.', itemNumber: '8.2' }], { title: 'Edital MIB R2 — Subvenção Econômica Regional' });
    const B = seedDoc([{ label: 'c_b1', text: '5. O valor máximo solicitado por proposta é R$ 25.000.000,00 no arranjo simples.', itemNumber: '5' }], { title: 'Anexo 1 — Detalhamento (Tec. Digitais)', docKind: 'anexo' });
    const C = seedDoc([{ label: 'c_c1', text: '2.1 Valor máximo por proposta: ver anexo.', itemNumber: '2.1' }, { label: 'c_c2', text: '2.2 Valor mínimo por proposta: ver anexo.', itemNumber: '2.2' }], { title: 'Edital MIB R2 — Tecnologias Digitais' });
    const cfg = { ...config, retrieval: { ...config.retrieval, topK: 2, expandToParent: false, glossary: false } };
    const named = await retrieve({ db, workspaceId: ws, query: 'No edital de Tecnologias Digitais, qual o valor máximo solicitado por proposta?', config: cfg, embedQuery });
    expect(new Set(named.namedDocuments)).toEqual(new Set(['Edital MIB R2 — Tecnologias Digitais', 'Anexo 1 — Detalhamento (Tec. Digitais)']));
    // os trechos do edital nomeado e do seu anexo passam à frente dos do outro edital
    const ids = (r: typeof named) => r.context.map((c) => c.documentId);
    expect(ids(named).every((id) => id === B.doc.id || id === C.doc.id)).toBe(true);
    const plain = await retrieve({ db, workspaceId: ws, query: 'qual o valor máximo solicitado por proposta?', config: cfg, embedQuery });
    expect(plain.namedDocuments).toBeUndefined();
    // sem documento nomeado e dois editais principais: um trecho de cada (cota = floor(2 / (2·2)) → 1)
    expect(new Set(ids(plain))).toEqual(new Set([A.doc.id, C.doc.id]));
    const off = await retrieve({ db, workspaceId: ws, query: 'No edital de Tecnologias Digitais, qual o valor máximo solicitado por proposta?', config: { ...cfg, retrieval: { ...cfg.retrieval, documentRouting: false } }, embedQuery });
    expect(off.namedDocuments).toBeUndefined();
  });

  it('expansão folha→pai: ≥ 2 folhas do mesmo pai que cabe → pai entra e folhas apontam expandedTo', async () => {
    const parentText = '6. DESPESAS APOIÁVEIS. 6.5.5 Pagamento de pessoal vedado. 6.5.6 Diárias e passagens permitidas. 6.5.7 Bolsas permitidas.';
    const { rowids } = seedDoc([
      { label: 'c_sec6', text: parentText, kind: 'section', level: 1, itemNumber: '6', embed: false },
      { label: 'c_655', text: '6.5.5 Pagamento de pessoal vedado.', parentLabel: 'c_sec6', itemNumber: '6.5.5' },
      { label: 'c_656', text: '6.5.6 Diárias e passagens permitidas.', parentLabel: 'c_sec6', itemNumber: '6.5.6' },
      { label: 'c_657', text: '6.5.7 Bolsas permitidas.', parentLabel: 'c_sec6', itemNumber: '6.5.7' },
      { label: 'c_outro', text: 'Contrapartida financeira mínima.' },
    ]);
    const r = await retrieve({ db, workspaceId: ws, query: 'pagamento de pessoal e diárias e passagens', config, embedQuery });
    const parent = r.candidates.find((c) => c.label === 'c_sec6')!;
    expect(parent).toBeDefined();
    expect(parent.selected).toBe(true);
    expect(parent.chunkRowid).toBe(rowids.get('c_sec6'));
    const leaves = r.candidates.filter((c) => c.expandedTo === 'c_sec6');
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    expect(leaves.every((c) => !c.selected)).toBe(true);
    expect(r.context.map((c) => c.label)).toContain('c_sec6');
    expect(r.context.map((c) => c.label)).not.toContain('c_655');
    expect(new Set(r.context.map((c) => c.label)).size).toBe(r.context.length); // sem duplicatas
    // o rrf do pai = max(rrf próprio, soma das folhas absorvidas) — pai e folhas não somam o mesmo texto duas vezes
    const own = (parent.bm25Rank ? 1 / (60 + parent.bm25Rank) : 0) + (parent.denseRank ? 1 / (60 + parent.denseRank) : 0);
    expect(parent.rrfScore).toBeCloseTo(Math.max(own, leaves.reduce((a, c) => a + c.rrfScore, 0)), 9);
    // as vagas liberadas pela expansão são repostas com os próximos candidatos (topK=4): c_outro entra
    expect(r.context.map((c) => c.label)).toContain('c_outro');

    // desligado: folhas continuam
    const off = await retrieve({ db, workspaceId: ws, query: 'pagamento de pessoal e diárias e passagens', config: { ...config, retrieval: { ...config.retrieval, expandToParent: false } }, embedQuery });
    expect(off.candidates.some((c) => c.expandedTo)).toBe(false);
    expect(off.context.map((c) => c.label)).toContain('c_655');
    // (o pai pode aparecer mesmo assim: o BM25 o encontrou diretamente — é candidato comum, não expansão)

    // pai grande (> maxChars×3) não expande
    const small = { ...config, chunking: { ...config.chunking, maxChars: 200 } }; // 3×200 = 600 > parentText? não: força ainda menor
    const tiny = { ...small, chunking: { ...small.chunking, maxChars: 30 } }; // 90 < parentText.length
    const noExp = await retrieve({ db, workspaceId: ws, query: 'pagamento de pessoal e diárias e passagens', config: tiny, embedQuery });
    expect(noExp.candidates.some((c) => c.expandedTo)).toBe(false);
    expect(noExp.context.map((c) => c.label)).toContain('c_655');
  });

  it('orçamento de contexto: chunks que não cabem ficam selected=false', async () => {
    seedDoc([
      { label: 'c_a', text: 'prazo final de envio de propostas ' + 'x'.repeat(300) },
      { label: 'c_b', text: 'prazo final de envio ' + 'y'.repeat(300) },
      { label: 'c_c', text: 'prazo final ' + 'z'.repeat(300) },
    ]);
    // 334 + 321 + 312 chars: só dois cabem em 700
    const cfg = { ...config, retrieval: { ...config.retrieval, contextBudgetChars: 700 } };
    const r = await retrieve({ db, workspaceId: ws, query: 'prazo final de envio de propostas', config: cfg, embedQuery });
    expect(r.context).toHaveLength(2);
    expect(r.contextChars).toBeLessThanOrEqual(700);
    expect(r.candidates.filter((c) => c.selected)).toHaveLength(2);
    expect(r.candidates.filter((c) => !c.selected)).toHaveLength(1);
    // o mais relevante entra primeiro no orçamento
    expect(r.context.map((c) => c.label)).toContain('c_a');
  });

  it('ordem final: precedence DESC (retificação primeiro), depois RRF; escopo por documentIds', async () => {
    const original = seedDoc([
      { label: 'c_orig', text: 'O prazo final para envio de propostas é 07/04/2026 conforme cronograma original.' },
      { label: 'c_orig2', text: 'Contrapartida mínima.' },
    ], { title: 'Edital original' });
    const rerrat = seedDoc([
      { label: 'c_rer', text: 'Fica alterado o prazo final para envio de propostas para 21/04/2026.' },
    ], { title: 'Aviso de rerratificação', docKind: 'aviso_rerratificacao', amendsDocumentId: original.doc.id, versionLabel: '1a_rerratificacao' });

    const r = await retrieve({ db, workspaceId: ws, query: 'prazo final para envio de propostas conforme cronograma original', config, embedQuery });
    // o original casa mais termos (RRF maior), mas a retificação (precedence 2) vem antes no contexto
    expect(r.candidates[0]!.label).toBe('c_orig');
    expect(r.context.map((c) => c.label).slice(0, 2)).toEqual(['c_rer', 'c_orig']);
    expect(r.context[0]).toMatchObject({ precedence: 2, versionLabel: '1a_rerratificacao', documentTitle: 'Aviso de rerratificação' });

    // escopo restrito ao original
    const only = await retrieve({ db, workspaceId: ws, query: 'prazo final para envio de propostas', documentIds: [original.doc.id], config, embedQuery });
    expect(only.candidates.every((c) => c.label !== 'c_rer')).toBe(true);
    expect(only.context.map((c) => c.label)).toContain('c_orig');

    // documento fora do escopo (não pronto) nunca aparece
    q.updateDocument(db, rerrat.doc.id, { status: 'processing' });
    const after = await retrieve({ db, workspaceId: ws, query: 'prazo final para envio de propostas', config, embedQuery });
    expect(after.candidates.some((c) => c.label === 'c_rer')).toBe(false);
  });

  it('chunks não embedados (pai grande) só chegam via BM25', async () => {
    seedDoc([
      { label: 'c_big', text: 'Seção inteira sobre contrapartida financeira e prazo de execução.', kind: 'section', level: 1, embed: false },
      { label: 'c_leaf', text: 'Folha sobre elegibilidade.' },
    ]);
    const dense = await retrieve({ db, workspaceId: ws, query: 'contrapartida financeira', config: { ...config, retrieval: { ...config.retrieval, mode: 'dense' } }, embedQuery });
    expect(dense.candidates.some((c) => c.label === 'c_big')).toBe(false);
    const hybrid = await retrieve({ db, workspaceId: ws, query: 'contrapartida financeira', config, embedQuery });
    const big = hybrid.candidates.find((c) => c.label === 'c_big')!;
    expect(big.bm25Rank).toBe(1);
    expect(big.denseRank).toBeUndefined();
    expect(big.selected).toBe(true);
  });
});
