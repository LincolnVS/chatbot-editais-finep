import { describe, expect, it } from 'vitest';
import { validateCitations } from '../src/llm/citations.ts';
import { extractValues, isFactual, normalizeValue, splitBlocks } from '@editais/shared';
import { applyGrounding, repairInstruction, sourceValues, UNSUPPORTED_FALLBACK } from '../src/llm/grounding.ts';
import { CHUNK_CONTRAPARTIDA, CHUNK_CRONOGRAMA, CHUNK_PRAZO, CHUNK_RECURSO, CONTEXT } from './helpers/llm-fixtures.ts';

const L = { prazo: CHUNK_PRAZO.label, recurso: CHUNK_RECURSO.label, contrapartida: CHUNK_CONTRAPARTIDA.label, cronograma: CHUNK_CRONOGRAMA.label };
const byLabel = new Map(CONTEXT.map((c) => [c.label, c]));
const sourceText = (label: string) => byLabel.get(label)?.text;

function ground(text: string, policy: 'strict' | 'warn' | 'off' = 'strict', contextValues?: Set<string>) {
  const v = validateCitations(text, CONTEXT);
  return applyGrounding({ text: v.text, citations: v.citations, sourceText, contextValues, policy });
}

describe('normalizeValue / extractValues', () => {
  it('canoniza datas, dinheiro, percentuais, horários e números', () => {
    expect(normalizeValue('9/4/2026')).toBe('09/04/2026');
    expect(normalizeValue('09 de abril de 2026')).toBe('09/04/2026');
    expect(normalizeValue('07/04/26')).toBe('07/04/2026');
    expect(normalizeValue('R$ 1.000.000,00')).toBe('R$1000000');
    expect(normalizeValue('R$ 1 milhão')).toBe('R$1000000');
    expect(normalizeValue('R$ 2,5 milhões')).toBe('R$2500000');
    expect(normalizeValue('1.500,50')).toBe('1500,50');
    expect(normalizeValue('18h00')).toBe('18:00');
    expect(normalizeValue('18h')).toBe('18:00');
    expect(normalizeValue('20 %')).toBe('20%');
    expect(normalizeValue('6.5.5')).toBe('6.5.5');
    expect(normalizeValue('36')).toBe('36');
  });

  it('extrai os valores de uma afirmação ignorando rótulos', () => {
    expect(extractValues('O prazo é 09/04/2026 até às 18h00, item 6.5.5, R$ 1.500,00 e 20% [c_7cd8e2].')).toEqual([
      '09/04/2026', '18:00', '6.5.5', 'R$1500', '20%',
    ]);
    expect(extractValues('Prazo de até 36 (trinta e seis) meses e 3 (três) anos.')).toEqual(['36', '3']);
    expect(extractValues('Sem números aqui.')).toEqual([]);
    // Multiplicadores: "R$ 5 milhões" não pode ser lido como "R$ 5 mil" (a verificação de valores do gate depende disso).
    expect(extractValues('entre R$ 5 milhões e R$ 25.000.000,00, com teto de R$ 500 mil por item e R$ 1,5 bilhão no total')).toEqual(['R$5000000', 'R$25000000', 'R$500000', 'R$1500000000']);
  });

  it('sourceValues traz todas as leituras de um trecho', () => {
    const set = sourceValues('Envio até 09/04/2026 às 18h00. Valor: R$ 1.500.000,00 (item 6.5.5).');
    for (const v of ['09/04/2026', '18:00', 'R$1500000', '1500000', '6.5.5', '2026']) expect(set.has(v)).toBe(true);
  });
});

