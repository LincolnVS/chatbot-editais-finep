/** Normalizador sobre a fixture real do docling-serve (edital Agricultura Familiar — ICT 2026). */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { DoclingDocumentJson, DoclingServeResponse, DoclingTableCell } from '../src/ingest/docling.ts';
import { normalizeDocling, buildCanonical, detectNumbering, normalizeText, tableToMarkdown, tableLayout, sectionAnchor } from '../src/ingest/normalize.ts';
import type { ParsedDocument } from '@editais/shared';

const FIXTURE = new URL('./fixtures/agrifam_ict_2026.docling-serve.json', import.meta.url);

function loadFixture(): DoclingDocumentJson {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as DoclingServeResponse;
  return raw.document.json_content;
}

function parseFixture(removeHeaderFooter = true): ParsedDocument {
  return normalizeDocling(loadFixture(), { removeHeaderFooter, parserVersion: 'docling@test', fallbackTitle: 'agrifam_ict_2026' });
}

describe('normalizeDocling (fixture real)', () => {
  const doc = loadFixture();
  const parsed = parseFixture();

  it('a fixture tem a forma esperada (26 section_header, 227 list_item, 5 tabelas)', () => {
    const labels = new Map<string, number>();
    for (const t of doc.texts) labels.set(t.label, (labels.get(t.label) ?? 0) + 1);
    expect(labels.get('section_header')).toBe(26);
    expect(labels.get('list_item')).toBe(227);
    expect(doc.tables).toHaveLength(5);
    expect(Object.keys(doc.pages)).toHaveLength(27);
  });

  it('extrai o título (primeiro cabeçalho em caixa alta da página 1) e as estatísticas', () => {
    expect(parsed.title).toMatch(/^CHAMADA PÚBLICA MCTI\/FINEP\/FNDCT/);
    expect(parsed.parser).toEqual({ name: 'docling', version: 'docling@test' });
    expect(parsed.pages).toHaveLength(27);
    expect(parsed.stats.sections).toBeGreaterThanOrEqual(20);
    expect(parsed.stats.items).toBeGreaterThan(150);
    expect(parsed.stats.tables).toBe(4); // 5 no Docling: a do cronograma (p.21→22) é mesclada
    expect(parsed.blocks.filter((b) => b.kind === 'title')).toHaveLength(1);
  });

  it('produz ≥ 20 seções de nível 1 numeradas de 1 a 18, em ordem', () => {
    const sections = parsed.blocks.filter((b) => b.kind === 'section');
    expect(sections.length).toBeGreaterThanOrEqual(20);
    const level1 = sections.filter((b) => b.level === 1).map((b) => b.itemNumber);
    expect(level1).toEqual(Array.from({ length: 18 }, (_, i) => String(i + 1)));
    const cronograma = sections.find((b) => b.itemNumber === '15');
    expect(cronograma?.text).toBe('15. CRONOGRAMA');
    expect(cronograma?.sectionPath).toBe('');
  });

  it('classifica itens em ≥ 3 níveis distintos ("1", "1.3", "1.3.1") com ancestrais e sectionPath', () => {
    const byNumber = new Map(parsed.blocks.filter((b) => b.itemNumber).map((b) => [b.itemNumber!, b]));
    expect(byNumber.get('1')).toMatchObject({ kind: 'section', level: 1, ancestors: [] });
    expect(byNumber.get('1.3')).toMatchObject({ kind: 'item', level: 2, ancestors: ['1'], sectionPath: '1. OBJETIVO E LINHAS TEMÁTICAS' });
    expect(byNumber.get('1.3.1')).toMatchObject({ kind: 'item', level: 3, ancestors: ['1', '1.3'] });
    expect(byNumber.get('1.3.1')!.sectionPath).toMatch(/^1\. OBJETIVO E LINHAS TEMÁTICAS › 1\.3\. Para fins/);
    expect(byNumber.get('6.5.2.1')).toMatchObject({ kind: 'item', level: 4, ancestors: ['6', '6.5', '6.5.2'] });
    const levels = new Set(parsed.blocks.filter((b) => b.kind === 'item').map((b) => b.level));
    expect(levels.size).toBeGreaterThanOrEqual(3);
    // Todo item tem sectionPath não vazio (herda pelo menos a seção de nível 1).
    for (const b of parsed.blocks.filter((b) => b.kind === 'item')) expect(b.sectionPath, `item ${b.itemNumber}`).not.toBe('');
  });

  it('alíneas a)…y) do item 16.5.1 viram blocos alinea com nível do pai + 1', () => {
    const alineas = parsed.blocks.filter((b) => b.kind === 'alinea');
    expect(alineas.length).toBeGreaterThanOrEqual(25);
    const a = alineas.find((b) => b.itemNumber === 'a');
    expect(a).toMatchObject({ level: 4, ancestors: ['16', '16.5', '16.5.1'] });
    expect(a!.text).toMatch(/^a\) Credenciamento/);
  });

  it('usa `orig` (com numeração) e não `text`: o list_item 1.1 começa com "1.1."', () => {
    const li = doc.texts.find((t) => t.label === 'list_item' && t.orig?.startsWith('1.1.'));
    expect(li).toBeDefined();
    expect(li!.text.startsWith('1.1')).toBe(false);
    const block = parsed.blocks.find((b) => b.itemNumber === '1.1');
    expect(block?.text).toMatch(/^1\.1\. Selecionar propostas/);
  });

  it('nenhum bloco (nem o título) tem texto vazio nem espaços duplicados', () => {
    expect(parsed.blocks.length).toBeGreaterThan(200);
    for (const b of parsed.blocks) {
      expect(b.text.trim().length, `bloco ${b.index}`).toBeGreaterThan(0);
      expect(b.text, `bloco ${b.index}`).not.toMatch(/ {2}/);
      expect(b.text).toBe(b.text.trim());
    }
    expect(parsed.blocks.map((b) => b.index)).toEqual(parsed.blocks.map((_, i) => i));
  });

  it('bboxes normalizados em 0..1 com página válida; pageStart ≤ pageEnd', () => {
    const pageNumbers = new Set(parsed.pages.map((p) => p.page));
    for (const b of parsed.blocks) {
      expect(b.pageStart).toBeLessThanOrEqual(b.pageEnd);
      expect(pageNumbers.has(b.pageStart)).toBe(true);
      expect(b.bboxes.length).toBeGreaterThan(0);
      for (const bb of b.bboxes) {
        expect(pageNumbers.has(bb.page)).toBe(true);
        expect(bb.x0).toBeGreaterThanOrEqual(0);
        expect(bb.y0).toBeGreaterThanOrEqual(0);
        expect(bb.x1).toBeLessThanOrEqual(1);
        expect(bb.y1).toBeLessThanOrEqual(1);
        expect(bb.x0).toBeLessThan(bb.x1);
        expect(bb.y0).toBeLessThan(bb.y1);
      }
    }
    // Origem superior-esquerda: o título está no topo da página 1.
    expect(parsed.blocks[0]!.bboxes[0]!.y0).toBeLessThan(0.3);
    for (const p of parsed.pages) expect(p.charCount).toBeGreaterThan(0);
  });

  it('tabelas: grade com células, cabeçalho "Nº", caption pelo parágrafo anterior terminado em ":" e merge entre páginas', () => {
    const tables = parsed.blocks.filter((b) => b.kind === 'table');
    expect(tables).toHaveLength(4);
    for (const t of tables) {
      expect(t.table!.rows.length).toBe(t.table!.numRows);
      expect(t.table!.rows.every((r) => r.length === t.table!.numCols)).toBe(true);
      expect(t.text.length).toBeGreaterThan(0);
    }
    // As duas tabelas de habilitação: 3 colunas, primeira célula "Nº", primeira linha é cabeçalho.
    expect(tables[0]!.table!.rows[0]![0]).toBe('Nº');
    expect(tables[1]!.table!.rows[0]![0]).toBe('Nº');
    expect(tables[0]!.table!.headerRows).toEqual([0]);
    expect(tables[0]!.table!.numCols).toBe(3);
    expect(tables[0]!.table!.caption).toMatch(/^11\.1\. Habilitação da Proposta/);
    expect(tables[0]!.sectionPath).toMatch(/^11\. PROCESSO DE SELEÇÃO/);
    // Cronograma: tabelas #/tables/3 (p.21) e #/tables/4 (p.22) mescladas em um bloco de 9 linhas × 2 colunas.
    const cron = tables[3]!;
    expect(cron).toMatchObject({ pageStart: 21, pageEnd: 22 });
    expect(cron.table!.numCols).toBe(2);
    expect(cron.table!.rows).toHaveLength(9);
    expect(cron.table!.rows[0]).toEqual(['Fase', 'Data']);
    expect(cron.table!.rows[8]).toEqual(['Divulgação do Resultado Final da Avaliação de Mérito', 'A partir de 24/11/2026']);
    expect(cron.table!.caption).toBe('15.1. Prazos do cronograma da Seleção Pública:');
    // A tabela é reposicionada para logo depois do item 15.1 (o Docling a coloca após o grupo de lista).
    const idx = parsed.blocks.indexOf(cron);
    expect(parsed.blocks[idx - 1]!.itemNumber).toBe('15.1');
    expect(parsed.blocks[idx + 1]!.itemNumber).toBe('15.2');
  });

  it('removeHeaderFooter=false não remove nada nesta fixture (sem cabeçalho repetido no corpo)', () => {
    const raw = parseFixture(false);
    expect(raw.stats.removedHeaderFooterLines).toBe(0);
    expect(raw.blocks.length).toBe(parsed.blocks.length);
  });
});

