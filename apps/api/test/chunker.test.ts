/** Chunker (ingest/chunker.ts) sobre a fixture REAL: docling-serve → normalizeDocling → buildCanonical → chunkDocument. */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { DoclingServeResponse } from '../src/ingest/docling.ts';
import { normalizeDocling, buildCanonical } from '../src/ingest/normalize.ts';
import { chunkDocument, sentenceEnds, PARENT_EMBED_FACTOR, type ChunkInput } from '../src/ingest/chunker.ts';
import { ChunkingConfig, chunkLabel, sha256, type Block, type ChunkDraft, type ChunkingConfig as Chunking } from '@editais/shared';

const FIXTURE = new URL('./fixtures/agrifam_ict_2026.docling-serve.json', import.meta.url);
const DOC_ID = '01JDOC000000000000000000001';
const WS_ID = '01JWS0000000000000000000001';
const SET_ID = 'chunkset0001';

const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as DoclingServeResponse;
const parsed = normalizeDocling(raw.document.json_content, { removeHeaderFooter: true, parserVersion: 'docling@test', fallbackTitle: 'agrifam' });
const canonical = buildCanonical(parsed);
const md = canonical.markdown;

function run(over: Partial<Chunking> = {}, input: Partial<ChunkInput> = {}): ChunkDraft[] {
  const config = ChunkingConfig.parse(over);
  return chunkDocument({ parsed, canonical, documentId: DOC_ID, workspaceId: WS_ID, chunkSetId: SET_ID, config, ...input });
}

/** Pais = chunks `section` sem pai (seções de nível 1). */
const isParent = (c: ChunkDraft): boolean => c.kind === 'section' && c.parentLabel === undefined;
const leaves = (chunks: ChunkDraft[]): ChunkDraft[] => chunks.filter((c) => !isParent(c) && c.kind !== 'table_row');
/** Blocos que devem ser cobertos pelas folhas: tudo menos título, cabeçalhos de nível 1 e tabelas. */
const leafBlocks = (): Block[] => parsed.blocks.filter((b) => b.kind !== 'title' && b.kind !== 'table' && !(b.kind === 'section' && b.level <= 1));
const unescapePipes = (s: string): string => s.replace(/\\\|/g, '|');

/** Invariantes válidas para qualquer estratégia/configuração. */
function checkCommon(chunks: ChunkDraft[], cfg: Chunking): void {
  expect(chunks.length).toBeGreaterThan(0);
  expect(new Set(chunks.map((c) => c.label)).size).toBe(chunks.length);
  expect(chunks.map((c) => c.orderIndex)).toEqual(chunks.map((_, i) => i));
  const pages = new Set(parsed.pages.map((p) => p.page));
  for (const c of chunks) {
    const where = `chunk ${c.orderIndex} (${c.kind})`;
    expect(c.label, where).toBe(chunkLabel(`${DOC_ID}:${SET_ID}:${c.orderIndex}`));
    expect(c, where).toMatchObject({ documentId: DOC_ID, workspaceId: WS_ID, chunkSetId: SET_ID });
    expect(c.text.trim().length, where).toBeGreaterThan(0);
    expect(c.charCount, where).toBe(c.text.length);
    expect(c.contentHash, where).toBe(sha256(c.text));
    expect(c.charStart, where).toBeGreaterThanOrEqual(0);
    expect(c.charStart, where).toBeLessThan(c.charEnd);
    expect(c.charEnd, where).toBeLessThanOrEqual(md.length);
    expect(pages.has(c.pageStart), where).toBe(true);
    expect(pages.has(c.pageEnd), where).toBe(true);
    expect(c.pageStart, where).toBeLessThanOrEqual(c.pageEnd);
    expect(c.bboxes.length, where).toBeGreaterThan(0);
    expect(c.contextPrefix, where).toBe(c.sectionPath ? `[${parsed.title.slice(0, 79).trimEnd()}… › ${c.sectionPath}]` : `[${parsed.title.slice(0, 79).trimEnd()}…]`);
    if (c.kind === 'table_row') continue;
    // O trecho do canonical apontado pelo chunk contém o início do seu texto (primeira linha = primeiro bloco).
    expect(md.slice(c.charStart, c.charEnd), where).toContain(unescapePipes(c.text.split('\n')[0]!.slice(0, 30)));
    if (isParent(c)) continue;
    const limit = c.kind === 'table' ? cfg.maxChars * 2 : cfg.maxChars + cfg.overlapChars;
    expect(c.charCount, where).toBeLessThanOrEqual(limit);
  }
}

