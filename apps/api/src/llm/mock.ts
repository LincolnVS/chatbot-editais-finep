/** Modelo simulado (sem rede) — usado enquanto não há chave de API e nos testes. */
import type { LanguageModel } from 'ai';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { splitSentences } from './citations.ts';

const STREAM_CHUNK_CHARS = 20;
const STREAM_DELAY_MS = 5;

export function createMockModel(modelId = 'mock-1'): LanguageModel {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const { text, usage } = respond(options.prompt, modelId);
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      };
    },
    doStream: async (options: LanguageModelV4CallOptions) => {
      const { text, usage } = respond(options.prompt, modelId);
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'mock-text' },
      ];
      for (let i = 0; i < text.length; i += STREAM_CHUNK_CHARS) {
        parts.push({ type: 'text-delta', id: 'mock-text', delta: text.slice(i, i + STREAM_CHUNK_CHARS) });
      }
      parts.push({ type: 'text-end', id: 'mock-text' });
      parts.push({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } });
      return { stream: simulateReadableStream({ chunks: parts, initialDelayInMs: null, chunkDelayInMs: STREAM_DELAY_MS }) };
    },
  });
}

/* ---------- geração determinística ---------- */

function respond(prompt: LanguageModelV4Prompt, modelId: string): { text: string; usage: LanguageModelV4Usage } {
  const promptText = flattenPrompt(prompt);
  const userText = userMessagesText(prompt);
  const question = lastUserQuestion(prompt);
  const isRepair = /Reescreva/i.test(lastUserText(prompt));
  const mustCite = !/no-citation/i.test(modelId) && (!/lazy/i.test(modelId) || isRepair);

  const labels = extractContextLabels(userText);
  const anchors = labels.length === 0 ? extractAnchors(userText) : [];
  const expansion = /^Gere (\d+) variantes[^\n]*\n([\s\S]*)$/.exec(lastUserText(prompt));

  // modelo que usa a busca extra: pede uma busca na primeira vez que ela é oferecida e responde depois dela
  const askedBeforeAbstain = /sem ter pedido busca extra/.test(lastUserText(prompt));
  const abstainsFirst = /abstainer/i.test(modelId) && !/BUSCA EXTRA já realizada/.test(userText) && !askedBeforeAbstain && !isRepair;
  const wantsSearch = (/searcher/i.test(modelId) && !/abstainer/i.test(modelId) && /BUSCA EXTRA: se os trechos/.test(userText) && !/BUSCA EXTRA já realizada/.test(userText)) || askedBeforeAbstain;

  let text: string;
  if (abstainsFirst) {
    text = 'Não consta nos documentos selecionados. Informe o item do edital que trata do assunto.';
  } else if (wantsSearch) {
    text = ['<buscar>prazo de execução da proposta</buscar>', '<buscar>prorrogação do prazo</buscar>'].join(String.fromCharCode(10));
  } else if (expansion) {
    // pedido da expansão de consulta: uma variante por linha, cada uma repetindo a pergunta (mantém a busca dos testes coerente)
    text = Array.from({ length: Number(expansion[1]) }, (_, i) => `Reformulação simulada ${i + 1}: ${expansion[2]!.trim()}`).join('\n');
  } else if (labels.length === 0 && anchors.length === 0) {
    text = `Não há documentos no contexto; esta é uma resposta simulada. Pergunta recebida: "${question}".`;
  } else if (!mustCite) {
    text = `Resposta simulada (modelo mock): o documento trata do assunto perguntado ("${question}"), mas esta resposta não indica os trechos de origem.`;
  } else if (labels.length > 0) {
    const [first, second] = labels;
    const sentence = firstSentenceOfChunk(userText, first as string);
    const opening = sentence
      ? `Resposta simulada (modelo mock): conforme os trechos fornecidos, "${sentence}" [${first}].`
      : `Resposta simulada (modelo mock): conforme os trechos fornecidos, o documento trata do assunto perguntado [${first}].`;
    const support = second
      ? ` Esse ponto também é tratado no item citado [${second}].`
      : ` Esse ponto está descrito no item citado [${first}].`;
    text = `${opening}${support} Verifique o texto original para os detalhes completos.`;
  } else {
    const [first, second] = anchors;
    const support = second ? ` Detalhes adicionais constam em [${second}].` : '';
    text = `Resposta simulada (modelo mock): conforme a seção indicada, o documento trata do assunto perguntado ("${question}") [${first}].${support} Verifique o texto original para os detalhes completos.`;
  }

  const usage: LanguageModelV4Usage = {
    inputTokens: { total: Math.ceil(promptText.length / 4), noCache: Math.ceil(promptText.length / 4), cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: Math.ceil(text.length / 4), text: Math.ceil(text.length / 4), reasoning: 0 },
  };
  return { text, usage };
}

/** Texto de todas as mensagens (sistema, usuário e assistente) concatenado — só para estimar tokens de entrada. */
function flattenPrompt(prompt: LanguageModelV4Prompt): string {
  const pieces: string[] = [];
  for (const message of prompt) {
    if (message.role === 'system') pieces.push(message.content);
    else if (message.role === 'user' || message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'text') pieces.push(part.text);
    }
  }
  return pieces.join('\n');
}

/** Texto só das mensagens do usuário — é onde vive o contexto (chunks rotulados ou documentos com âncoras). */
function userMessagesText(prompt: LanguageModelV4Prompt): string {
  const pieces: string[] = [];
  for (const message of prompt) {
    if (message.role !== 'user') continue;
    for (const part of message.content) if (part.type === 'text') pieces.push(part.text);
  }
  return pieces.join('\n');
}

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message?.role !== 'user') continue;
    return message.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
  }
  return '';
}

/** Pergunta: última linha "PERGUNTA: …" entre as mensagens do usuário (numa rodada de reparo é a da mensagem anterior), ou a última linha. */
function lastUserQuestion(prompt: LanguageModelV4Prompt): string {
  const tagged = userMessagesText(prompt).match(/PERGUNTA:\s*([^\n]+)/g)?.at(-1)?.replace(/^PERGUNTA:\s*/, '');
  const question = (tagged ?? lastUserText(prompt).trim().split('\n').pop() ?? '').trim();
  return question.length > 160 ? `${question.slice(0, 159)}…` : question;
}

/** Rótulos do contexto: atributos `id="c_…"` e menções `[c_…]`, únicos, na ordem. */
function extractContextLabels(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\bid="(c_[0-9a-f]{6})"|\[(c_[0-9a-f]{6})\]/g)) found.add((m[1] ?? m[2]) as string);
  return [...found];
}

/** Âncoras de seção do baseline: `{#sec-… p=N}` no markdown ou `[sec-…]` já citadas. */
function extractAnchors(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{#(sec-[^\s}]+)\s+p=\d+\}|\[(sec-[^\]\s]+)\]/g)) found.add((m[1] ?? m[2]) as string);
  return [...found];
}

/** Primeira sentença literal do chunk `<chunk id="…">…</chunk>` (≤ 200 chars), para exercitar o `quote`. */
function firstSentenceOfChunk(text: string, label: string): string | null {
  const re = new RegExp(`<chunk\\b[^>]*\\bid="${label}"[^>]*>([\\s\\S]*?)</chunk>`);
  const body = text.match(re)?.[1]?.trim();
  if (!body) return null;
  const sentence = splitSentences(body)[0]?.replace(/"/g, "'");
  if (!sentence) return null;
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}
