/**
 * Glossário derivado do próprio documento, montado na ingestão. Substitui a lista escrita à mão: nada aqui depende das
 * perguntas de avaliação, só do texto do edital.
 *
 * Três padrões, todos frequentes em edital da Finep:
 *  1. item de definição numerado — "2.1.4 Instituição Executora Principal: ICT responsável pela execução …"
 *  2. sigla apresentada entre parênteses — "Instituições Científicas, Tecnológicas e de Inovação (ICTs)"
 *  3. definição embutida no texto — "entende-se por risco tecnológico a possibilidade de insucesso …"
 *
 * Cada entrada guarda o termo e as formas irmãs (`aliases`): a sigla, o nome por extenso ou os termos de conteúdo da
 * definição. Na consulta, tocar qualquer uma das formas traz as outras.
 */

export type GlossaryKind = 'definicao' | 'sigla' | 'expressao' | 'llm';

export type GlossaryEntry = {
  /** Forma canônica: o termo definido ou o nome por extenso da sigla. */
  term: string;
  /** Outras formas que valem como expansão: a sigla, o nome por extenso, os termos irmãos do mesmo bloco de definições. */
  aliases: string[];
  kind: GlossaryKind;
  /** Item ou seção de onde saiu, para auditoria na tela. */
  label: string | null;
};

const STOPWORDS = new Set(
  `a o as os um uma uns umas de da do das dos e ou que para por com sem sob sobre entre no na nos nas ao aos à às
   se ser será serão seja sejam este esta estes estas esse essa isso aquele aquela seu sua seus suas pelo pela pelos pelas
   quando onde como qual quais cujo cuja mais menos muito pouco todo toda todos todas outro outra outros outras
   fins âmbito termos disposto observado conforme presente respectivo respectiva demais deste desta desse dessa`
    .split(/\s+/).filter(Boolean),
);

const MAX_ALIASES = 6;
const MIN_TERM = 4;
const MAX_TERM = 80;

function limpo(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/^[\s"'“”\-–—]+|[\s"'“”\-–—.;,:]+$/g, '').trim();
}

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** Termo plausível: tem tamanho de expressão, começa por letra e não é frase inteira. */
function termoValido(t: string): boolean {
  if (t.length < MIN_TERM || t.length > MAX_TERM) return false;
  if (!/^\p{Lu}|^\p{Ll}/u.test(t)) return false;
  const palavras = t.split(/\s+/);
  return palavras.length <= 10 && !/[.;]/.test(t);
}

/** Palavras de conteúdo da definição, na ordem, sem repetir o próprio termo. */
function termosDaDefinicao(definicao: string, termo: string): string[] {
  const doTermo = new Set(fold(termo).split(/\W+/).filter(Boolean));
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const p of definicao.split(/[^\p{L}\p{N}]+/u)) {
    const f = fold(p);
    if (f.length < 4 || STOPWORDS.has(f) || doTermo.has(f) || vistos.has(f)) continue;
    vistos.add(f);
    saida.push(p);
    if (saida.length >= MAX_ALIASES) break;
  }
  return saida;
}

/**
 * 1. Itens numerados com "Termo: definição". Os termos definidos no mesmo bloco (mesmo prefixo de numeração) são irmãos
 * na taxonomia do próprio edital — nomear um traz os outros, que é o que fecha a lacuna de vocabulário.
 */
function definicoesNumeradas(texto: string): GlossaryEntry[] {
  const achados: Array<{ termo: string; label: string; bloco: string }> = [];
  const partes = texto.split(/(?=(?:^|\s)\d+(?:\.\d+){1,3}\s+\p{Lu})/u);
  for (const parte of partes) {
    const m = /^\s*(\d+(?:\.\d+){1,3})\s+([^:\n]{3,90}?):\s+(.{20,800})/su.exec(parte);
    if (!m) continue;
    const termo = limpo(m[2]!);
    if (!termoValido(termo)) continue;
    achados.push({ termo, label: m[1]!, bloco: m[1]!.split('.').slice(0, 2).join('.') });
  }
  return achados.map((a) => ({
    term: a.termo,
    aliases: achados.filter((o) => o.bloco === a.bloco && o.termo !== a.termo).map((o) => o.termo).slice(0, MAX_ALIASES),
    kind: 'definicao' as const,
    label: a.label,
  }));
}