/** As folhas cobrem todo o texto dos blocos-folha, na ordem. */
function checkCoverage(chunks: ChunkDraft[]): void {
  const joined = leaves(chunks).map((c) => c.text).join('\n');
  let cursor = 0;
  for (const b of leafBlocks()) {
    const at = joined.indexOf(b.text, cursor);
    expect(at, `bloco ${b.index} "${b.text.slice(0, 40)}" fora de ordem ou ausente`).toBeGreaterThanOrEqual(0);
    cursor = at + b.text.length;
  }
}

describe('chunkDocument — hier (default)', () => {
  const cfg = ChunkingConfig.parse({});
  const chunks = run();

  it('invariantes básicas: labels únicos, nada vazio, offsets dentro do canonical, tamanhos', () => {
    checkCommon(chunks, cfg);
    expect(chunks.length).toBeGreaterThan(40);
    expect(chunks.length).toBeLessThan(120);
  });

  it('as folhas cobrem todo o texto dos blocos não-tabela, na ordem de leitura', () => {
    checkCoverage(chunks);
  });

  it('um pai por seção de nível 1 (18), emitido antes das folhas, com texto = seção inteira e embed=false só se grande', () => {
    const parents = chunks.filter(isParent);
    expect(parents.map((p) => p.itemNumber)).toEqual(Array.from({ length: 18 }, (_, i) => String(i + 1)));
    for (const p of parents) {
      expect(p.level).toBe(1);
      expect(p.heading).toBe(p.text.split('\n')[0]);
      expect(p.sectionPath).toBe('');
      const kids = chunks.filter((c) => c.parentLabel === p.label);
      // embedado só se cabe no limite do modelo (≈ 512 tokens) e não é quase idêntico à sua única folha
      expect(p.embed, `pai ${p.itemNumber}`).toBe(p.charCount <= cfg.maxChars * PARENT_EMBED_FACTOR && kids.length !== 1);
      expect(kids.length, `pai ${p.itemNumber}`).toBeGreaterThan(0);
      for (const k of kids) {
        expect(k.orderIndex).toBeGreaterThan(p.orderIndex);
        expect(k.pageStart).toBeGreaterThanOrEqual(p.pageStart);
        expect(k.pageEnd).toBeLessThanOrEqual(p.pageEnd);
        expect(k.charStart).toBeGreaterThanOrEqual(p.charStart);
        expect(k.charEnd).toBeLessThanOrEqual(p.charEnd);
        expect(k.heading).toBeDefined();
        expect(k.embed).toBe(true);
        // Texto de cada folha (bloco a bloco) está no pai (a cabeça repetida nos pedaços de continuação vem truncada com "…").
        for (const line of k.text.split('\n')) expect(p.text).toContain(line.replace(/…$/, ''));
      }
    }
    const notEmbedded = parents.filter((p) => !p.embed).map((p) => p.itemNumber);
    for (const big of ['2', '6', '11', '16']) expect(notEmbedded).toContain(big);
    // 13. INTERPOSIÇÃO DE RECURSOS (1861 chars, 2 folhas) e 15. CRONOGRAMA cabem no limite e têm mais de uma folha
    expect(parents.filter((p) => p.embed).map((p) => p.itemNumber)).toEqual(['13', '15']);
    expect(chunks.every((c) => isParent(c) || chunks.some((p) => p.label === c.parentLabel && isParent(p)))).toBe(true);
  });

  it('cada tabela vira um chunk `table` em Markdown com todas as células (e a legenda no mesmo chunk)', () => {
    const tables = chunks.filter((c) => c.kind === 'table');
    expect(tables).toHaveLength(4);
    for (const b of parsed.blocks.filter((b) => b.kind === 'table')) {
      const chunk = tables.find((c) => c.charStart <= canonical.blockOffsets[b.index]!.charStart && c.charEnd >= canonical.blockOffsets[b.index]!.charEnd);
      expect(chunk, `tabela do bloco ${b.index}`).toBeDefined();
      const text = unescapePipes(chunk!.text);
      for (const cell of b.table!.rows.flat().filter(Boolean)) expect(text).toContain(cell);
      expect(chunk!.heading).toBe(b.table!.caption);
      expect(chunk!.text).toContain('| --- |');
    }
    const cron = tables.find((c) => c.text.includes('| Fase | Data |'))!;
    expect(cron.text.startsWith('15.1. Prazos do cronograma da Seleção Pública:\n| Fase | Data |')).toBe(true);
    expect(cron).toMatchObject({ itemNumber: '15.1', level: 2, sectionPath: '15. CRONOGRAMA', pageStart: 21, pageEnd: 22 });
    // Evento e data na mesma linha.
    expect(cron.text).toMatch(/\| Término do prazo para envio da proposta [^\n|]* \| 26\/06\/2026 \|/);
    expect(chunks.filter((c) => c.kind === 'table_row')).toHaveLength(0);
  });

  it('itemNumber, level, kind, heading e sectionPath vêm do primeiro bloco', () => {
    const c91 = chunks.find((c) => c.text.startsWith('9.1. O prazo de execução'))!;
    expect(c91).toMatchObject({ kind: 'item', level: 2, itemNumber: '9.1', sectionPath: '9. PRAZO DE EXECUÇÃO DOS PROJETOS', heading: '9. PRAZO DE EXECUÇÃO DOS PROJETOS', pageStart: 14 });
    expect(c91.contextPrefix).toMatch(/^\[CHAMADA PÚBLICA .*… › 9\. PRAZO DE EXECUÇÃO DOS PROJETOS\]$/);
    const c65 = chunks.find((c) => c.text.startsWith('6.5. Despesas Correntes'))!;
    expect(c65).toMatchObject({ kind: 'section', level: 2, itemNumber: '6.5', sectionPath: '6. DESPESAS APOIÁVEIS' });
    expect(c65.text).toContain('6.5.2. Outros Serviços de Terceiros (Pessoa Jurídica):\n6.5.2.1.'); // cláusula-mãe junto dos filhos
    // A lista de alíneas de 16.5.1 não cabe num chunk: o pedaço seguinte ("q) Cadastro Nacional…") repete a cláusula-mãe
    // no início (kind/itemNumber da cabeça; a faixa no canonical cobre cabeça + pedaço) e não perde o caminho.
    expect(chunks.find((c) => c.kind === 'alinea')).toBeUndefined();
    const parts = leaves(chunks).filter((c) => c.text.startsWith('16.5.1.'));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]!.text).toMatch(/\na\) Credenciamento/);
    const cont = parts.find((c) => /\nq\) Cadastro Nacional/.test(c.text))!;
    expect(cont).toMatchObject({ kind: 'item', itemNumber: '16.5.1', charStart: parts[0]!.charStart });
    expect(cont.text.split('\n')[0]!.length).toBeLessThanOrEqual(201);
    expect(md.slice(cont.charStart, cont.charEnd)).toContain('q) Cadastro Nacional');
  });

  it('mergePeers agrupa vizinhos até maxChars; parágrafos de continuação de página ficam com o item', () => {
    const c11 = chunks.find((c) => c.itemNumber === '1.1')!;
    expect(c11.text).toContain('\n1.2. As iniciativas');
    expect(c11.charCount).toBeLessThanOrEqual(cfg.maxChars);
    const c561 = chunks.find((c) => c.text.includes('5.6.1. Essas parcerias'))!;
    expect(c561.text).toContain('carta de an');
    expect(c561.text).toContain('\ninstrumentos jurídicos vigentes');
  });

  it('é determinístico e os rótulos dependem de documentId/chunkSetId', () => {
    expect(run()).toEqual(chunks);
    const other = run({}, { chunkSetId: 'outro' });
    expect(other.map((c) => c.text)).toEqual(chunks.map((c) => c.text));
    expect(other.map((c) => c.label)).not.toEqual(chunks.map((c) => c.label));
  });
});

