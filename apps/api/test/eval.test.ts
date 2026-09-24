/** Harness de avaliação: leitura do padrão-ouro (CSV), pontuação de casos e agregação por modo. */
import { describe, expect, it } from 'vitest';
import type { AnswerResult, EvalQuestion, StoredChunk } from '@editais/shared';
import { parseCsv, parseQuestions } from '../src/eval/questions.ts';
import { containsValue } from '@editais/shared';
import { coversItem, errorCase, estimateOverhead, itemCovers, scoreCase, summarize, summarizeByWorkspace, type CaseTarget } from '../src/eval/metrics.ts';

const CSV = `id,topic,question,expected_item,expected_values,answerable
q01,valores,"Qual o valor mínimo, por proposta?",8.1,"R$ 2.000.000,00|R$ 5.000.000,00",sim
q02,fora,Qual a taxa de juros?,,,não
q03,prazos,Qual o prazo de execução?,10.1,24,
`;

describe('parseCsv / parseQuestions', () => {
  it('lê campos entre aspas com vírgula e aspas duplas escapadas', () => {
    expect(parseCsv('a,b\n"x, y","diz ""oi"""\n')).toEqual([['a', 'b'], ['x, y', 'diz "oi"']]);
    expect(parseCsv('﻿a\r\nb\r\n')).toEqual([['a'], ['b']]);
  });

  it('monta as perguntas com valores separados por | e answerable sim/não (padrão sim)', () => {
    const qs = parseQuestions(CSV);
    expect(qs).toHaveLength(3);
    expect(qs[0]).toEqual({ id: 'q01', topic: 'valores', question: 'Qual o valor mínimo, por proposta?', expectedItem: '8.1', expectedValues: ['R$ 2.000.000,00', 'R$ 5.000.000,00'], answerable: true });
    expect(qs[1]).toMatchObject({ id: 'q02', answerable: false, expectedValues: [] });
    expect(qs[1]).not.toHaveProperty('expectedItem');
    expect(qs[2]).toMatchObject({ answerable: true, expectedValues: ['24'] });
  });

  it('rejeita CSV sem colunas obrigatórias, ids repetidos e linhas incompletas', () => {
    expect(() => parseQuestions('foo,bar\n1,2\n')).toThrow(/coluna obrigatória "id"/);
    expect(() => parseQuestions('id,question\na,x\na,y\n')).toThrow(/id repetido/);
    expect(() => parseQuestions('id,question\na,\n')).toThrow(/obrigatórios/);
    expect(() => parseQuestions('')).toThrow(/vazio/);
  });
});

