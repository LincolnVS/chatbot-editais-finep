/** Rótulos de citação portáteis: `[c_xxxxxx]` (chunks, modo rag) e `[sec-…]` (âncoras de seção, baseline full_context). */
export const LABEL_RE = /\[(c_[0-9a-f]{6})\]/g;
export const SECTION_RE = /\[(sec-[^\]\s]+)\]/g;

const TOKEN = 'c_[0-9a-f]{6}|sec-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?';
// Delimitadores que os modelos usam no lugar de "[ ]": parênteses, chaves, colchetes CJK/fullwidth, aspas angulares.
const OPEN = '[\\[({<【〔［⟦〖「«]';
const CLOSE = '[\\])}>】〕］⟧〗」»]';
const EMPH = '(?:\\*{1,2}|_{1,2}|`)';

/** Grupo delimitado que começa com um rótulo: "[ c_1 ]", "(c_1, c_2)", "[[c_1]]", "【c_1】", "[sec-15 p=1 (original)]". */
const GROUP_RE = new RegExp(
  `((?:${OPEN}\\s*)+)(?:${EMPH}\\s*)?((?:${TOKEN})(?:\\s*(?:[,;/]|e|and)?\\s*(?:${TOKEN}))*)(?:[^\\n${CLOSE.slice(1, -1)}(]|\\([^()\\n]*\\))*?(?:\\s*${EMPH})?((?:\\s*${CLOSE})+)`,
  'g',
);
const TOKEN_RE = new RegExp(TOKEN, 'g');
/** Rótulo solto no texto ("… prazo c_ab12cd." ou "**c_ab12cd**"), sem delimitador. */
const BARE_RE = new RegExp(`(?<![\\[\\w-])${EMPH}?(${TOKEN})${EMPH}?(?![\\]\\w-])`, 'g');
/** Ênfase colada num grupo já canônico: "**[c_1] [c_2]**". */
const EMPH_GROUP_RE = new RegExp(`${EMPH}((?:\\[(?:${TOKEN})\\]\\s?)+)${EMPH}`, 'g');
/** Rótulo colado na palavra anterior ("2026[c_1]", "[c_1][c_2]") ganha um espaço. */
const GLUED_RE = new RegExp(`(?<=[^\\s(\\[])(\\[(?:${TOKEN})\\])`, 'g');

/** Canoniza qualquer variação de rótulo escrita pelo modelo para a forma "[c_1] [c_2]" (uma por rótulo). */
export function normalizeLabels(text: string): string {
  const grouped = text.replace(GROUP_RE, (_whole, openers: string, group: string, closers: string) => {
    // Fechamentos além das aberturas pertencem ao texto ao redor: "(ver [c_1])" mantém o ")".
    const closing = closers.replace(/\s/g, '');
    const extra = closing.length - openers.replace(/\s/g, '').length;
    return canonical(group) + (extra > 0 ? closing.slice(-extra) : '');
  });
  const bare = grouped.replace(BARE_RE, (_whole, label: string) => `[${label}]`);
  return bare.replace(EMPH_GROUP_RE, (_whole, group: string) => group.trimEnd()).replace(GLUED_RE, ' $1');
}

function canonical(group: string): string {
  return (group.match(TOKEN_RE) ?? []).map((l) => `[${l}]`).join(' ');
}