describe('chunkDocument — hier, variações de configuração', () => {
  it('mergePeers=false: cada item (com seus filhos imediatos) vira chunk próprio', () => {
    const cfg = ChunkingConfig.parse({ mergePeers: false });
    const chunks = run(cfg);
    checkCommon(chunks, cfg);
    checkCoverage(chunks);
    const merged = run();
    expect(chunks.length).toBeGreaterThan(merged.length);
    // Chunks item/section começam pela própria numeração; a continuação (alíneas q…y de 16.5.1) repete a cabeça.
    for (const c of leaves(chunks).filter((c) => c.itemNumber && (c.kind === 'item' || c.kind === 'section'))) {
      expect(c.text.startsWith(c.itemNumber!), c.itemNumber).toBe(true);
    }
    const cont = leaves(chunks).find((c) => /\nq\) Cadastro Nacional/.test(c.text))!;
    expect(cont.itemNumber).toBe('16.5.1');
    expect(cont.text.startsWith('16.5.1.')).toBe(true);
    const c11 = chunks.find((c) => c.itemNumber === '1.1')!;
    expect(c11.text).not.toContain('1.2.');
    // A legenda continua junto da tabela mesmo sem mergePeers.
    expect(chunks.find((c) => c.kind === 'table' && c.text.startsWith('15.1. Prazos'))).toBeDefined();
  });

  it('maxChars pequeno: blocos grandes são fatiados por sentença com overlap e offsets exatos no canonical', () => {
    const cfg = ChunkingConfig.parse({ maxChars: 300, overlapChars: 60 });
    const chunks = run(cfg);
    checkCommon(chunks, cfg);
    const big = parsed.blocks.filter((b) => b.kind !== 'table' && b.text.length > cfg.maxChars);
    expect(big.length).toBeGreaterThan(5);
    for (const b of big) {
      const o = canonical.blockOffsets[b.index]!;
      const slices = chunks.filter((c) => !isParent(c) && c.charStart >= o.charStart && c.charEnd <= o.charEnd);
      expect(slices.length, `bloco ${b.index}`).toBeGreaterThan(1);
      const textStart = o.charStart + md.slice(o.charStart, o.charEnd).indexOf(b.text);
      expect(slices[0]!.charStart).toBe(textStart);
      expect(slices[slices.length - 1]!.charEnd).toBe(textStart + b.text.length);
      for (let i = 0; i < slices.length; i++) {
        const s = slices[i]!;
        expect(md.slice(s.charStart, s.charEnd)).toBe(s.text); // fatia literal
        expect(s.charCount).toBeLessThanOrEqual(cfg.maxChars);
        expect(s.itemNumber).toBe(b.kind === 'item' ? b.itemNumber : s.itemNumber);
        if (i > 0) {
          expect(s.charStart).toBeGreaterThan(slices[i - 1]!.charStart);
          expect(s.charStart).toBeLessThanOrEqual(slices[i - 1]!.charEnd); // overlap ou adjacência
          expect(s.charStart - (slices[i - 1]!.charEnd - cfg.overlapChars)).toBeGreaterThanOrEqual(0);
        }
      }
      for (const s of slices) {
        expect(b.text.includes(s.text)).toBe(true);
        expect(/^\s|\s$/.test(s.text)).toBe(false); // sem espaços nas pontas; nunca corta palavra
        expect(b.text[s.charEnd - textStart] ?? ' ').toMatch(/\s/);
        expect(b.text[s.charStart - textStart - 1] ?? ' ').toMatch(/\s/);
      }
    }
    // A maioria das fatias termina em fim de sentença (o resto é cortado em fim de palavra por falta de pontuação).
    const slices = chunks.filter((c) => !isParent(c) && md.slice(c.charStart, c.charEnd) === c.text);
    expect(slices.length).toBeGreaterThan(30);
    expect(slices.filter((c) => /[.;:!?)]$/.test(c.text)).length / slices.length).toBeGreaterThan(0.5);
    for (const c of slices) {
      // Pedaços de blocos grandes herdam itemNumber e sectionPath da cabeça / do bloco.
      const b = big.find((b) => c.charStart >= canonical.blockOffsets[b.index]!.charStart && c.charEnd <= canonical.blockOffsets[b.index]!.charEnd);
      if (b) expect(c.sectionPath).toBe(b.sectionPath);
    }
    // Tabela grande (critérios de mérito, 1585 chars) fatiada em grupos de linhas com o cabeçalho repetido.
    const merito = chunks.filter((c) => c.kind === 'table' && c.text.includes('| Critérios para Avaliação de Mérito | Notas | Pesos |'));
    expect(merito.length).toBeGreaterThan(1);
    // Todos os grupos levam o número do item que introduz a tabela, não só o primeiro (que se junta à legenda).
    expect(merito.map((c) => c.itemNumber)).toEqual(merito.map(() => '11.3'));
    const rows = merito.flatMap((c) => c.text.split('\n').slice(2));
    expect(rows).toHaveLength(5);
    expect(rows[4]).toContain('5. Parcerias previstas');
    for (const c of merito) {
      expect(c.charStart).toBe(merito[0]!.charStart);
      expect(md.slice(c.charStart, c.charEnd).endsWith(c.text.split('\n').at(-1)!)).toBe(true);
    }
  });

  it('markdown+rows: um chunk table_row por linha de dados, com parentLabel = chunk da tabela', () => {
    const cfg = ChunkingConfig.parse({ tableMode: 'markdown+rows' });
    const chunks = run(cfg);
    checkCommon(chunks, cfg);
    checkCoverage(chunks);
    const rows = chunks.filter((c) => c.kind === 'table_row');
    const expectedRows = parsed.blocks.filter((b) => b.kind === 'table').reduce((n, b) => n + b.table!.rows.length - Math.max(1, b.table!.headerRows.length), 0);
    expect(rows).toHaveLength(expectedRows);
    for (const r of rows) {
      const table = chunks.find((c) => c.label === r.parentLabel)!;
      expect(table.kind).toBe('table');
      expect(r.orderIndex).toBeGreaterThan(table.orderIndex);
      expect(r.level).toBe(table.level + 1);
      expect(r.embed).toBe(true);
      expect(r.heading).toBe(table.heading);
      expect(r.charStart).toBeGreaterThanOrEqual(table.charStart);
      expect(r.charEnd).toBeLessThanOrEqual(table.charEnd);
    }
    const envio = rows.find((r) => r.text.includes('Término do prazo para envio da proposta'))!;
    expect(envio.text).toBe('15.1. Prazos do cronograma da Seleção Pública: — Fase: Término do prazo para envio da proposta na Plataforma de Apoio e Financiamento; Data: 26/06/2026');
    expect(md.slice(envio.charStart, envio.charEnd)).toBe('| Término do prazo para envio da proposta na Plataforma de Apoio e Financiamento | 26/06/2026 |');
    const hab = rows.find((r) => r.text.includes('Quantidade máxima de coexecutores'))!;
    expect(hab.text).toMatch(/^11\.1\. Habilitação da Proposta: .*… — Nº: 3; Requisitos Formais para Habilitação da Proposta: Quantidade máxima de coexecutores; Item de Referência: 5\.4$/);
    // Sem tableMode=rows os chunks restantes são os mesmos.
    expect(chunks.filter((c) => c.kind !== 'table_row').map((c) => c.text)).toEqual(run().map((c) => c.text));
  });
});