/** DoclingDocument sintético: um bloco de texto por entrada, todos na página 1, em ordem de leitura. */
function makeDoc(items: Array<{ label: string; text: string }>): DoclingDocumentJson {
  const texts = items.map((it, i) => ({
    self_ref: `#/texts/${i}`, label: it.label, text: it.text, orig: it.text, content_layer: 'body',
    prov: [{ page_no: 1, bbox: { l: 50, t: 800 - i * 20, r: 500, b: 790 - i * 20, coord_origin: 'BOTTOMLEFT' as const } }],
  }));
  return {
    schema_name: 'DoclingDocument', version: '1.0.0', name: 'sintetico',
    body: { self_ref: '#/body', children: texts.map((t) => ({ $ref: t.self_ref })) },
    groups: [], texts, tables: [], pictures: [], pages: { '1': { size: { width: 595, height: 842 }, page_no: 1 } },
  };
}

describe('normalizeDocling (documentos sintéticos)', () => {
  const opts = { removeHeaderFooter: true, parserVersion: 'x', fallbackTitle: 'sintetico' };

  it('subtítulos sem numeração seguidos ("1ª ETAPA", "2ª ETAPA") são irmãos sob a seção numerada (caso do edital SBV)', () => {
    const parsed = normalizeDocling(makeDoc([
      { label: 'section_header', text: '12. DIRETRIZES GERAIS DA SELEÇÃO' },
      { label: 'list_item', text: '12.1. O processo de seleção das propostas consistirá na avaliação de seus aspectos.' },
      { label: 'section_header', text: '1ª ETAPA - HABILITAÇÃO' },
      { label: 'list_item', text: '12.2. Nesta etapa, de caráter eliminatório, as propostas serão habilitadas.' },
      { label: 'section_header', text: '2ª ETAPA - ANÁLISE DE MÉRITO' },
      { label: 'list_item', text: '12.3. Os projetos habilitados na primeira etapa serão avaliados.' },
      { label: 'section_header', text: '13. RESULTADOS' },
      { label: 'list_item', text: '13.1. Os resultados serão divulgados.' },
    ]), opts);
    const by = (t: string) => parsed.blocks.find((b) => b.text.startsWith(t))!;
    expect(by('1ª ETAPA')).toMatchObject({ kind: 'section', level: 2, sectionPath: '12. DIRETRIZES GERAIS DA SELEÇÃO' });
    expect(by('2ª ETAPA')).toMatchObject({ kind: 'section', level: 2, sectionPath: '12. DIRETRIZES GERAIS DA SELEÇÃO' });
    expect(by('12.2.')).toMatchObject({ kind: 'item', level: 2, ancestors: ['12'], sectionPath: '12. DIRETRIZES GERAIS DA SELEÇÃO › 1ª ETAPA - HABILITAÇÃO' });
    expect(by('12.3.')).toMatchObject({ kind: 'item', level: 2, ancestors: ['12'], sectionPath: '12. DIRETRIZES GERAIS DA SELEÇÃO › 2ª ETAPA - ANÁLISE DE MÉRITO' });
    expect(by('13. RESULTADOS')).toMatchObject({ kind: 'section', level: 1, sectionPath: '' });
    expect(by('13.1.')).toMatchObject({ ancestors: ['13'], sectionPath: '13. RESULTADOS' });
    expect(parsed.title).toBe('sintetico');
  });

  it('ANEXO / CLÁUSULA / Art. / § / alíneas: anexo fica na pilha até o próximo anexo; numeração reinicia dentro dele', () => {
    const parsed = normalizeDocling(makeDoc([
      { label: 'section_header', text: 'EDITAL DE SELEÇÃO PÚBLICA' },
      { label: 'section_header', text: '1. OBJETO' },
      { label: 'list_item', text: '1.1. Selecionar propostas.' },
      { label: 'section_header', text: 'ANEXO I - MINUTA PADRÃO DE CONVÊNIO' },
      { label: 'section_header', text: 'CLÁUSULA PRIMEIRA - DO OBJETO' },
      { label: 'text', text: 'Art. 1º O presente convênio tem por objeto o apoio financeiro.' },
      { label: 'text', text: '§ 1º O apoio observará as seguintes condições:' },
      { label: 'text', text: 'a) execução do plano de trabalho;' },
      { label: 'text', text: 'b) prestação de contas.' },
      { label: 'section_header', text: '1. OBJETO DO ANEXO' },
      { label: 'list_item', text: '1.1. Item do anexo.' },
      { label: 'section_header', text: 'ANEXO II - DECLARAÇÕES' },
      { label: 'text', text: 'Declaro para os devidos fins.' },
    ]), opts);
    const by = (t: string) => parsed.blocks.find((b) => b.text.startsWith(t))!;
    expect(parsed.title).toBe('EDITAL DE SELEÇÃO PÚBLICA');
    expect(by('ANEXO I')).toMatchObject({ kind: 'section', level: 1, itemNumber: 'ANEXO I', sectionPath: '' });
    expect(by('CLÁUSULA PRIMEIRA')).toMatchObject({ kind: 'section', level: 1, itemNumber: 'CLÁUSULA PRIMEIRA', ancestors: ['ANEXO I'] });
    expect(by('Art. 1º')).toMatchObject({ kind: 'item', level: 2, itemNumber: 'Art. 1', ancestors: ['ANEXO I', 'CLÁUSULA PRIMEIRA'] });
    expect(by('§ 1º')).toMatchObject({ kind: 'item', level: 3, itemNumber: '§ 1', ancestors: ['ANEXO I', 'CLÁUSULA PRIMEIRA', 'Art. 1'] });
    expect(by('a) execução')).toMatchObject({ kind: 'alinea', level: 4, itemNumber: 'a', ancestors: ['ANEXO I', 'CLÁUSULA PRIMEIRA', 'Art. 1', '§ 1'] });
    expect(by('b) prestação')).toMatchObject({ kind: 'alinea', level: 4, itemNumber: 'b' });
    expect(by('1. OBJETO DO ANEXO')).toMatchObject({ kind: 'section', level: 1, itemNumber: '1', ancestors: ['ANEXO I'] });
    expect(by('1.1. Item do anexo')).toMatchObject({ kind: 'item', ancestors: ['ANEXO I', '1'] });
    expect(by('1.1. Item do anexo').sectionPath).toBe('ANEXO I - MINUTA PADRÃO DE CONVÊNIO › 1. OBJETO DO ANEXO');
    expect(by('ANEXO II')).toMatchObject({ level: 1, ancestors: [], sectionPath: '' });
    expect(by('Declaro')).toMatchObject({ kind: 'paragraph', ancestors: ['ANEXO II'] });
    expect(parsed.stats).toMatchObject({ sections: 5, items: 4, tables: 0, footnotes: 0 });
  });

  it('subtítulo sem numeração cujo próximo bloco numerado é o IRMÃO seguinte fica sob o item corrente (Anexo 1 do MIB)', () => {
    const parsed = normalizeDocling(makeDoc([
      { label: 'section_header', text: 'ANEXO 1 - CARACTERÍSTICAS DA RODADA' },
      { label: 'list_item', text: '2. Grupo de Concorrência:' },
      { label: 'section_header', text: 'Linha Temática 1 - Tecnologias Digitais' },
      { label: 'text', text: 'Projetos de software e hardware.' },
      { label: 'section_header', text: 'Finalidades prioritárias:' },
      { label: 'text', text: 'Desenvolvimento de plataformas.' },
      { label: 'list_item', text: '3. Definição do Arranjo:' },
      { label: 'section_header', text: 'Nesse formato:' },
      { label: 'text', text: 'A empresa proponente executa sozinha.' },
      { label: 'list_item', text: '4. Prazo:' },
    ]), opts);
    const by = (t: string) => parsed.blocks.find((b) => b.text.startsWith(t))!;
    expect(by('2. Grupo')).toMatchObject({ kind: 'item', level: 2, itemNumber: '2', ancestors: ['ANEXO 1'] });
    expect(by('Linha Temática 1')).toMatchObject({ kind: 'section', level: 3, ancestors: ['ANEXO 1', '2'] });
    expect(by('Linha Temática 1').sectionPath).toBe('ANEXO 1 - CARACTERÍSTICAS DA RODADA › 2. Grupo de Concorrência:');
    expect(by('Projetos de software').sectionPath).toBe('ANEXO 1 - CARACTERÍSTICAS DA RODADA › 2. Grupo de Concorrência: › Linha Temática 1 - Tecnologias Digitais');
    // irmão do subtítulo anterior (não filho)
    expect(by('Finalidades prioritárias')).toMatchObject({ kind: 'section', level: 3, ancestors: ['ANEXO 1', '2'] });
    expect(by('3. Definição')).toMatchObject({ kind: 'item', level: 2, ancestors: ['ANEXO 1'] });
    expect(by('Nesse formato')).toMatchObject({ kind: 'section', level: 3, ancestors: ['ANEXO 1', '3'] });
    expect(by('A empresa proponente').sectionPath).toContain('3. Definição do Arranjo: › Nesse formato:');
    expect(parsed.blocks.filter((b) => b.kind === 'section' && b.level === 1)).toHaveLength(1);
  });

  it('tabelas: título de grupo (colspan total) e row_section viram divisórias; o cabeçalho real pode estar abaixo; célula quebrada por row_span é remontada', () => {
    const cell = (text: string, r: number, c: number, extra: Partial<DoclingTableCell> = {}, rs = 1, cs = 1): DoclingTableCell => ({
      text, row_span: rs, col_span: cs, start_row_offset_idx: r, end_row_offset_idx: r + rs, start_col_offset_idx: c, end_col_offset_idx: c + cs, ...extra,
    });
    const title = (text: string, r: number, extra: Partial<DoclingTableCell> = {}) => Array.from({ length: 3 }, () => cell(text, r, 0, extra, 1, 3));
    const grid: DoclingTableCell[][] = [
      title('Consistência da Proposta', 0, { column_header: true }),
      [cell('Consistência', 1, 0), cell('Analisará os parâmetros', 1, 1), cell('Sim ou não', 1, 2)],
      title('Grau de Inovação', 2, { row_section: true }),
      [cell('Indicador', 3, 0, { column_header: true }), cell('Descrição', 3, 1, { column_header: true }), cell('Peso', 3, 2, { column_header: true })],
      [cell('Abrangência', 4, 0), cell('Avalia o grau de ineditismo', 4, 1), cell('1', 4, 2)],
      // "Pequena Empresa" e "10%" cobrem as linhas 5 e 6; a coluna do meio veio quebrada em duas células
      [cell('Pequena Empresa', 5, 0, {}, 2), cell('De R$ 4.800.000,01 a', 5, 1), cell('10%', 5, 2, {}, 2)],
      [cell('Pequena Empresa', 5, 0, {}, 2), cell('R$ 16.000.000,00', 6, 1), cell('10%', 5, 2, {}, 2)],
    ];
    const doc = makeDoc([{ label: 'section_header', text: '12. AVALIAÇÃO' }, { label: 'list_item', text: '12.1. Critérios da tabela a seguir:' }]);
    doc.tables = [{
      self_ref: '#/tables/0', label: 'table', prov: [{ page_no: 1, bbox: { l: 50, t: 700, r: 500, b: 500, coord_origin: 'BOTTOMLEFT' } }],
      data: { num_rows: 7, num_cols: 3, grid },
    }];
    doc.body.children.push({ $ref: '#/tables/0' });
    const parsed = normalizeDocling(doc, opts);
    const table = parsed.blocks.find((b) => b.kind === 'table')!;
    expect(table.table).toMatchObject({ numRows: 6, numCols: 3, headerRows: [3], sectionRows: [0, 2], caption: '12.1. Critérios da tabela a seguir:' });
    expect(table.table!.rows[5]).toEqual(['Pequena Empresa', 'De R$ 4.800.000,01 a R$ 16.000.000,00', '10%']);
    const md = tableToMarkdown(table.table!).split('\n');
    expect(md[0]).toBe('| Indicador | Descrição | Peso |');
    expect(md[2]).toBe('| **Consistência da Proposta** |  |  |');
    expect(md[3]).toBe('| Consistência | Analisará os parâmetros | Sim ou não |');
    expect(md[4]).toBe('| **Grau de Inovação** |  |  |');
    expect(md[5]).toBe('| Abrangência | Avalia o grau de ineditismo | 1 |');
    expect(md).toHaveLength(7);
    // texto do bloco: divisória aparece uma vez só
    expect(table.text.split('\n')[0]).toBe('Consistência da Proposta');
    const layout = tableLayout(table.table!);
    expect(layout.names).toEqual(['Indicador', 'Descrição', 'Peso']);
    expect(layout.dataRows).toEqual([0, 1, 2, 4, 5]);
    expect(layout.sectionTitle(4)).toBe('Grau de Inovação');
    expect(layout.sectionTitle(1)).toBe('Consistência da Proposta');
    expect(layout.isSection(2)).toBe(true);
  });
});

