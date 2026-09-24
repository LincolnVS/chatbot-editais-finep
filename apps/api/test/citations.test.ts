import { describe, expect, it } from 'vitest';
import { tokenize } from '@editais/shared';
import { normalizeLabels, extractLabels, extractSectionAnchors, splitSentences, validateCitations, validateSectionCitations, MAX_QUOTE_CHARS } from '../src/llm/citations.ts';
import { CHUNK_CONTRAPARTIDA, CHUNK_CRONOGRAMA, CHUNK_PRAZO, CHUNK_RECURSO, CHUNK_SEM_SECAO, CONTEXT, DOC_ID, DOC_TITLE, makeChunk } from './helpers/llm-fixtures.ts';

const L = {
  prazo: CHUNK_PRAZO.label,
  recurso: CHUNK_RECURSO.label,
  contrapartida: CHUNK_CONTRAPARTIDA.label,
  cronograma: CHUNK_CRONOGRAMA.label,
};

describe('normalizeLabels', () => {
  it('canoniza espaços, listas e colchetes duplos para [c_x] [c_y]', () => {
    expect(normalizeLabels('Prazo 09/04 [ c_99e095 ].')).toBe('Prazo 09/04 [c_99e095].');
    expect(normalizeLabels('A [c_aaaaaa, c_bbbbbb] e B [c_cccccc; c_dddddd e c_eeeeee].')).toBe('A [c_aaaaaa] [c_bbbbbb] e B [c_cccccc] [c_dddddd] [c_eeeeee].');
    expect(normalizeLabels('X [[c_aaaaaa]] Y [sec-9.1, sec-13.2]')).toBe('X [c_aaaaaa] Y [sec-9.1] [sec-13.2]');
    expect(normalizeLabels('texto sem rótulo [nota 1] e [c_abc]')).toBe('texto sem rótulo [nota 1] e [c_abc]');
    expect(normalizeLabels('A [**c_aaaaaa**] e **[c_bbbbbb]** e [_c_cccccc_], mas **negrito** [c_dddddd].')).toBe('A [c_aaaaaa] e [c_bbbbbb] e [c_cccccc], mas **negrito** [c_dddddd].');
    expect(normalizeLabels('Prazo 09/04 [sec-15 p=1 (1a_rerratificacao)]; antes 07/04 [sec-15 p=14 (original)].')).toBe('Prazo 09/04 [sec-15]; antes 07/04 [sec-15].');
  });

  it('aceita colchetes CJK/fullwidth, parênteses, chaves e rótulos soltos', () => {
    expect(normalizeLabels('Valor original: 07/04/2026【c_7cd8e2】.')).toBe('Valor original: 07/04/2026 [c_7cd8e2].');
    expect(normalizeLabels('Retificado ［c_99e095］ e 〔c_7cd8e2, c_99e095〕')).toBe('Retificado [c_99e095] e [c_7cd8e2] [c_99e095]');
    expect(normalizeLabels('Prazo (c_aaaaaa) e {c_bbbbbb} e <c_cccccc>')).toBe('Prazo [c_aaaaaa] e [c_bbbbbb] e [c_cccccc]');
    expect(normalizeLabels('Prazo de 36 meses c_aaaaaa. Recurso **c_bbbbbb**, e sec-13.2 também.')).toBe('Prazo de 36 meses [c_aaaaaa]. Recurso [c_bbbbbb], e [sec-13.2] também.');
    expect(normalizeLabels('(ver item 6.5.5 [c_aaaaaa]) e [c_bbbbbb][c_cccccc]')).toBe('(ver item 6.5.5 [c_aaaaaa]) e [c_bbbbbb] [c_cccccc]');
    expect(normalizeLabels('Prazo [c_aaaaaa, p. 14] e [sec-d2-15 p=14].')).toBe('Prazo [c_aaaaaa] e [sec-d2-15].');
  });

  it('não altera texto comum nem identificadores parecidos', () => {
    expect(normalizeLabels('abc_ab12cd não é rótulo; nem c_ab12 nem [c_zz].')).toBe('abc_ab12cd não é rótulo; nem c_ab12 nem [c_zz].');
    expect(normalizeLabels('Item 6.5.5 (trinta) e valor R$ 1.000,00 [nota].')).toBe('Item 6.5.5 (trinta) e valor R$ 1.000,00 [nota].');
  });

  it('extractLabels e validateCitations aceitam as variações', () => {
    expect(extractLabels('A [ c_aaaaaa ] e [c_bbbbbb, c_aaaaaa]')).toEqual(['c_aaaaaa', 'c_bbbbbb']);
    const r = validateCitations(`Prazo de 36 meses [ ${L.prazo} ].`, CONTEXT);
    expect(r.citations.map((c) => c.label)).toEqual([L.prazo]);
    expect(r.textWithOrdinals).toBe('Prazo de 36 meses [1].');
  });
});