describe('chunkDocument — fixed (controle)', () => {
  const cfg = ChunkingConfig.parse({ strategy: 'fixed', maxChars: 1000, overlapChars: 100 });
  const chunks = run(cfg);

  it('janelas ≤ maxChars, kind fixed, sem pais, com overlap e offsets crescentes no canonical', () => {
    checkCommon(chunks, cfg);
    expect(chunks.every((c) => c.kind === 'fixed' && c.parentLabel === undefined && c.embed)).toBe(true);
    expect(chunks.length).toBeGreaterThan(md.length / (cfg.maxChars + cfg.overlapChars));
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const cur = chunks[i]!;
      expect(cur.charStart).toBeGreaterThan(prev.charStart);
      expect(cur.charStart).toBeLessThanOrEqual(prev.charEnd);
      expect(cur.pageStart).toBeGreaterThanOrEqual(prev.pageStart);
    }
    expect(chunks[0]!.charStart).toBe(2); // depois de "# "
    expect(chunks[0]!.text.startsWith('CHAMADA PÚBLICA')).toBe(true);
    expect(chunks.at(-1)!.charEnd).toBe(md.length - 1); // antes do "\n" final
  });

  it('cobre todo o texto (sem âncoras) e herda sectionPath/itemNumber do bloco onde a janela começa', () => {
    const joined = chunks.map((c) => c.text).join('\n');
    for (const b of parsed.blocks) {
      const probe = b.kind === 'table' ? b.table!.rows[0]![0]! : b.text.slice(0, 25);
      expect(joined, `bloco ${b.index}`).toContain(probe);
    }
    expect(joined).not.toContain('{#sec-');
    for (const c of chunks) {
      const block = parsed.blocks.find((b) => {
        const o = canonical.blockOffsets[b.index]!;
        return c.charStart >= o.charStart && c.charStart < o.charEnd;
      })!;
      expect(c.sectionPath, `chunk ${c.orderIndex}`).toBe(block.sectionPath);
      expect(c.level).toBe(block.level);
      if (block.kind === 'item' || block.kind === 'section') expect(c.itemNumber).toBe(block.itemNumber);
      expect(c.pageStart).toBe(block.pageStart);
    }
    // Janelas que começam dentro da seção 15 herdam o cabeçalho "15. CRONOGRAMA".
    const s15 = canonical.sections.find((s) => s.anchor === 'sec-15')!;
    const inside = chunks.filter((c) => c.charStart >= s15.charStart && c.charStart < s15.charEnd);
    expect(inside.length).toBeGreaterThan(0);
    for (const c of inside) {
      expect(c.heading).toBe('15. CRONOGRAMA');
      expect(c.sectionPath === '' || c.sectionPath.startsWith('15. CRONOGRAMA')).toBe(true);
    }
    expect(chunks.some((c) => c.text.includes('| Término do prazo para envio da proposta na Plataforma de Apoio e Financiamento | 26/06/2026 |'))).toBe(true);
  });

  it('tableMode é ignorado e a config default também funciona', () => {
    const rows = run({ strategy: 'fixed', tableMode: 'markdown+rows' });
    expect(rows.every((c) => c.kind === 'fixed')).toBe(true);
    const dflt = run({ strategy: 'fixed' });
    checkCommon(dflt, ChunkingConfig.parse({ strategy: 'fixed' }));
    expect(dflt.length).toBeLessThan(chunks.length);
  });
});