describe('containsValue / itemCovers / coversItem', () => {
  it('casa valores pela forma canônica (dinheiro, data, percentual) e texto sem acento', () => {
    expect(containsValue('O mínimo é R$ 2.000.000,00 (dois milhões).', 'R$ 2.000.000,00')).toBe(true);
    expect(containsValue('O mínimo é de 2 milhões de reais.', 'R$ 2.000.000,00')).toBe(true);
    expect(containsValue('Prazo: 9 de abril de 2026.', '09/04/2026')).toBe(true);
    expect(containsValue('Contrapartida de 20,00% sobre o total.', '20%')).toBe(true);
    expect(containsValue('Regiões Nordeste e Norte.', 'nordeste')).toBe(true);
    expect(containsValue('Projetos na região Centro‑Oeste.', 'Centro-Oeste')).toBe(true);
    expect(containsValue('Nada disso.', 'R$ 2.000.000,00')).toBe(false);
  });

  it('número solto só casa como número inteiro', () => {
    expect(containsValue('TRL entre 3 e 9.', '3')).toBe(true);
    expect(containsValue('Até R$ 300.000,00.', '3')).toBe(false);
    expect(containsValue('120 (cento e vinte) dias', '120')).toBe(true);
    expect(containsValue('1.200 dias', '120')).toBe(false);
    expect(containsValue('TRL 3 a 9, conforme o anexo.', '9')).toBe(true);
    expect(containsValue('nota mínima 1,20', '20')).toBe(false);
    // "R$ 5 milhões" e "R$ 5.000.000,00" são o mesmo valor (a alternância do regex casava "mil" antes de "milhões").
    expect(containsValue('o mínimo é de R$ 5 milhões por proposta', 'R$ 5.000.000,00')).toBe(true);
    expect(containsValue('até R$ 1,5 bilhão no total', 'R$ 1.500.000.000,00')).toBe(true);
    expect(containsValue('o teto é R$ 500 mil', 'R$ 500.000,00')).toBe(true);
    expect(containsValue('o teto é R$ 500 mil', 'R$ 5.000.000,00')).toBe(false);
  });

  it('itemCovers aceita igual, subitem e pai', () => {
    expect(itemCovers('8.1', '8.1')).toBe(true);
    expect(itemCovers('8.1.2', '8.1')).toBe(true);
    expect(itemCovers('8', '8.1')).toBe(true);
    expect(itemCovers('8.10', '8.1')).toBe(false);
    expect(itemCovers(undefined, '8.1')).toBe(false);
  });

  it('coversItem usa item, caminho de seção ou cláusula no texto', () => {
    expect(coversItem({ sectionPath: '15. CRONOGRAMA' }, '15')).toBe(true);
    expect(coversItem({ itemNumber: '12.4', sectionPath: '12. SELEÇÃO', text: '12.4. Nota… 12.5. Serão aprovadas…' }, '12.5')).toBe(true);
    expect(coversItem({ itemNumber: '12.4', sectionPath: '12. SELEÇÃO', text: 'ver item 12.5 do edital' }, '12.5')).toBe(false);
    expect(coversItem({ itemNumber: '3.1', sectionPath: '3. RECURSOS' }, '8.1')).toBe(false);
    // Caminho como é gravado de fato, com " › ": pedaço sem número dentro do 7.2.2 cobre o 7.2.2, e não o irmão 7.2.3.
    const orfao = { sectionPath: '7. Avaliação das Propostas › 7.2. Etapa 2: Análise de Mérito › 7.2.2. A análise dos critérios' };
    expect(coversItem(orfao, '7.2.2')).toBe(true);
    expect(coversItem(orfao, '7.2.3')).toBe(false);
  });
});

function chunk(label: string, itemNumber: string, text: string): StoredChunk {
  return { label, itemNumber, text, sectionPath: `${itemNumber.split('.')[0]}. SEÇÃO`, kind: 'item' } as unknown as StoredChunk;
}

function result(partial: Partial<AnswerResult>): AnswerResult {
  return {
    mode: 'rag',
    status: 'answered',
    text: '',
    grounding: { policy: 'strict', blocks: 1, cited: 1, removed: 0, unsupportedValues: [], issues: [] },
    warnings: [],
    citations: [],
    invalidLabels: [],
    repaired: false,
    provider: 'mock/mock-1',
    model: 'mock-1',
    usage: { inputTokens: 100, outputTokens: 20 },
    latencyMs: 50,
    timings: { generationMs: 40, totalMs: 50 },
    configHash: 'h',
    promptVersion: 'qa.v3',
    ...partial,
  };
}

const Q_VALUES: EvalQuestion = { id: 'q1', question: 'Valor?', expectedItem: '8.1', expectedValues: ['R$ 2.000.000,00'], answerable: true };
const Q_NONE: EvalQuestion = { id: 'q2', question: 'Juros?', expectedValues: [], answerable: false };
const W1 = { workspaceId: 'w1', workspaceName: 'Edital 1' };
const RAG: CaseTarget = { arm: 'rag_hybrid', ...W1 };
const FULL: CaseTarget = { arm: 'full_context', ...W1 };
const CLOSED: CaseTarget = { arm: 'closed_book', ...W1 };