/**
 * Nome por extenso da sigla, no espírito do Schwartz–Hearst: a janela mais curta que começa numa palavra com a inicial
 * da sigla e contém as demais iniciais em ordem. Evita cortar no meio ("Tecnológicas e de Inovação" para ICT).
 */
function nomeDaSigla(bruto: string, sigla: string): string | null {
  const palavras = limpo(bruto).split(/\s+/);
  const letras = fold(sigla).split('');
  for (let inicio = 0; inicio < palavras.length; inicio++) {
    if (fold(palavras[inicio]!)[0] !== letras[0]) continue;
    let letra = 1;
    for (let i = inicio + 1; i < palavras.length && letra < letras.length; i++) {
      if (fold(palavras[i]!)[0] === letras[letra]) letra++;
    }
    if (letra === letras.length) return palavras.slice(inicio).join(' ');
  }
  return null;
}

/** 2. Siglas apresentadas entre parênteses. */
function siglas(texto: string): GlossaryEntry[] {
  const saida: GlossaryEntry[] = [];
  const re = /(\p{Lu}\p{L}+(?:[\s,]+(?:de |da |do |dos |das |e |em )?\p{L}+){1,8})\s*\((\p{Lu}{2,8})s?\)/gu;
  for (const m of texto.matchAll(re)) {
    const sigla = m[2]!;
    const nome = nomeDaSigla(m[1]!, sigla);
    if (!nome || !termoValido(nome) || fold(nome).startsWith(fold(sigla))) continue;
    saida.push({ term: nome, aliases: [sigla, sigla + 's'], kind: 'sigla', label: null });
  }
  return saida;
}

/** Determinantes que abrem a definição: "entende-se por risco tecnológico **a** possibilidade …". */
const ABRE_DEFINICAO = new Set(['a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'aquele', 'aquela', 'todo', 'toda', 'como']);

/** Corta o termo onde a definição começa e tira preposição solta no fim. */
function cortaTermo(bruto: string): string {
  const palavras = limpo(bruto).split(/\s+/);
  const corte = palavras.findIndex((p, i) => i > 0 && ABRE_DEFINICAO.has(fold(p)));
  const termo = (corte > 0 ? palavras.slice(0, corte) : palavras).slice(0, 5);
  while (termo.length > 1 && STOPWORDS.has(fold(termo.at(-1)!))) termo.pop();
  return termo.join(' ');
}

/** 3. "entende-se por X …" / "considera-se X …". */
function expressoes(texto: string): GlossaryEntry[] {
  const saida: GlossaryEntry[] = [];
  const re = /(?:[Ee]ntende-se por|[Cc]onsidera-se)\s+(\p{L}[^,.;:\n]{3,60})[,\s]+(.{20,400}?)[.;]/gu;
  for (const m of texto.matchAll(re)) {
    const termo = cortaTermo(m[1]!);
    if (!termoValido(termo)) continue;
    saida.push({ term: termo, aliases: termosDaDefinicao(limpo(m[1]! + ' ' + m[2]!), termo), kind: 'expressao', label: null });
  }
  return saida;
}

/** Junta as entradas iguais (mesmo termo sem acento/caixa) somando as formas irmãs. Usado também para unir acervos. */
export function mergeGlossary(entradas: GlossaryEntry[]): GlossaryEntry[] {
  const porTermo = new Map<string, GlossaryEntry>();
  for (const e of entradas) {
    const chave = fold(e.term);
    const atual = porTermo.get(chave);
    if (!atual) {
      porTermo.set(chave, { ...e, aliases: [...new Set(e.aliases)] });
      continue;
    }
    atual.aliases = [...new Set([...atual.aliases, ...e.aliases])].slice(0, MAX_ALIASES + 2);
    if (atual.kind === 'expressao' && e.kind !== 'expressao') atual.kind = e.kind;
    atual.label ??= e.label;
  }
  return [...porTermo.values()].filter((e) => e.aliases.length > 0);
}

/** Glossário de um documento a partir do texto dos seus trechos. */
export function extractGlossary(texto: string): GlossaryEntry[] {
  return mergeGlossary([...definicoesNumeradas(texto), ...siglas(texto), ...expressoes(texto)]);
}