describe('detectNumbering', () => {
  it.each([
    ['6. DESPESAS APOIÁVEIS', { kind: 'section', level: 1, itemNumber: '6', rest: 'DESPESAS APOIÁVEIS' }],
    ['15 CRONOGRAMA', { kind: 'section', level: 1, itemNumber: '15' }],
    ['11.Disposição Geral', { kind: 'section', level: 1, itemNumber: '11', rest: 'Disposição Geral' }],
    ['1.1. Selecionar propostas', { kind: 'item', level: 2, itemNumber: '1.1', rest: 'Selecionar propostas' }],
    ['6.5.5. Pagamento de pessoal:', { kind: 'item', level: 3, itemNumber: '6.5.5' }],
    ['2.1.10 Agricultura Familiar', { kind: 'item', level: 3, itemNumber: '2.1.10' }],
    ['6.5.2.1. Para despesas', { kind: 'item', level: 4, itemNumber: '6.5.2.1' }],
    ['a) Credenciamento ou Autorização', { kind: 'alinea', level: 0, itemNumber: 'a', rest: 'Credenciamento ou Autorização' }],
    ['I - Instituições públicas', { kind: 'alinea', level: 0, itemNumber: 'I', rest: 'Instituições públicas' }],
    ['II – texto do inciso', { kind: 'alinea', level: 0, itemNumber: 'II' }],
    ['ANEXO I - MINUTA PADRÃO DE CONVÊNIO', { kind: 'section', level: 1, itemNumber: 'ANEXO I', rest: 'MINUTA PADRÃO DE CONVÊNIO' }],
    ['ANEXO 3 – EXIGÊNCIAS', { kind: 'section', level: 1, itemNumber: 'ANEXO 3' }],
    ['CLÁUSULA TERCEIRA - DO OBJETO', { kind: 'section', level: 1, itemNumber: 'CLÁUSULA TERCEIRA', rest: 'DO OBJETO' }],
    ['CLAUSULA 3ª - DO PRAZO', { kind: 'section', level: 1, itemNumber: 'CLÁUSULA 3ª' }],
    ['Art. 5º Os recursos', { kind: 'item', level: 2, itemNumber: 'Art. 5', rest: 'Os recursos' }],
    ['§ 1º O prazo', { kind: 'item', level: 3, itemNumber: '§ 1', rest: 'O prazo' }],
    ['Parágrafo único. Aplica-se', { kind: 'item', level: 3, itemNumber: 'Parágrafo único' }],
  ])('%s', (text, expected) => {
    expect(detectNumbering(text)).toMatchObject(expected);
  });

  it.each([
    '19/06/2026 é o término do prazo',
    'R$ 1.000,00 (mil reais)',
    '2024 foi o ano de lançamento',
    'Selecionar propostas para concessão',
    'Os projetos deverão ser analisados',
    'https://financiamento.finep.gov.br',
    '30% dos recursos',
  ])('não é numeração: %s', (text) => {
    expect(detectNumbering(text)).toBeNull();
  });
});

