/**
 * Texto da resposta do modelo: blocos (parágrafo, lista, tabela), o que é factual, valores verificáveis (datas, R$, %,
 * números) e sua forma canônica. Isomórfico: o gate (API) e a tela de resultados (web) usam as mesmas regras.
 */

export const ABSTENTION_RE = /n[ãa]o consta nos documentos/i;

export type AnswerBlock = {
  text: string;
  kind: 'heading' | 'list' | 'table' | 'paragraph' | 'rule';
  labels: string[];
  factual: boolean;
  /** Linha só de citações ("[c_x] [c_y]"): os blocos a que ela dá referência. */
  citationLineFor?: AnswerBlock[];
};

/** Qualquer rótulo de citação escrito na resposta (chunk ou seção). */
export const ANY_LABEL_RE = /\[(c_[0-9a-f]{6}|sec-[^\]\s]+)\]/g;

/** Divide a resposta em blocos: cabeçalho, item de lista, tabela inteira (linhas contíguas), parágrafo (linhas contíguas) e regras. */
export function splitBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let table: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push(makeBlock(paragraph.join('\n'), 'paragraph'));
    if (table.length > 0) blocks.push(makeBlock(table.join('\n'), 'table'));
    paragraph = [];
    table = [];
  };
  // a linha anterior foi um item de lista, sem linha em branco no meio
  let listOpen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      listOpen = false;
      continue;
    }
    if (trimmed.startsWith('|')) {
      if (paragraph.length > 0) flush();
      listOpen = false;
      table.push(line);
    } else if (/^#{1,6}\s/.test(trimmed)) {
      flush();
      listOpen = false;
      blocks.push(makeBlock(line, 'heading'));
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      listOpen = false;
      blocks.push(makeBlock(line, 'rule'));
    } else if (/^([-*+]|\d+[.)])\s/.test(trimmed) || /^>\s?/.test(trimmed)) {
      flush();
      blocks.push(makeBlock(line, 'list'));
      listOpen = true;
    } else if (listOpen && /^\s/.test(line)) {
      // linha recuada logo abaixo de um item de lista é continuação do mesmo item (Markdown), com a citação que trouxer
      const item = blocks.pop()!;
      blocks.push(makeBlock(`${item.text}\n${line}`, 'list'));
    } else {
      // a tabela fecha antes da linha que vem colada nela, para a linha de citação ficar depois da tabela
      if (table.length > 0) flush();
      listOpen = false;
      paragraph.push(line);
    }
  }
  flush();
  attachLeadIns(blocks);
  return attachCitationLines(blocks);
}

/**
 * Frase citada que abre uma tabela ou lista ("Os critérios e seus pesos são [c_1]:") referencia o bloco que vem logo em
 * seguida — o espelho da linha de citação depois da tabela. Sem isso o gate estrito tirava a tabela inteira por falta de
 * citação, embora o modelo tivesse dito de onde ela veio. Não é passe livre: os valores da tabela continuam conferidos
 * contra essa fonte. Bloco que já cita a própria fonte fica com ela. O mesmo vale para um item de lista citado que abre
 * uma sub-lista ("2. Grau de Inovação — pesos [c_1]:" seguido de itens recuados): só os itens recuados herdam.
 */
function attachLeadIns(blocks: AnswerBlock[]): void {
  for (let i = 0; i < blocks.length - 1; i++) {
    const lead = blocks[i]!;
    if (lead.labels.length === 0 || !/:[\s*_]*$/.test(stripLabels(lead.text).trimEnd())) continue;
    if (lead.kind === 'list') inheritNested(blocks, i);
    else if (lead.kind === 'paragraph') inheritFollowing(blocks, i);
  }
}

const indentOf = (b: AnswerBlock): number => b.text.length - b.text.trimStart().length;
const inherit = (target: AnswerBlock, lead: AnswerBlock): void => {
  if (target.labels.length === 0) target.labels = [...lead.labels];
};