describe('extractLabels', () => {
  it('devolve rótulos únicos na ordem de primeira aparição', () => {
    const text = `A [c_aaaaaa] e B [c_bbbbbb]; de novo [c_aaaaaa]. Inválido [c_ZZZZZZ] e [c_abc] não contam.`;
    expect(extractLabels(text)).toEqual(['c_aaaaaa', 'c_bbbbbb']);
  });

  it('extrai âncoras [sec-…] do baseline', () => {
    expect(extractSectionAnchors('Prazo de 36 meses [sec-9.1]. Recurso [sec-13.2] e de novo [sec-9.1].')).toEqual(['sec-9.1', 'sec-13.2']);
  });
});

describe('splitSentences', () => {
  it('divide sentenças simples em pt-BR', () => {
    expect(splitSentences('O prazo é de 36 meses. A contrapartida é isenta! Há recurso? Sim.')).toEqual([
      'O prazo é de 36 meses.',
      'A contrapartida é isenta!',
      'Há recurso?',
      'Sim.',
    ]);
  });

  it('preserva abreviações (art., n.º, S.A.) e valores monetários', () => {
    const text = 'Nos termos do art. 97 da LDO. O valor é de R$ 1.000,00. A Empresa S.A. deve enviar o cadastro n.º 15 no prazo.';
    expect(splitSentences(text)).toEqual([
      'Nos termos do art. 97 da LDO.',
      'O valor é de R$ 1.000,00.',
      'A Empresa S.A. deve enviar o cadastro n.º 15 no prazo.',
    ]);
  });

  it('não quebra em numeração de item ("6." / "6.5.5.") nem em minúscula após ponto', () => {
    expect(splitSentences('Ver item 6. DESPESAS APOIÁVEIS e o 6.5.5. Texto do item. fim da linha continua')).toEqual([
      'Ver item 6. DESPESAS APOIÁVEIS e o 6.5.5. Texto do item. fim da linha continua',
    ]);
  });

  it('trata quebras de linha como fronteiras (linhas de tabela e alíneas)', () => {
    const lines = splitSentences(CHUNK_CRONOGRAMA.text);
    expect(lines[0]).toBe('| Fase | Data |');
    expect(lines).toContain('| Término do prazo para envio da proposta na Plataforma de Apoio e Financiamento | 26/06/2026 |');
    expect(splitSentences('a) documento A;\nb) documento B.\n\n')).toEqual(['a) documento A;', 'b) documento B.']);
  });
});

describe('tokenize', () => {
  it('ignora stopwords e palavras curtas, mantém números e identificadores', () => {
    expect(tokenize('O prazo para envio da proposta é 26/06/2026, item 6.5.5, com 36 meses e R$ 500.000,00')).toEqual([
      'prazo', 'envio', 'proposta', '26/06/2026', '6.5.5', '36', 'meses', '500.000,00',
    ]);
    expect(tokenize('Não consta nos documentos')).toEqual(['consta', 'documentos']);
  });
});