describe('normalizeText', () => {
  it('colapsa espaços, NBSP e remove hífen de quebra de linha', () => {
    expect(normalizeText('desen- volvimento  de projetos')).toBe('desenvolvimento de projetos');
    expect(normalizeText('  Cadeias   Socioprodutivas \n da Bioeconomia ')).toBe('Cadeias Socioprodutivas da Bioeconomia');
  });
  it('preserva hífens legítimos de prefixo e converte ligaduras', () => {
    expect(normalizeText('pré- escolar e pós- graduação')).toBe('pré-escolar e pós-graduação');
    expect(normalizeText('ﬁnanciamento eﬁciente e ﬂuxo')).toBe('financiamento eficiente e fluxo');
  });
});

describe('tableToMarkdown / sectionAnchor', () => {
  it('gera GFM com linha de cabeçalho, separador e escape de "|"', () => {
    const md = tableToMarkdown({ numRows: 3, numCols: 2, headerRows: [0], rows: [['Fase', 'Data'], ['Lançamento', '24/03/2026'], ['A | B', 'x']] });
    expect(md.split('\n')).toEqual(['| Fase | Data |', '| --- | --- |', '| Lançamento | 24/03/2026 |', '| A \\| B | x |']);
  });
  it('sem headerRows a primeira linha assume o papel de cabeçalho; tabela vazia → ""', () => {
    expect(tableToMarkdown({ numRows: 2, numCols: 1, headerRows: [], rows: [['a'], ['b']] })).toBe('| a |\n| --- |\n| b |');
    expect(tableToMarkdown({ numRows: 0, numCols: 0, headerRows: [], rows: [] })).toBe('');
  });
  it('âncoras estáveis a partir do itemNumber ou do texto', () => {
    expect(sectionAnchor({ kind: 'item', itemNumber: '6.5.5', text: 'x' })).toBe('sec-6.5.5');
    expect(sectionAnchor({ kind: 'section', itemNumber: 'ANEXO I', text: 'x' })).toBe('sec-anexo-i');
    expect(sectionAnchor({ kind: 'item', itemNumber: '§ 1', text: 'x' })).toBe('sec-par-1');
    expect(sectionAnchor({ kind: 'title', text: 'Chamada' })).toBe('sec-titulo');
    expect(sectionAnchor({ kind: 'section', text: 'Disposições Gerais' })).toBe('sec-disposicoes-gerais');
  });
});