describe('chunkDocument — casos de borda', () => {
  it('documento vazio → []', () => {
    const empty = { title: 'x', pages: [], blocks: [], stats: { sections: 0, items: 0, tables: 0, footnotes: 0, removedHeaderFooterLines: 0 }, parser: parsed.parser };
    expect(run({}, { parsed: empty, canonical: buildCanonical(empty) })).toEqual([]);
  });

  it('canonical de outro documento → erro claro', () => {
    expect(() => run({}, { canonical: { markdown: '', sections: [], blockOffsets: [] } })).toThrow(/bloco \d+ sem offsets/);
  });

  it('sentenceEnds: quebra em fim de sentença, ignora numeração e abreviações, termina em text.length', () => {
    const t = 'Art. 5º Os itens 6.5.5. aplicam-se. A Finep decidirá; o prazo é de 10 dias. O Sr. Fulano assinou. Fim';
    const ends = sentenceEnds(t);
    expect(ends.at(-1)).toBe(t.length);
    const parts = ends.map((e, i) => t.slice(ends[i - 1] ?? 0, e).trim());
    expect(parts).toEqual(['Art. 5º Os itens 6.5.5. aplicam-se.', 'A Finep decidirá; o prazo é de 10 dias.', 'O Sr. Fulano assinou.', 'Fim']);
    expect(sentenceEnds('sem pontuação')).toEqual([13]);
  });
});
