/**
 * Uso do glossário derivado do documento na consulta (ver `ingest/glossary-extract.ts`).
 * Se a pergunta toca o termo, a variante leva as formas irmãs; se toca uma forma irmã (a sigla, uma palavra da
 * definição), a variante leva o termo. Nada aqui depende das perguntas de avaliação.
 */
import type { GlossaryEntry } from '../ingest/glossary-extract.ts';

const MAX_GRUPOS = 3;
/** Quantos grupos passam pela atestação antes de desistir: limita o custo da checagem no índice léxico. */
const MAX_CHECAGENS = 12;

/** Dos termos oferecidos, quais existem nos documentos que estão sendo buscados. */
export type Atestado = (termos: string[]) => Set<string>;
/** Alias curto demais vira gatilho de qualquer coisa; sigla de 2 letras já é ambígua no meio do texto. */
const MIN_ALIAS = 3;

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Palavra ou expressão inteira, sem acento e sem caixa. */
function casa(texto: string, termo: string): boolean {
  if (termo.length < MIN_ALIAS) return false;
  return new RegExp(String.raw`(?<!\p{L})${escapeRe(fold(termo))}(?:e?s)?(?!\p{L})`, 'u').test(texto);
}

/** Palavras estruturais de título de edital: sozinhas não identificam nada. */
const GENERICAS = new Set(
  `instituicao instituicoes entidade entidades pessoa pessoas publica publicas privada privadas nacional nacionais
   projeto projetos proposta propostas edital chamada publico publicos sistema sistemas geral gerais outros outras
   tipo tipos forma formas parte partes item itens area areas dados servico servicos produto produtos`.split(/\s+/).filter(Boolean),
);

/** Palavras do termo que servem de gatilho sozinhas: longas, não genéricas e não repetidas em muitas entradas. */
function gatilhosDoTermo(termo: string, frequencia: Map<string, number>): string[] {
  return termo
    .split(/[^\p{L}\p{N}]+/u)
    .filter((p) => p.length >= 5 && !GENERICAS.has(fold(p)) && (frequencia.get(fold(p)) ?? 0) <= 3);
}

function frequenciaDePalavras(entries: GlossaryEntry[]): Map<string, number> {
  const f = new Map<string, number>();
  for (const e of entries) {
    for (const p of new Set(e.term.split(/[^\p{L}\p{N}]+/u).map(fold))) f.set(p, (f.get(p) ?? 0) + 1);
  }
  return f;
}

/**
 * Entradas que a consulta toca, mais específicas primeiro, sem repetir o que a consulta já diz. Aciona pelo termo
 * inteiro, pela sigla, ou por uma palavra distintiva do termo ("proponente" aciona "Instituição Proponente").
 */
export function docGlossaryTerms(query: string, entries: GlossaryEntry[], maxGrupos = MAX_GRUPOS, atestado?: Atestado): string[][] {
  const q = fold(query);
  const frequencia = frequenciaDePalavras(entries);
  const achados: Array<{ peso: number; termos: string[] }> = [];
  for (const e of entries) {
    // A camada de LLM só existe para atravessar a ponte palavra do usuário → palavra do edital: dispara pelos sinônimos
    // e leva o termo. Pelo lado do edital ela não tem serviço — quem cobre isso é o glossário estrutural — e os
    // sinônimos coloquiais, por construção, não estão no texto: no BM25 não casam nada e no vetor puxam para fora do registro.
    const daLlm = e.kind === 'llm';
    const peloTermo = !daLlm && casa(q, e.term);
    const gatilhos = daLlm ? e.aliases : [...(e.kind === 'sigla' ? e.aliases : []), ...gatilhosDoTermo(e.term, frequencia)];
    const casado = peloTermo ? e.term : gatilhos.find((g) => casa(q, g));
    if (!casado) continue;
    const termos = (daLlm ? [e.term] : [e.term, ...e.aliases]).filter((t) => !casa(q, t));
    if (termos.length === 0) continue;
    achados.push({ peso: peloTermo ? e.term.length + 100 : casado.length, termos });
  }
  return escolher(achados.toSorted((a, b) => b.peso - a.peso), maxGrupos, atestado);
}

/**
 * Pega os grupos mais específicos que sobrevivem à atestação, na ordem do peso. Sem `atestado` (glossário só dos
 * documentos em escopo) a checagem é dispensável: o termo saiu daquele texto.
 */
function escolher(achados: Array<{ termos: string[] }>, maxGrupos: number, atestado?: Atestado): string[][] {
  if (!atestado) return achados.slice(0, maxGrupos).map((h) => h.termos);
  const candidatos = achados.slice(0, MAX_CHECAGENS);
  const presentes = atestado([...new Set(candidatos.flatMap((h) => h.termos))]);
  const out: string[][] = [];
  for (const h of candidatos) {
    const termos = h.termos.filter((t) => presentes.has(t));
    if (termos.length > 0) out.push(termos);
    if (out.length === maxGrupos) break;
  }
  return out;
}

/** Uma variante por entrada tocada: a consulta mais as formas irmãs. */
export function docGlossaryVariants(query: string, entries: GlossaryEntry[], maxGrupos = MAX_GRUPOS, atestado?: Atestado): string[] {
  return docGlossaryTerms(query, entries, maxGrupos, atestado).map((termos) => `${query} ${termos.join(' ')}`);
}