describe('splitBlocks / isFactual', () => {
  it('separa cabeçalhos, listas, tabelas e parágrafos', () => {
    const blocks = splitBlocks('## Prazo\n\nO prazo é 36 meses [c_aaaaaa].\nSegue na mesma linha.\n\n- item um com 10 dias\n- item dois\n\n| a | b |\n| --- | --- |\n| 10 | 20 |\n\nEm resumo:');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'table', 'paragraph']);
    expect(blocks[1]?.labels).toEqual(['c_aaaaaa']);
    expect(blocks.map((b) => b.factual)).toEqual([false, true, true, false, true, false]);
  });

  it('linha só de citações depois de tabela ou lista referencia o bloco anterior', () => {
    const blocks = splitBlocks('| a | b |\n| --- | --- |\n| 10 | 20 |\n\n[c_aaaaaa] [c_bbbbbb]\n\n- item um com 10 dias\n- item dois com 20 dias\n\n[c_cccccc]\n\n## Título\n\n[c_dddddd]');
    expect(blocks.map((b) => b.kind)).toEqual(['table', 'paragraph', 'list', 'list', 'paragraph', 'heading', 'paragraph']);
    expect(blocks[0]?.labels).toEqual(['c_aaaaaa', 'c_bbbbbb']);
    expect(blocks[1]?.factual).toBe(false);
    expect(blocks[1]?.citationLineFor).toEqual([blocks[0]]);
    // a lista inteira recebe a citação
    expect(blocks[2]?.labels).toEqual(['c_cccccc']);
    expect(blocks[3]?.labels).toEqual(['c_cccccc']);
    // depois de cabeçalho não há a que se ligar
    expect(blocks[6]?.labels).toEqual(['c_dddddd']);
    expect(blocks[6]?.citationLineFor).toBeUndefined();
  });

  it('frase citada que abre tabela ou lista (terminando em dois-pontos) passa a citação ao bloco seguinte', () => {
    const blocks = splitBlocks('As datas são [c_aaaaaa]:\n\n| a | b |\n| --- | --- |\n| 10 | 20 |\n\nExige-se [c_bbbbbb]:\n\n- item um com 10 dias\n- item dois com 20 dias [c_cccccc]\n\nO prazo é 36 meses [c_dddddd].\n\n| x | y |\n| --- | --- |\n| 1 | 2 |');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'table', 'paragraph', 'list', 'list', 'paragraph', 'table']);
    expect(blocks[1]?.labels).toEqual(['c_aaaaaa']);
    expect(blocks[3]?.labels).toEqual(['c_bbbbbb']);
    // item que cita a própria fonte fica com ela
    expect(blocks[4]?.labels).toEqual(['c_cccccc']);
    // sem dois-pontos a frase não abre a tabela seguinte
    expect(blocks[6]?.labels).toEqual([]);
  });

  it('gate estrito mantém a tabela aberta por frase citada, mas continua barrando valor que a fonte não tem', () => {
    const certa = `As datas do cronograma são [${L.cronograma}]:\n\n| Fase | Data |\n| --- | --- |\n| Envio da proposta | 26/06/2026 |\n| Resultado preliminar | 20/07/2026 |`;
    const ok = ground(certa);
    expect(ok.text).toContain('26/06/2026');
    expect(ok.report.issues).toEqual([]);
    const inventada = `As datas do cronograma são [${L.cronograma}]:\n\n| Fase | Data |\n| --- | --- |\n| Envio da proposta | 30/06/2026 |`;
    expect(ground(inventada).text).not.toContain('30/06/2026');
  });

  it('linha de citação colada na tabela fica depois dela e a referencia', () => {
    const blocks = splitBlocks('Os percentuais:\n\n| Porte | % |\n| --- | --- |\n| Micro | 5% |\n[c_aaaaaa]');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(blocks[0]?.labels).toEqual([]);
    expect(blocks[1]?.labels).toEqual(['c_aaaaaa']);
    expect(blocks[2]?.factual).toBe(false);
  });

  it('linha de citação com a referência ao item entre parênteses ainda é linha de citação', () => {
    const blocks = splitBlocks('| Porte | % |\n| --- | --- |\n| Micro | 5% |\n\n[c_aaaaaa] (item 9.5)');
    expect(blocks[0]?.labels).toEqual(['c_aaaaaa']);
    expect(blocks[1]?.factual).toBe(false);
    expect(splitBlocks('| a | b |\n| --- | --- |\n| 10 | 20 |\n\n[c_aaaaaa] conforme o prazo de 10 dias')[0]?.labels).toEqual([]);
  });

  it('linha recuada logo abaixo de um item de lista é continuação do item', () => {
    const blocks = splitBlocks('2. **Equipe** — Notas: 1-5 | **Peso: 5**\n   (composição e vínculo) [c_aaaaaa]\n3. **Consistência** — Notas: 1-5 | **Peso: 5**\n   (cronograma) [c_bbbbbb]');
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'list']);
    expect(blocks.map((b) => b.labels)).toEqual([['c_aaaaaa'], ['c_bbbbbb']]);
  });

  it('item de lista citado que abre sub-lista passa a citação só aos itens recuados', () => {
    const blocks = splitBlocks('2. **Grau de Inovação** — indicadores com peso 1 cada [c_aaaaaa]:\n   - Abrangência do projeto em várias regiões\n   - Parceria com Instituições Científicas, Tecnológicas e de Inovação\n3. **Relevância da Inovação** com seus indicadores de mercado');
    expect(blocks.map((b) => b.labels)).toEqual([['c_aaaaaa'], ['c_aaaaaa'], ['c_aaaaaa'], []]);
    const semCitacao = splitBlocks('2. **Grau de Inovação** — indicadores com peso 1 cada:\n   - Parceria com Instituições Científicas, Tecnológicas e de Inovação');
    expect(semCitacao[1]?.labels).toEqual([]);
  });

  it('não trata como factual pergunta, abstenção ou conectivo curto', () => {
    expect(isFactual('Você se refere ao edital de 2025 ou ao de 2026?', 'paragraph')).toBe(true);
    expect(isFactual('Você quer o prazo de envio ou o de execução?', 'paragraph')).toBe(false);
    expect(isFactual('Não consta nos documentos selecionados.', 'paragraph')).toBe(false);
    expect(isFactual('Detalhes:', 'paragraph')).toBe(false);
    expect(isFactual('- Documentos exigidos:', 'list')).toBe(false);
    expect(isFactual('**Proponente elegível — requisitos gerais:**', 'paragraph')).toBe(false);
    expect(isFactual('- **Documentos exigidos:**', 'list')).toBe(false);
    expect(isFactual('**Prazo de execução: 36 meses**', 'paragraph')).toBe(true);
    const longa = 'As instituições proponentes deverão apresentar, no momento da submissão eletrônica da proposta, os documentos relacionados:';
    expect(isFactual(longa, 'paragraph')).toBe(true);
    expect(isFactual(`**${longa}**`, 'paragraph')).toBe(true);
    expect(isFactual('A contrapartida é isenta para ICT federal e instituição privada sem fins lucrativos.', 'paragraph')).toBe(true);
  });
});