/** Itens recuados logo abaixo do item de lista `i`. */
function inheritNested(blocks: AnswerBlock[], i: number): void {
  const lead = blocks[i]!;
  for (let j = i + 1; j < blocks.length && blocks[j]!.kind === 'list' && indentOf(blocks[j]!) > indentOf(lead); j++) inherit(blocks[j]!, lead);
}

/** Tabela ou lista logo depois do parágrafo `i`. */
function inheritFollowing(blocks: AnswerBlock[], i: number): void {
  const lead = blocks[i]!;
  const kind = blocks[i + 1]!.kind;
  if (kind === 'table') inherit(blocks[i + 1]!, lead);
  else if (kind === 'list') for (let j = i + 1; j < blocks.length && blocks[j]!.kind === 'list'; j++) inherit(blocks[j]!, lead);
}

/** O que sobra numa linha de citação sem ser afirmação: só a referência ao item entre parênteses ("[c_1] (item 9.5)"). */
const ITEM_REF_ONLY_RE = /^(\(\s*(ite(m|ns)|subite(m|ns)|se[çc](ão|ões|ao|oes)|anexos?)\b[^()]*\)[\s.,;]*)*$/i;

/**
 * Uma linha só com citações (e, no máximo, a referência ao item entre parênteses) depois de uma tabela, parágrafo ou lista referencia o bloco anterior (a lista inteira,
 * quando é lista): o modelo costuma citar a tabela numa linha à parte, e sem isso a tabela contava como sem citação.
 */
export function attachCitationLines(blocks: AnswerBlock[]): AnswerBlock[] {
  for (let i = 1; i < blocks.length; i++) {
    const line = blocks[i]!;
    if (line.kind !== 'paragraph' || line.labels.length === 0 || !ITEM_REF_ONLY_RE.test(stripLabels(line.text).trim())) continue;
    const prev = blocks[i - 1]!;
    if (prev.kind === 'heading' || prev.kind === 'rule') continue;
    const targets: AnswerBlock[] = [];
    for (let j = i - 1; j >= 0 && blocks[j]!.kind === prev.kind; j--) {
      targets.push(blocks[j]!);
      if (prev.kind !== 'list') break;
    }
    for (const t of targets) t.labels = [...new Set([...t.labels, ...line.labels])];
    line.citationLineFor = targets;
    line.factual = false;
  }
  return blocks;
}

function makeBlock(text: string, kind: AnswerBlock['kind']): AnswerBlock {
  const labels = [...text.matchAll(ANY_LABEL_RE)].map((m) => m[1] as string);
  return { text, kind, labels, factual: isFactual(text, kind) };
}

/** Um bloco é factual quando afirma algo verificável: tem valores/datas ou conteúdo suficiente e não é pergunta, abstenção ou conectivo. */
export function isFactual(text: string, kind: AnswerBlock['kind']): boolean {
  if (kind === 'heading' || kind === 'rule') return false;
  const plain = stripLabels(text).replace(/^([-*+]|\d+[.)]|>)\s*/, '').trim();
  if (!plain) return false;
  if (ABSTENTION_RE.test(plain)) return false;
  const hasValues = extractValues(plain).length > 0;
  if (/\?\s*$/.test(plain) && !hasValues) return false;
  if (hasValues) return true;
  const content = tokenize(plain).length;
  // rótulo curto que abre o que vem depois ("Detalhes:", "**Requisitos gerais:**"): a ênfase depois dos dois-pontos não conta
  if (/:[\s*_]*$/.test(plain) && content <= 6) return false;
  return content >= 4;
}

export function stripLabels(text: string): string {
  return text.replace(ANY_LABEL_RE, ' ');
}

/** minúsculas + sem diacríticos (comparação tolerante a "não"/"nao"). */
function foldWord(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/* ---------- tokens ---------- */

/** Palavras (≥ 4 letras, sem stopwords) e números/identificadores (≥ 2 chars, ex.: "30", "6.5.5", "07/04/2026"). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /\p{L}+|\p{N}+(?:[./,-]\p{N}+)*/gu;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    if (/\p{N}/u.test(raw)) {
      if (raw.length >= 2) out.push(raw);
      continue;
    }
    const word = foldWord(raw);
    if (word.length >= 4 && !STOPWORDS.has(word)) out.push(word);
  }
  return out;
}