describe('validateCitations', () => {
  it('rótulo válido gera Citation com ordinal, página, seção e quote', () => {
    const text = `O prazo de execução é de até 36 (trinta e seis) meses [${L.prazo}].`;
    const v = validateCitations(text, CONTEXT);
    expect(v.hasAnyCitation).toBe(true);
    expect(v.invalidLabels).toEqual([]);
    expect(v.citations).toHaveLength(1);
    const c = v.citations[0]!;
    expect(c).toMatchObject({
      ordinal: 1,
      label: L.prazo,
      chunkRowid: CHUNK_PRAZO.rowid,
      documentId: DOC_ID,
      documentTitle: DOC_TITLE,
      docType: 'edital',
      page: 14,
      sectionPath: '9. PRAZO DE EXECUÇÃO',
      itemNumber: '9.1',
      exists: true,
      hasSection: true,
    });
    expect(c.bboxes).toEqual(CHUNK_PRAZO.bboxes);
    expect(c.quote).toBe(CHUNK_PRAZO.text);
    expect(v.text).toBe(text);
    expect(v.textWithOrdinals).toBe('O prazo de execução é de até 36 (trinta e seis) meses [1].');
  });

  it('rótulo inexistente é removido do texto e contado em invalidLabels', () => {
    const text = `O prazo é de 36 meses [c_000000]. A contrapartida é isenta para ICT federal [${L.contrapartida}].`;
    const v = validateCitations(text, CONTEXT);
    expect(v.invalidLabels).toEqual(['c_000000']);
    expect(v.citations.map((c) => c.label)).toEqual([L.contrapartida]);
    expect(v.text).toBe(`O prazo é de 36 meses. A contrapartida é isenta para ICT federal [${L.contrapartida}].`);
    expect(v.textWithOrdinals).toBe('O prazo é de 36 meses. A contrapartida é isenta para ICT federal [1].');
  });

  it('rótulo repetido reutiliza o ordinal e gera uma única Citation', () => {
    const text = `O prazo é de 36 meses [${L.prazo}]. É prorrogável a critério da Finep [${L.prazo}]. Recurso em 10 dias [${L.recurso}]. De novo o prazo [${L.prazo}].`;
    const v = validateCitations(text, CONTEXT);
    expect(v.citations.map((c) => [c.ordinal, c.label])).toEqual([[1, L.prazo], [2, L.recurso]]);
    expect(v.textWithOrdinals).toBe('O prazo é de 36 meses [1]. É prorrogável a critério da Finep [1]. Recurso em 10 dias [2]. De novo o prazo [1].');
  });

  it('ordinais seguem a ordem de primeira aparição, não a ordem do contexto', () => {
    const text = `Cadastro até 19/06/2026 [${L.cronograma}]. Recurso em 10 dias corridos [${L.recurso}]. Prazo de 36 meses [${L.prazo}].`;
    const v = validateCitations(text, CONTEXT);
    expect(v.citations.map((c) => c.label)).toEqual([L.cronograma, L.recurso, L.prazo]);
    expect(v.citations.map((c) => c.ordinal)).toEqual([1, 2, 3]);
  });

  it('quote = sentença do chunk com maior sobreposição com a afirmação que precede o rótulo', () => {
    const text = `O recurso pode ser interposto em até 10 dias corridos [${L.recurso}]. Se o vencimento cair em dia sem expediente, o prazo é prorrogado até o primeiro dia útil seguinte [${L.recurso}].`;
    const v = validateCitations(text, CONTEXT);
    // Uma Citation só (rótulo repetido) — o quote é o da primeira afirmação.
    expect(v.citations).toHaveLength(1);
    expect(v.citations[0]!.quote).toMatch(/^13\.2\. O prazo para interposição do recurso será de até 10 \(dez\) dias corridos/);

    const text2 = `Se o vencimento cair em dia sem expediente, o prazo é prorrogado até o primeiro dia útil seguinte [${L.recurso}].`;
    expect(validateCitations(text2, CONTEXT).citations[0]!.quote).toMatch(/^13\.3\. Considera-se prorrogado o prazo/);
  });

  it('quote em tabela é a linha correspondente à afirmação', () => {
    const text = `O prazo para envio da proposta termina em 26/06/2026 [${L.cronograma}].`;
    const v = validateCitations(text, CONTEXT);
    expect(v.citations[0]!.quote).toBe('| Término do prazo para envio da proposta na Plataforma de Apoio e Financiamento | 26/06/2026 |');
  });

  it('quote cai na primeira sentença quando não há sobreposição e respeita 400 chars', () => {
    const longo = makeChunk({ orderIndex: 90, itemNumber: '2.1', sectionPath: '2. DEFINIÇÕES', page: 3, text: `2.1 ${'palavra '.repeat(120)}fim` });
    const v = validateCitations(`Xyz qwe [${longo.label}].`, [longo]);
    expect(v.citations[0]!.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(v.citations[0]!.quote.endsWith('…')).toBe(true);
    expect(v.citations[0]!.quote.startsWith('2.1 palavra')).toBe(true);
  });

  it('rótulos adjacentes compartilham a afirmação do parágrafo', () => {
    const text = `A contrapartida é isenta para ICT federal e o prazo de execução é de 36 meses [${L.contrapartida}] [${L.prazo}].`;
    const v = validateCitations(text, CONTEXT);
    expect(v.citations).toHaveLength(2);
    expect(v.citations[0]!.quote).toBe(CHUNK_CONTRAPARTIDA.text);
    expect(v.citations[1]!.quote).toBe(CHUNK_PRAZO.text);
  });

  it('hasSection é false para chunk sem itemNumber e sem sectionPath; versionLabel e docType são propagados', () => {
    const apoio = makeChunk({
      orderIndex: 5,
      sectionPath: 'Proposta › 1. Objetivos',
      page: 2,
      docType: 'apoio',
      documentId: 'DOC_APOIO',
      documentTitle: 'Rascunho da proposta',
      versionLabel: 'v2',
      text: 'O projeto pretende desenvolver bioinsumos a partir de resíduos agrícolas.',
    });
    const text = `Chamada aberta [${CHUNK_SEM_SECAO.label}]. Sua proposta trata de bioinsumos [${apoio.label}].`;
    const v = validateCitations(text, [CHUNK_SEM_SECAO, apoio]);
    expect(v.citations[0]).toMatchObject({ hasSection: false, sectionPath: '', docType: 'edital' });
    expect(v.citations[0]!.itemNumber).toBeUndefined();
    expect(v.citations[1]).toMatchObject({ hasSection: true, docType: 'apoio', versionLabel: 'v2', documentTitle: 'Rascunho da proposta', documentId: 'DOC_APOIO' });
  });

  it('texto sem rótulos → sem citações, texto intacto; contexto vazio remove todo rótulo', () => {
    const v = validateCitations('Não consta nos documentos selecionados.', CONTEXT);
    expect(v).toMatchObject({ hasAnyCitation: false, citations: [], invalidLabels: [], text: 'Não consta nos documentos selecionados.' });

    const v2 = validateCitations(`Prazo de 36 meses [${L.prazo}].`, []);
    expect(v2.hasAnyCitation).toBe(false);
    expect(v2.invalidLabels).toEqual([L.prazo]);
    expect(v2.text).toBe('Prazo de 36 meses.');
  });
});

describe('validateSectionCitations (baseline)', () => {
  const markdown =
    '# Chamada Pública {#sec-titulo p=1}\n\n' +
    '## 9. PRAZO DE EXECUÇÃO {#sec-9 p=14}\n\n' +
    '9.1. O prazo de execução da proposta deverá ser de até 36 (trinta e seis) meses, prorrogável, justificadamente, a critério da Finep.\n\n' +
    '## 13. RECURSOS ADMINISTRATIVOS {#sec-13 p=20}\n\n' +
    '13.2. O prazo para interposição do recurso será de até 10 (dez) dias corridos a contar da data de divulgação do resultado preliminar.\n\n' +
    '13.3. Considera-se prorrogado o prazo até o primeiro dia útil seguinte se o vencimento cair em dia sem expediente.\n';
  const sec9Start = markdown.indexOf('## 9.');
  const sec13Start = markdown.indexOf('## 13.');
  const sections = [
    { anchor: 'sec-titulo', heading: 'Chamada Pública', page: 1, charStart: 0, charEnd: sec9Start },
    { anchor: 'sec-9', itemNumber: '9', heading: '9. PRAZO DE EXECUÇÃO', page: 14, charStart: sec9Start, charEnd: sec13Start },
    { anchor: 'sec-13', itemNumber: '13', heading: '13. RECURSOS ADMINISTRATIVOS', page: 20, charStart: sec13Start, charEnd: markdown.length },
  ].map((s) => ({ ...s, documentId: DOC_ID, documentTitle: DOC_TITLE, docType: 'edital' as const, markdown }));

  it('valida âncoras, resolve página e quote do trecho da seção, remove âncoras inexistentes', () => {
    const text = 'O prazo de execução é de até 36 meses [sec-9]. O recurso deve ser interposto em 10 dias corridos [sec-13]. Algo inventado [sec-99].';
    const v = validateSectionCitations(text, sections);
    expect(v.invalidLabels).toEqual(['sec-99']);
    expect(v.citations.map((c) => [c.ordinal, c.label, c.page])).toEqual([[1, 'sec-9', 14], [2, 'sec-13', 20]]);
    expect(v.citations[0]).toMatchObject({ chunkRowid: 0, documentId: DOC_ID, docType: 'edital', sectionPath: '9. PRAZO DE EXECUÇÃO', itemNumber: '9', hasSection: true, exists: true, bboxes: [] });
    expect(v.citations[0]!.quote).toMatch(/^9\.1\. O prazo de execução/);
    expect(v.citations[1]!.quote).toMatch(/^13\.2\. O prazo para interposição do recurso/);
    expect(v.citations[1]!.quote).not.toContain('{#sec-');
    expect(v.text).toBe('O prazo de execução é de até 36 meses [sec-9]. O recurso deve ser interposto em 10 dias corridos [sec-13]. Algo inventado.');
    expect(v.textWithOrdinals).toBe('O prazo de execução é de até 36 meses [1]. O recurso deve ser interposto em 10 dias corridos [2]. Algo inventado.');
  });

  it('aceita `markdown` já fatiado (só o trecho da seção)', () => {
    const only = [{ ...sections[1]!, markdown: markdown.slice(sec9Start, sec13Start) }];
    const v = validateSectionCitations('Prazo de 36 meses [sec-9].', only);
    expect(v.citations[0]!.quote).toMatch(/^9\.1\. O prazo de execução/);
  });
});