describe('applyGrounding', () => {
  it('resposta toda citada e com valores nos trechos → answered, sem alterações', () => {
    const r = ground(`O prazo de execução é de até 36 meses [${L.prazo}].\n\n- Recurso: 10 dias corridos [${L.recurso}].`);
    expect(r.status).toBe('answered');
    expect(r.report).toMatchObject({ blocks: 2, cited: 2, removed: 0, unsupportedValues: [] });
    expect(r.text).toContain('36 meses');
    expect(r.text).toContain('10 dias corridos');
  });

  it('bloco factual sem citação é omitido em strict e vira partial', () => {
    const r = ground(`O prazo de execução é de até 36 meses [${L.prazo}].\n\nA Finep pode prorrogar por mais 24 meses mediante pedido justificado.`);
    expect(r.status).toBe('partial');
    expect(r.report.removed).toBe(1);
    expect(r.report.issues[0]).toMatchObject({ kind: 'uncited' });
    expect(r.text).toBe(`O prazo de execução é de até 36 meses [${L.prazo}].`);
  });

  it('valor que não consta do trecho citado derruba o bloco', () => {
    const r = ground(`O prazo de execução é de até 48 meses [${L.prazo}].\n\nO recurso tem prazo de 10 dias corridos [${L.recurso}].`);
    expect(r.status).toBe('partial');
    expect(r.report.unsupportedValues).toEqual(['48']);
    expect(r.text).toBe(`O recurso tem prazo de 10 dias corridos [${L.recurso}].`);
  });

  it('valor presente em outro trecho citado da mesma resposta é aceito', () => {
    const r = ground(`O envio vai até 26/06/2026 e o prazo de execução é de 36 meses [${L.cronograma}] [${L.prazo}].`);
    expect(r.status).toBe('answered');
    expect(r.report.unsupportedValues).toEqual([]);
  });

  it('valor que existe no documento mas não no trecho citado é "citação no item errado"; o que não existe em lugar nenhum não', () => {
    const doc = sourceValues('7.1. O valor mínimo é R$ 3.000.000,00. 7.2. Fora disso a proposta é eliminada.');
    const r = ground(`Propostas fora do limite de R$ 3.000.000,00 são eliminadas [${L.prazo}].

O prazo é de 99 meses [${L.prazo}].`, 'warn', doc);
    expect(r.report.unsupportedValues).toEqual(['R$3000000', '99']);
    expect(r.report.misplacedValues).toEqual(['R$3000000']);
    expect(r.report.issues.map((i) => i.misplaced)).toEqual([['R$3000000'], undefined]);
    // sem o contexto inteiro não dá para distinguir: nada é marcado
    expect(ground(`Fora de R$ 3.000.000,00 é eliminada [${L.prazo}].`, 'warn').report.misplacedValues).toEqual([]);
  });

  it('número do item pai ou filho do citado não conta como valor sem respaldo', () => {
    // CHUNK_PRAZO é o item 9.1: "item 9" (pai) e "item 9.1.2" (filho) passam; "item 13.2" (outro) não
    expect(ground(`Conforme o item 9, o prazo é de 36 meses [${L.prazo}].`).report.unsupportedValues).toEqual([]);
    expect(ground(`Conforme o item 9.1.2, o prazo é de 36 meses [${L.prazo}].`).report.unsupportedValues).toEqual([]);
    expect(ground(`Conforme o item 13.2, o prazo é de 36 meses [${L.prazo}].`).report.unsupportedValues).toEqual(['13.2']);
  });

  it('tabela inteira é um bloco: basta uma citação, mas todos os valores precisam constar', () => {
    const ok = ground(`| Fase | Data |\n| --- | --- |\n| Envio da proposta | 26/06/2026 |\n| Resultado preliminar | 20/07/2026 [${L.cronograma}] |`);
    expect(ok.status).toBe('answered');
    const bad = ground(`| Fase | Data |\n| --- | --- |\n| Envio da proposta | 30/06/2026 |\n| Resultado preliminar | 20/07/2026 [${L.cronograma}] |`);
    expect(bad.status).toBe('unsupported');
    expect(bad.text).toBe(UNSUPPORTED_FALLBACK);
  });

  it('nada citável → unsupported com texto padrão (strict) ou texto original (warn)', () => {
    const strict = ground('O prazo de execução é de 36 meses, prorrogável a critério da Finep.');
    expect(strict.status).toBe('unsupported');
    expect(strict.text).toBe(UNSUPPORTED_FALLBACK);
    const warn = ground('O prazo de execução é de 36 meses, prorrogável a critério da Finep.', 'warn');
    expect(warn.status).toBe('unsupported');
    expect(warn.text).toBe('O prazo de execução é de 36 meses, prorrogável a critério da Finep.');
    expect(warn.report.issues).toHaveLength(1);
  });

  it('abstenção e pedido de esclarecimento passam sem citação', () => {
    expect(ground('Não consta nos documentos selecionados. Tente informar o item do edital.').status).toBe('not_found');
    const c = ground('Sua pergunta pode se referir ao prazo de envio da proposta ou ao prazo de execução do projeto. Qual deles você quer?');
    expect(c.status).toBe('clarification');
    expect(c.text).toContain('Qual deles');
  });

  it('política off não altera nada e conta resposta sem citação como answered (closed_book)', () => {
    const r = ground('O prazo é de 48 meses sem citação.', 'off');
    expect(r.text).toBe('O prazo é de 48 meses sem citação.');
    expect(r.report.issues).toEqual([]);
    expect(r.status).toBe('answered');
    expect(ground('Não consta nos documentos selecionados.', 'off').status).toBe('not_found');
    expect(ground('Qual das duas chamadas você quer dizer?', 'off').status).toBe('clarification');
  });

  it('repairInstruction lista afirmações e valores', () => {
    const r = ground(`Prazo de 48 meses [${L.prazo}].\n\nA contrapartida mínima é de 5%.`);
    const text = repairInstruction(r.report, 'chunk');
    expect(text).toContain('Afirmações sem citação');
    expect(text).toContain('contrapartida mínima');
    expect(text).toContain('48 em "Prazo de 48 meses');
  });
});