describe('buildCanonical (fixture real)', () => {
  const parsed = parseFixture();
  const canonical = buildCanonical(parsed);

  it('gera markdown com âncoras {#sec-… p=N} nos cabeçalhos e itens', () => {
    expect(canonical.markdown).toMatch(/^# CHAMADA PÚBLICA .* \{#sec-titulo p=1\}\n\n## 1\. OBJETIVO E LINHAS TEMÁTICAS \{#sec-1 p=1\}\n\n/);
    expect(canonical.markdown).toContain('### 6.5. Despesas Correntes {#sec-6.5 p=9}');
    expect(canonical.markdown).toMatch(/6\.5\.5\.1\. A proposta poderá prever [^\n]* \{#sec-6\.5\.5\.1 p=10\}/);
    expect(canonical.markdown).toContain('| Fase | Data |\n| --- | --- |\n| Lançamento da Chamada | A partir de 24/03/2026 |');
    expect(canonical.markdown.endsWith('\n')).toBe(true);
  });

  it('sections.json: uma entrada por título/seção/item, âncoras únicas, offsets crescentes e aninhados', () => {
    const anchored = parsed.blocks.filter((b) => b.kind === 'title' || b.kind === 'section' || b.kind === 'item');
    expect(canonical.sections).toHaveLength(anchored.length);
    expect(new Set(canonical.sections.map((s) => s.anchor)).size).toBe(canonical.sections.length);
    const s15 = canonical.sections.find((s) => s.anchor === 'sec-15')!;
    const s151 = canonical.sections.find((s) => s.anchor === 'sec-15.1')!;
    const s16 = canonical.sections.find((s) => s.anchor === 'sec-16')!;
    expect(s15).toMatchObject({ itemNumber: '15', heading: '15. CRONOGRAMA', page: 21 });
    expect(s15.charStart).toBeLessThan(s151.charStart);
    expect(s151.charEnd).toBeLessThanOrEqual(s15.charEnd);
    expect(s15.charEnd).toBeLessThanOrEqual(s16.charStart);
    expect(canonical.markdown.slice(s15.charStart, s15.charEnd)).toContain('26/06/2026');
    for (const s of canonical.sections) expect(s.charStart).toBeLessThan(s.charEnd);
  });

  it('blockOffsets: um por bloco, em ordem, e markdown.slice(charStart, charEnd) contém o início do texto do bloco', () => {
    expect(canonical.blockOffsets.map((o) => o.blockIndex)).toEqual(parsed.blocks.map((b) => b.index));
    let prevEnd = -1;
    for (const o of canonical.blockOffsets) {
      const b = parsed.blocks[o.blockIndex]!;
      expect(o.charStart).toBeGreaterThan(prevEnd);
      expect(o.charEnd).toBeGreaterThan(o.charStart);
      expect(o.charEnd).toBeLessThanOrEqual(canonical.markdown.length);
      const slice = canonical.markdown.slice(o.charStart, o.charEnd);
      const head = b.kind === 'table' ? b.table!.rows[0]![0]! : b.text.slice(0, 40);
      expect(slice, `bloco ${b.index}`).toContain(head);
      prevEnd = o.charEnd;
    }
  });

  it('é determinístico', () => {
    const again = buildCanonical(parseFixture());
    expect(again.markdown).toBe(canonical.markdown);
    expect(again.blockOffsets).toEqual(canonical.blockOffsets);
  });
});