describe('scoreCase', () => {
  it('respondível: correta quando respondeu com o valor; recuperação e citação pelo chunk do contexto', () => {
    const ctx = [chunk('c_aaaaaa', '8.1', '8.1. O valor mínimo é R$ 2.000.000,00'), chunk('c_bbbbbb', '3.1', '3.1. Total')];
    const r = result({
      text: 'O mínimo é R$ 2.000.000,00 [c_aaaaaa].',
      citations: [{ label: 'c_aaaaaa', itemNumber: '8.1', sectionPath: '8. VALORES' } as never],
      retrieval: { query: 'Valor?', configHash: 'h', candidates: [], context: ctx, contextChars: 10, latencyMs: 1 },
    });
    const c = scoreCase(Q_VALUES, RAG, r);
    expect(c).toMatchObject({ arm: 'rag_hybrid', mode: 'rag', workspaceId: 'w1', workspaceName: 'Edital 1', correct: true, valuesFound: 1, valuesExpected: 1, retrievalHit: true, citedExpected: true, grounded: true, abstained: false, citations: 1 });
  });

  it('respondível: incorreta quando se absteve, quando faltou valor ou quando o gate removeu o valor', () => {
    const abstained = scoreCase(Q_VALUES, RAG, result({ status: 'not_found', text: 'Não consta nos documentos selecionados.' }));
    expect(abstained).toMatchObject({ correct: false, abstained: true });
    const wrong = scoreCase(Q_VALUES, RAG, result({ text: 'O mínimo é R$ 1.000.000,00 [c_aaaaaa].' }));
    expect(wrong).toMatchObject({ correct: false, valuesFound: 0 });
    const gated = scoreCase(Q_VALUES, RAG, result({ status: 'partial', text: 'Ver edital.', rawText: 'O mínimo é R$ 2.000.000,00.', grounding: { policy: 'strict', blocks: 1, cited: 0, removed: 1, unsupportedValues: [], issues: [{ kind: 'uncited', text: 'x' }] } }));
    expect(gated).toMatchObject({ correct: false, valuesFound: 0, valuesFoundRaw: 1, grounded: false, removed: 1 });
  });

  it('sem resposta no corpus: correta só com abstenção; pedido de esclarecimento não conta como resposta', () => {
    expect(scoreCase(Q_NONE, RAG, result({ status: 'not_found', text: 'Não consta nos documentos selecionados.' })).correct).toBe(true);
    expect(scoreCase(Q_NONE, RAG, result({ text: 'A taxa é 5% [c_aaaaaa].' })).correct).toBe(false);
    const clarification = scoreCase({ ...Q_VALUES, expectedValues: [] }, RAG, result({ status: 'clarification', text: 'Qual região?' }));
    expect(clarification).toMatchObject({ correct: false, abstained: false });
  });

  it('full_context conta recuperação como 1; closed_book não tem recuperação, citação nem gate', () => {
    const full = scoreCase(Q_VALUES, FULL, result({ mode: 'full_context', text: 'R$ 2.000.000,00 [sec-d1-valores]', citations: [{ label: 'sec-d1-valores', itemNumber: '8', sectionPath: '8. VALORES' } as never] }));
    expect(full).toMatchObject({ retrievalHit: true, citedExpected: true });
    const closed = scoreCase(Q_VALUES, CLOSED, result({ mode: 'closed_book', text: 'R$ 2.000.000,00', grounding: { policy: 'off', blocks: 0, cited: 0, removed: 0, unsupportedValues: [], issues: [] } }));
    expect(closed).toMatchObject({ retrievalHit: null, citedExpected: null, grounded: null, correct: true });
  });
});

