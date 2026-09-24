import { describe, expect, it } from 'vitest';
import { generateText, streamText } from 'ai';
import { createMockModel } from '../src/llm/mock.ts';
import { extractLabels, extractSectionAnchors } from '../src/llm/citations.ts';
import { ragUserMessage, loadPrompt } from '../src/llm/answer.ts';
import { CHUNK_PRAZO, CHUNK_RECURSO, CONTEXT } from './helpers/llm-fixtures.ts';

const instructions = loadPrompt('qa.v1');
const ragPrompt = ragUserMessage(CONTEXT, 'Qual é o prazo de execução da proposta?');

describe('createMockModel', () => {
  it('generateText: cita os 2 primeiros rótulos do contexto e a primeira sentença literal do chunk', async () => {
    const result = await generateText({ model: createMockModel(), instructions, messages: [{ role: 'user', content: ragPrompt }] });
    expect(result.text.startsWith('Resposta simulada (modelo mock):')).toBe(true);
    expect(extractLabels(result.text)).toEqual([CHUNK_PRAZO.label, CHUNK_RECURSO.label]);
    expect(result.text).toContain(`"${CHUNK_PRAZO.text}"`);
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBe(Math.ceil(result.text.length / 4));
  });

  it('é determinístico para o mesmo prompt', async () => {
    const a = await generateText({ model: createMockModel(), prompt: ragPrompt });
    const b = await generateText({ model: createMockModel(), prompt: ragPrompt });
    expect(a.text).toBe(b.text);
  });

  it('streamText: emite deltas de ~20 chars e o texto final coincide com o generateText', async () => {
    const generated = await generateText({ model: createMockModel(), instructions, messages: [{ role: 'user', content: ragPrompt }] });
    const streamed = streamText({ model: createMockModel(), instructions, messages: [{ role: 'user', content: ragPrompt }] });
    const deltas: string[] = [];
    for await (const delta of streamed.textStream) deltas.push(delta);
    expect(deltas.length).toBeGreaterThan(3);
    expect(Math.max(...deltas.map((d) => d.length))).toBeLessThanOrEqual(20);
    expect(deltas.join('')).toBe(generated.text);
    expect(await streamed.finishReason).toBe('stop');
    expect((await streamed.usage).outputTokens).toBe(Math.ceil(generated.text.length / 4));
  });

  it('sem rótulos no prompt (closed_book) → resposta simulada sem citações, com a pergunta', async () => {
    const result = await generateText({ model: createMockModel(), instructions: loadPrompt('closed_book.v1'), prompt: 'Qual é o prazo de execução?' });
    expect(result.text).toContain('Não há documentos no contexto; esta é uma resposta simulada.');
    expect(result.text).toContain('Qual é o prazo de execução?');
    expect(extractLabels(result.text)).toEqual([]);
  });

  it('full_context: cita âncoras [sec-…] presentes no markdown', async () => {
    const md = '## 9. PRAZO DE EXECUÇÃO {#sec-9 p=14}\n\n9.1. O prazo é de 36 meses.\n\n## 13. RECURSOS {#sec-13 p=20}\n\n13.2. Recurso em 10 dias.';
    const result = await generateText({ model: createMockModel(), instructions: loadPrompt('baseline.v1'), prompt: `=== DOCUMENTO: Edital (tipo: edital) ===\n${md}\n\nPERGUNTA: Qual é o prazo?` });
    expect(extractSectionAnchors(result.text)).toEqual(['sec-9', 'sec-13']);
    expect(extractLabels(result.text)).toEqual([]);
  });

  it('variantes: "no-citation" nunca cita; "lazy" só cita no pedido de reparo', async () => {
    const none = await generateText({ model: createMockModel('mock-no-citation'), prompt: ragPrompt });
    expect(extractLabels(none.text)).toEqual([]);

    const lazyFirst = await generateText({ model: createMockModel('mock-lazy'), prompt: ragPrompt });
    expect(extractLabels(lazyFirst.text)).toEqual([]);

    const lazyRepair = await generateText({
      model: createMockModel('mock-lazy'),
      messages: [
        { role: 'user', content: ragPrompt },
        { role: 'assistant', content: lazyFirst.text },
        { role: 'user', content: 'Reescreva a resposta citando [c_ID] após cada afirmação.' },
      ],
    });
    expect(extractLabels(lazyRepair.text)).toEqual([CHUNK_PRAZO.label, CHUNK_RECURSO.label]);
  });
});