const STOPWORDS = new Set(
  `para pela pelo pelas pelos como mais menos esta este esse essa isso isto aquele aquela aquilo entre sobre quando onde
   tambem ainda sendo seja sejam sera serao deve devem devera deverao pode podem podera poderao forma caso cada todo toda
   todos todas mesmo mesma apenas assim entao pois porque porem contudo desde apos antes durante atraves conforme mediante
   junto dentro fora sido foram estao esteja estejam tera terao haver houver havia seus suas nesse nessa neste nesta
   naquele nele nela deles delas dele dela qual quais quem muito muita muitos muitas pouco poucos outro outra outros outras
   item itens alem cujo cuja cujos cujas qualquer quaisquer respectivo respectiva respectivos respectivas referente
   referentes relativo relativa relativos relativas`
    .split(/\s+/)
    .filter(Boolean),
);

/* ---------- valores ---------- */

const MONTHS: Record<string, string> = {
  janeiro: '01', fevereiro: '02', marco: '03', abril: '04', maio: '05', junho: '06',
  julho: '07', agosto: '08', setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
};

// A alternância dos multiplicadores vai da forma longa para a curta: com "mil" primeiro, "R$ 5 milhões" casava como "R$ 5 mil".
export const VALUE_RE = new RegExp(
  [
    String.raw`R\$\s?\d[\d.]*(?:,\d+)?(?:\s?(?:milh[õo]es|milh[ãa]o|bilh[õo]es|bilh[ãa]o|mil))?`,
    String.raw`\d{1,2}\s+de\s+(?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+\d{4}`,
    String.raw`\d{1,2}\/\d{1,2}\/\d{2,4}`,
    String.raw`\d{1,2}[h:]\d{2}(?!\d)|\d{1,2}h(?![\p{L}\d])`,
    String.raw`\d+(?:[.,]\d+)?\s?%`,
    String.raw`\d+(?:\.\d+)+(?!\d)`,
    String.raw`\d[\d.]*(?:,\d+)?\s?(?:mil|milh[õo]es|milh[ãa]o|bilh[õo]es|bilh[ãa]o)\b`,
    String.raw`\d{2,}(?:,\d+)?`,
    String.raw`\d(?=\s?\(?[\p{L}\s]*\)?\s?(?:mes|meses|ano|anos|dia|dias|hora|horas|via|vias|parcela|parcelas|semana|semanas|etapa|etapas)\b)`,
  ].join('|'),
  'giu',
);