describe('containsValue: fronteira à esquerda', () => {
  it('valor menor não casa dentro de um maior', () => {
    expect(containsValue('A contrapartida é de 15,0% no arranjo em rede', '5,0%')).toBe(false);
    expect(containsValue('Os percentuais são 5,0% e 15,0%', '5,0%')).toBe(true);
    expect(containsValue('O teto é R$ 15 milhões', 'R$ 5 milhões')).toBe(false);
    expect(containsValue('média ponderada inferior a 3,5', '3,5')).toBe(true);
    expect(containsValue('nota 13,5 no critério', '3,5')).toBe(false);
  });

  it('número por extenso entre parênteses não conta: "12 (doze) meses" e "12 meses" são a mesma coisa', () => {
    expect(containsValue('atividade nos 12 meses anteriores', '12 (doze) meses')).toBe(true);
    expect(containsValue('atividade nos 12 (doze) meses anteriores', '12 meses')).toBe(true);
    expect(containsValue('prazo de 10 (dez) dias corridos', '10 (dez) dias')).toBe(true);
    expect(containsValue('atividade nos 24 meses anteriores', '12 (doze) meses')).toBe(false);
  });

  it('valor textual não distingue singular de plural', () => {
    expect(containsValue('A proponente deve ser uma empresa brasileira', 'empresas brasileiras')).toBe(true);
    expect(containsValue('Podem participar empresas brasileiras', 'empresa brasileira')).toBe(true);
    expect(containsValue('proposta inabilitada', 'inabilitada')).toBe(true);
    expect(containsValue('em recuperação judicial', 'recuperações judiciais')).toBe(true);
    expect(containsValue('recuperações judiciais em curso', 'recuperação judicial')).toBe(true);
    expect(containsValue('responsabilidade civil', 'responsabilidades civis')).toBe(true);
    expect(containsValue('papéis de trabalho', 'papel de trabalho')).toBe(true);
    expect(containsValue('lista de exclusão', 'lista de inclusão')).toBe(false);
    expect(containsValue('ICTs públicas', 'ICT')).toBe(true);
  });
});

describe('isAbstention', () => {
  it('ressalva no fim de uma resposta completa não é abstenção (regra 5/7 do prompt v3)', () => {
    const parcial = result({
      text: 'No arranjo simples o teto é R$ 2.000.000,00 [c_aaaaaa]. O teto do arranjo em rede não consta nos documentos selecionados.',
      citations: [{ label: 'c_aaaaaa', itemNumber: '8.1', sectionPath: '8. VALORES' } as never],
    });
    expect(scoreCase(Q_VALUES, RAG, parcial)).toMatchObject({ abstained: false, correct: true, valuesFound: 1 });
  });

  it('abre com a frase de abstenção: conta como abstenção mesmo com citação depois', () => {
    const abre = result({
      text: 'Não consta nos documentos selecionados. Informe o item do edital [c_aaaaaa].',
      citations: [{ label: 'c_aaaaaa', itemNumber: '8.1', sectionPath: '8. VALORES' } as never],
    });
    expect(scoreCase(Q_VALUES, RAG, abre)).toMatchObject({ abstained: true, correct: false });
    expect(scoreCase(Q_NONE, RAG, abre)).toMatchObject({ abstained: true, correct: true });
  });

  it('ressalva de terminologia: abre com "não consta" mas traz todos os valores esperados com citação → correta', () => {
    const ressalva = result({
      text: 'Não consta nos documentos selecionados um "piso" com esse nome. O que os trechos mostram é o valor mínimo de R$ 2.000.000,00 por proposta [c_aaaaaa].',
      citations: [{ label: 'c_aaaaaa', itemNumber: '8.1', sectionPath: '8. VALORES' } as never],
    });
    expect(scoreCase(Q_VALUES, RAG, ressalva)).toMatchObject({ abstained: true, correct: true, valuesFound: 1 });
    // sem citação nenhuma (status unsupported) continua errada
    expect(scoreCase(Q_VALUES, RAG, result({ status: 'unsupported', text: ressalva.text, citations: [] }))).toMatchObject({ abstained: true, correct: false });
  });

  it('sem nenhuma citação válida (status unsupported) conta como abstenção', () => {
    const semRotulo = scoreCase(Q_VALUES, RAG, result({ status: 'unsupported', text: 'O mínimo é R$ 2.000.000,00.' }));
    expect(semRotulo).toMatchObject({ abstained: true, correct: false });
  });
});

