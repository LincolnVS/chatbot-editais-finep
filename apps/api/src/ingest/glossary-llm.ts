/**
 * Camada do glossário gerada por LLM na ingestão (estratégia B).
 *
 * O modelo recebe SÓ o texto do edital — nunca as perguntas de avaliação — e escreve, para cada termo do documento,
 * como um proponente leigo perguntaria a mesma coisa. É o único jeito de cobrir o lado do vocabulário do usuário:
 * "tempo de constituição" não aparece em edital nenhum, mas é assim que a pessoa pergunta sobre "registro na Junta
 * Comercial". A extração literal (`glossary-extract.ts`) só alcança o lado do documento.
 *
 * Garantias: o termo precisa existir no documento (senão a entrada é descartada), e os sinônimos ficam presos a esse
 * termo. O resultado é gravado junto com o chunk_set, então é auditável e reprocessável.
 */
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { GlossaryEntry } from './glossary-extract.ts';

const MAX_TRECHO = 24000;
const MAX_ENTRADAS = 40;
const MAX_SINONIMOS = 6;

export const GLOSSARY_PROMPT = `Você recebe o texto de um edital de fomento à inovação.

Monte um glossário de busca: para cada termo IMPORTANTE que o edital usa, liste como uma pessoa comum — um empresário
ou pesquisador querendo se candidatar, que não conhece a linguagem do edital — perguntaria sobre esse assunto.

Regras:
- O "termo" deve aparecer literalmente no edital, copiado do texto.
- Os "sinonimos" são as palavras do usuário, NÃO do edital: o jeito coloquial, a paráfrase, o nome popular.
- Priorize termos onde a distância entre a linguagem do edital e a do usuário é grande.
- Ignore termos óbvios cujo nome o usuário já usaria igual.
- No máximo ${MAX_ENTRADAS} entradas, no máximo ${MAX_SINONIMOS} sinônimos cada.

Responda SÓ com JSON, no formato:
[{"termo": "...", "sinonimos": ["...", "..."]}]

Exemplo do tipo de ponte que interessa (de outro domínio, só para ilustrar o formato):
[{"termo": "aporte de recursos próprios pelo beneficiário", "sinonimos": ["quanto eu preciso colocar do meu bolso", "dinheiro que a empresa entra"]}]`;

type Bruto = { termo?: unknown; sinonimos?: unknown };

/** Recorta o JSON da resposta (o modelo às vezes embrulha em cerca de código ou texto). */
function extrairJson(texto: string): Bruto[] {
  const semCerca = texto.replace(/```(?:json)?/gi, '');
  const inicio = semCerca.indexOf('[');
  const fim = semCerca.lastIndexOf(']');
  if (inicio < 0 || fim <= inicio) return [];
  try {
    const dados: unknown = JSON.parse(semCerca.slice(inicio, fim + 1));
    return Array.isArray(dados) ? (dados as Bruto[]) : [];
  } catch {
    return [];
  }
}

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** Só entram entradas cujo termo o edital realmente usa, com sinônimos que o edital NÃO usa. */
export function filtrarAncoradas(brutas: Bruto[], documento: string): GlossaryEntry[] {
  const doc = fold(documento);
  const saida: GlossaryEntry[] = [];
  for (const b of brutas.slice(0, MAX_ENTRADAS)) {
    const termo = typeof b.termo === 'string' ? b.termo.trim() : '';
    if (termo.length < 4 || !doc.includes(fold(termo))) continue;
    const sinonimos = (Array.isArray(b.sinonimos) ? b.sinonimos : [])
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length >= 4 && !doc.includes(fold(s)))
      .slice(0, MAX_SINONIMOS);
    if (sinonimos.length > 0) saida.push({ term: termo, aliases: sinonimos, kind: 'llm', label: null });
  }
  return saida;
}

/** Gera a camada de glossário do documento com o modelo. Falha silenciosa: sem glossário é melhor que ingestão quebrada. */
export async function generateLlmGlossary(model: LanguageModel, documento: string): Promise<GlossaryEntry[]> {
  const { text } = await generateText({
    model,
    system: GLOSSARY_PROMPT,
    prompt: documento.slice(0, MAX_TRECHO),
    abortSignal: AbortSignal.timeout(180_000),
  });
  return filtrarAncoradas(extrairJson(text), documento);
}