/** Valores "verificáveis" de um texto (datas, dinheiro, percentuais, horários, itens numerados, números), já normalizados. */
export function extractValues(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(ANY_LABEL_RE, ' ').matchAll(VALUE_RE)) {
    const value = normalizeValue(m[0]);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Forma canônica de um valor: datas dd/mm/aaaa, dinheiro "R$<inteiro>[,cc]", horários hh:mm, números sem separador de milhar. */
export function normalizeValue(raw: string): string | null {
  const fold = raw.trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return normalizeDateOrTime(fold) ?? normalizePercent(fold) ?? normalizeAmount(fold);
}

function normalizeDateOrTime(fold: string): string | null {
  const textual = /^(\d{1,2}) de ([a-z]+) de (\d{4})$/.exec(fold);
  if (textual) {
    const month = MONTHS[textual[2] as string];
    return month ? `${pad(textual[1] as string)}/${month}/${textual[3]}` : null;
  }
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(fold);
  if (numeric) {
    const year = (numeric[3] as string).length === 2 ? `20${numeric[3]}` : (numeric[3] as string);
    return `${pad(numeric[1] as string)}/${pad(numeric[2] as string)}/${year}`;
  }
  const time = /^(\d{1,2})[h:](\d{2})$/.exec(fold);
  if (time) return `${pad(time[1] as string)}:${time[2]}`;
  const hour = /^(\d{1,2})h$/.exec(fold);
  return hour ? `${pad(hour[1] as string)}:00` : null;
}

function normalizePercent(fold: string): string | null {
  const m = /^(\d+(?:[.,]\d+)?) ?%$/.exec(fold);
  // 20%, 20,0% e 20,00% são o mesmo valor.
  return m ? `${Number((m[1] as string).replace(',', '.'))}%` : null;
}

/** Dinheiro (com ou sem R$), multiplicadores "mil/milhões", números com milhar/decimal, itens numerados e inteiros. */
function normalizeAmount(fold: string): string | null {
  const money = fold.startsWith('r$');
  const prefix = money ? 'R$' : '';
  const body = fold.replace(/^r\$\s?/, '');
  const scaled = /^(\d[\d.]*(?:,\d+)?) ?(mil|milhoes|milhao|bilhoes|bilhao)$/.exec(body);
  if (scaled) {
    const unit = scaled[2] as string;
    const factor = unit === 'mil' ? 1e3 : unit.startsWith('milh') ? 1e6 : 1e9;
    const amount = Number((scaled[1] as string).replace(/\./g, '').replace(',', '.')) * factor;
    return Number.isFinite(amount) ? `${prefix}${Math.round(amount)}` : null;
  }
  if (money || /^\d[\d.]*,\d+$/.test(body) || /^\d{1,3}(\.\d{3})+$/.test(body)) {
    const [int = '', cents] = body.split(',');
    const suffix = cents && !/^0+$/.test(cents) ? `,${cents}` : '';
    return `${prefix}${int.replace(/\./g, '')}${suffix}`;
  }
  if (/^\d+(\.\d+)+$/.test(body) || /^\d+$/.test(body)) return body;
  return null;
}

function pad(n: string): string {
  return n.padStart(2, '0');
}

/* ---------- valores esperados (padrão-ouro) ---------- */

/**
 * Minúsculas, sem acentos, hífens tipográficos (‑ – —) como "-", espaços colapsados; o número por extenso entre
 * parênteses que os editais põem após o algarismo cai fora ("12 (doze) meses" ≡ "12 meses"), dos dois lados da comparação.
 */
function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[‐-―−]/g, '-').replace(/(\d)\s*\([a-z\s]{2,40}\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/**
 * O valor esperado aparece no texto: pela forma canônica (datas, R$, %, números) ou por substring sem acentos.
 * Valor textual não distingue singular de plural ("empresas brasileiras" casa "empresa brasileira" e vice-versa):
 * cada palavra pode ganhar ou perder o "s"/"es" final; "-ão" ≡ "-ões"; "-al/-el/-ol" ≡ "-ais/-eis/-ois"; "-il" ≡ "-is".
 */
function pluralInsensitive(w: string): string {
  if (!/^[a-z]{3,}$/.test(w)) return w;
  const oes = /^(.+)(ao|oes)$/.exec(w);
  if (oes) return `${oes[1]}(?:ao|oes)`;
  const al = /^(.+[aeo])(l|is)$/.exec(w);
  if (al) return `${al[1]}(?:l|is)`;
  const il = /^(.+i)([ls])$/.exec(w);
  if (il) return `${il[1]}(?:l|s)?`;
  const stem = w.replace(/(e?s)$/, '');
  return stem.length >= 3 ? `${stem}(?:es?|s)?` : w;
}

export function containsValue(text: string, expected: string): boolean {
  // Número solto: só casa como número inteiro ("3" não casa em "300.000" nem "20" em "1,20").
  if (/^\d+$/.test(expected)) return new RegExp(String.raw`(?<!\d|\d[.,])${expected}(?!\d|[.,]\d)`).test(text);
  const canonical = normalizeValue(expected);
  if (canonical) {
    const found = new Set(extractValues(text));
    if (found.has(canonical) || found.has(canonical.replace(/^R\$/, ''))) return true;
  }
  // Fronteira à esquerda: sem ela "5,0%" casaria dentro de "15,0%" e "R$ 5 mil" dentro de "R$ 15 mil".
  const alvo = fold(expected)
    .split(' ')
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`))
    .map(pluralInsensitive)
    .join(' ');
  return new RegExp(String.raw`(?<![\d.,])` + alvo).test(fold(text));
}