describe('summarize', () => {
  it('agrega taxas por braço: erro conta como falha na acurácia, sai das médias de custo', () => {
    const ok = scoreCase(Q_VALUES, RAG, result({ text: 'R$ 2.000.000,00 [c_aaaaaa]', citations: [{ label: 'c_aaaaaa', itemNumber: '8.1', sectionPath: '8.' } as never], retrieval: { query: '', configHash: 'h', candidates: [], context: [chunk('c_aaaaaa', '8.1', 'x')], contextChars: 1, latencyMs: 1 } }));
    const bad = scoreCase(Q_NONE, RAG, result({ text: 'Inventei 5% [c_zzzzzz]', invalidLabels: ['c_zzzzzz'], grounding: { policy: 'strict', blocks: 1, cited: 0, removed: 0, unsupportedValues: ['5%'], issues: [{ kind: 'unsupported_value', text: 'x' }] }, repaired: true }));
    const err = errorCase(Q_VALUES, CLOSED, 'boom', 5);
    const [rag, closed] = summarize(['rag_hybrid', 'closed_book'], [ok, bad, err]);
    expect(rag).toMatchObject({ arm: 'rag_hybrid', mode: 'rag', n: 2, errors: 0, answerable: 1, unanswerable: 1, accuracy: 0.5, answerAccuracy: 1, abstentionAccuracy: 0, falseAbstention: 0, retrievalHitRate: 1, citedExpectedRate: 1, groundedRate: 0.5, unreferencedRate: 0.5, gateInterventionRate: 0.5, repairedRate: 0.5, meanLatencyMs: 50, meanTokens: 120, totalTokens: 240 });
    expect(bad).toMatchObject({ gate: 'strict', issues: [{ kind: 'unsupported_value', text: 'x' }] });
    expect(ok.issues).toBeUndefined();
    // a conta é a mesma em warn (o que muda é só a leitura: entregue assim vs ajustado pelo gate)
    const warn = summarize(['rag_hybrid'], [{ ...ok, gate: 'warn' }, { ...bad, gate: 'warn' }])[0]!;
    expect(warn).toMatchObject({ unreferencedRate: 0.5 });
    // citação inventada sozinha (texto fundamentado) também conta
    const invented = summarize(['rag_hybrid'], [{ ...ok, invalidLabels: 1 }])[0]!;
    expect(invented).toMatchObject({ groundedRate: 1, unreferencedRate: 1 });
    // O único caso do braço é erro: acurácia 0 (o caso conta como falha), mas latência e tokens ficam null/0 — o custo só considera casos sem erro.
    expect(closed).toMatchObject({ arm: 'closed_book', mode: 'closed_book', n: 1, errors: 1, accuracy: 0, retrievalHitRate: null, meanLatencyMs: null, totalTokens: 0 });

    // por documento: cada workspace só vê os próprios casos
    const other = scoreCase(Q_VALUES, { arm: 'rag_hybrid', workspaceId: 'w2', workspaceName: 'Edital 2' }, result({ status: 'not_found', text: 'Não consta nos documentos selecionados.' }));
    const byWs = summarizeByWorkspace(['rag_hybrid'], [{ id: 'w1', name: 'Edital 1' }, { id: 'w2', name: 'Edital 2' }], [ok, bad, other], new Map([['w1', 2], ['w2', 1]]));
    expect(byWs.map((w) => [w.workspaceName, w.questions, w.summary[0]!.n, w.summary[0]!.accuracy])).toEqual([['Edital 1', 2, 2, 0.5], ['Edital 2', 1, 1, 0]]);
  });
});

