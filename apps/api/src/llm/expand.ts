/**
 * Expansão de consulta: o modelo reescreve a pergunta no vocabulário de edital antes da busca.
 * Fecha a lacuna entre como o usuário pergunta ("quem pode propor?") e como o edital escreve ("são elegíveis…").
 */
import { generateText, type LanguageModelUsage, type ProviderMetadata } from 'ai';

/** Tempo de subida do CLI do Claude Code numa chamada (relógio − tempo do turno no CLI), 0 nos outros provedores. */
export function cliOverheadMs(meta: ProviderMetadata | undefined): number {
  const t = meta?.['claude-code'];
  const wall = typeof t?.wallMs === 'number' ? t.wallMs : undefined;
  const cli = typeof t?.cliMs === 'number' ? t.cliMs : undefined;
  return wall !== undefined && cli !== undefined ? Math.max(0, wall - cli) : 0;
}
import type { LlmConfig } from '@editais/shared';
import { makeModel } from './providers.ts';

const EXPANSION_TIMEOUT_MS = 60_000;

export const EXPANSION_INSTRUCTIONS = [
  'Você ajuda um sistema de busca em editais e chamadas públicas de fomento à inovação (FINEP e similares).',
  'Receberá uma pergunta de usuário. Reescreva-a em variantes curtas que usem o VOCABULÁRIO QUE UM EDITAL USARIA para tratar do mesmo assunto:',
  'termos de seção (elegibilidade, contrapartida, cronograma, habilitação, análise de mérito, recurso administrativo, documentação, vedações, prazo de execução),',
  'sinônimos formais (proponente/convenente/executora; empresa/pessoa jurídica/instituição; teto/valor máximo/limite; data limite/prazo de submissão)',
  'e a forma como o edital afirma a regra (ex.: "são elegíveis", "não são elegíveis", "é vedado", "será eliminada", "deverá apresentar").',
  'Cada variante trata EXATAMENTE do assunto da pergunta, na mesma etapa do processo — quem pode propor não vira o que se exige na contratação; documentos da proposta não viram documentos da prestação de contas.',
  'Regras: uma variante por linha, sem numeração, sem aspas, sem explicações; cada variante com 6 a 20 palavras; não repita a pergunta original; não invente valores, datas ou números de item.',
].join(' ');

/** Linhas do modelo → variantes limpas (sem numeração/marcadores, sem repetir a pergunta, sem duplicatas). */
export function parseVariants(text: string, question: string, max: number): string[] {
  const seen = new Set<string>([normalize(question)]);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["“”']+|["“”']+$/g, '').trim();
    if (line.length < 8 || line.length > 200) continue;
    const key = normalize(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export type Expansion = { variants: string[]; usage?: LanguageModelUsage; error?: string; overheadMs?: number };

/** Pede `count` variantes ao modelo. Em falha do provedor devolve lista vazia e o erro: a busca segue só com a pergunta original, avisando. */
export async function expandQuery(llm: LlmConfig, question: string, count: number): Promise<Expansion> {
  if (count <= 0) return { variants: [] };
  try {
    const r = await generateText({
      model: makeModel(llm),
      instructions: EXPANSION_INSTRUCTIONS,
      messages: [{ role: 'user', content: `Gere ${count} variantes para a pergunta:\n${question}` }],
      ...(llm.kind === 'anthropic' || llm.kind === 'claude-code' ? {} : { temperature: 0 }),
      abortSignal: AbortSignal.timeout(EXPANSION_TIMEOUT_MS),
    });
    return { variants: parseVariants(r.text, question, count), usage: r.usage, overheadMs: cliOverheadMs(r.finalStep.providerMetadata) };
  } catch (err) {
    return { variants: [], error: err instanceof Error ? err.message : String(err) };
  }
}