describe('estimateOverhead', () => {
  it('execução antiga pelo CLI: 1,6 s por chamada (geração, reparo, rodadas de busca extra), limitado à latência; outros provedores nada', () => {
    const base = scoreCase(Q_VALUES, RAG, result({ latencyMs: 10_000 }));
    expect(estimateOverhead(base, 'claude-code/sonnet')).toEqual({ overheadMs: 1600, overheadEstimated: true });
    expect(estimateOverhead({ ...base, repaired: true, searches: ['a', 'b', 'c', 'd'] }, 'claude-code/sonnet')).toEqual({ overheadMs: 6400, overheadEstimated: true });
    expect(estimateOverhead({ ...base, latencyMs: 1000 }, 'claude-code/sonnet')).toEqual({ overheadMs: 1000, overheadEstimated: true });
    expect(estimateOverhead(base, 'groq/x')).toEqual({});
    // medido de verdade: não mexe
    expect(estimateOverhead({ ...base, overheadMs: 1500 }, 'claude-code/sonnet')).toEqual({});
    // latência média desconta a subida
    const [s] = summarize(['rag_hybrid'], [{ ...base, overheadMs: 4000 }]);
    expect(s).toMatchObject({ meanLatencyMs: 6000, meanOverheadMs: 4000 });
  });
});

describe('rescoreCase', () => {
  it('repontua o caso gravado com o pontuador atual (valor em milhões passa a contar)', async () => {
    const { rescoreCase } = await import('../src/eval/metrics.ts');
    const q = { id: 't01', question: 'Valor mínimo?', expectedItem: '5', expectedValues: ['R$ 5.000.000,00'], answerable: true };
    const antes = {
      questionId: 't01', arm: 'rag_hybrid', mode: 'rag', workspaceId: 'w1', workspaceName: 'W1', question: q.question, expectedItem: '5',
      expectedValues: q.expectedValues, answerable: true, status: 'answered', text: 'O mínimo é de R$ 5 milhões [c_1].', citations: 1, invalidLabels: 0,
      retrievalHit: true, citedExpected: true, valuesFound: 0, valuesFoundRaw: 0, valuesExpected: 1, abstained: false, correct: false,
      blocks: 1, cited: 1, removed: 0, unsupportedValues: 0, grounded: true, repaired: false, latencyMs: 1000, inputTokens: 10, outputTokens: 5,
    } as const;
    const depois = rescoreCase(q, { ...antes });
    expect(depois).toMatchObject({ valuesFound: 1, correct: true, retrievalHit: true, latencyMs: 1000 });
    // Casos com erro de chamada continuam intocados.
    expect(rescoreCase(q, { ...antes, status: 'error', text: '', correct: false })).toMatchObject({ status: 'error', correct: false, valuesFound: 0 });
  });
});

describe('retryAfterMs', () => {
  it('lê o tempo pedido pelo provedor (s ou ms) com folga; sem indicação usa o padrão', async () => {
    const { retryAfterMs } = await import('../src/eval/runner.ts');
    expect(retryAfterMs('Rate limit reached. Please try again in 12.5s. Need more?')).toBe(14_000);
    expect(retryAfterMs('Please try again in 255ms.')).toBe(1755);
    expect(retryAfterMs('Quota exceeded.')).toBe(20_000);
    expect(retryAfterMs('try again in 900s')).toBe(120_000);
    expect(retryAfterMs('Please try again in 1m2.5s.')).toBe(64_000);
    expect(retryAfterMs('Please try again in 3m10.512s.')).toBe(120_000);
  });

  it('reconhece cota diária esgotada (Groq TPD, Gemini free tier)', async () => {
    const { isDailyQuota } = await import('../src/eval/runner.ts');
    expect(isDailyQuota('Rate limit reached for model x on tokens per day (TPD): Limit 200000, Used 196640')).toBe(true);
    expect(isDailyQuota('You exceeded your current quota, please check your plan and billing details.')).toBe(true);
    expect(isDailyQuota("CLI do Claude Code: You've hit your session limit · resets 2:10pm (America/Sao_Paulo)")).toBe(true);
    expect(isDailyQuota('Rate limit reached on tokens per minute (TPM): Limit 8000. Please try again in 5s')).toBe(false);
  });
});
